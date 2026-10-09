/**
 * Журнал платных обращений ENG к провайдерам (P-A-provider-usage-journal).
 *
 * ЧТО ПИШЕТСЯ. Одна строка `application_logs` на каждое HTTP-обращение к
 * Requesty (llm.ts, rawCall — включая транспортные повторы одной попытки
 * схемы) и на каждый поиск Serper (lib/search/serperClient.ts через ОБЩИЙ
 * крючок lib/providerUsage.ts — сам клиент Serper этой правкой не тронут):
 * source 'he_provider_usage', event 'provider_call', request_id = id проекта,
 * теги — в context (поля и их смысл — HeProviderCallContext ниже). Тексты
 * запросов, ответов, компаний и ключи в строку не попадают.
 *
 * Отдельный источник — правило D2-state-wave-telemetry-separate-source:
 * замеры живут в application_logs, а не в he_bases.collect_info и не в других
 * горячих строках (деталку поллят раз в 4 с). Ярлык исхода (outcome) не
 * смешивается с механизмом: он говорит, что ответил провайдер, а не почему
 * стадия решила дальше.
 *
 * ГДЕ ВКЛЮЧЁН. Только у проектов market='us', в двух местах
 * (openHeProviderJournal → withHeProviderJournal):
 *  - воркер: worker/hypothesisEngine.ts открывает журнал вокруг runHeStage;
 *  - оба роута запуска шаблона — клиентский
 *    (api/client/eng/templates/[id]/launch) и staff
 *    (api/tools/hypothesis-engine/templates/[id]/launch): журнал открыт вокруг
 *    ядра запуска стадией HE_COST_LAUNCH_STAGE ('launch', costReport.ts), так
 *    что классификатор сегментов (launchTemplate.ts, шаг 5c) в нём виден.
 * Для проекта 'ru' openHeProviderJournal возвращает null, контекста нет, и оба
 * крючка — no-op: ни строки, ни лишнего запроса от журнала, поведение
 * RU-инструмента прежнее. Ночной добор ENG (worker/heAutoPipelineCron.ts) сам
 * ничего не оплачивает — он ставит джобы base_collect, и их исполняет тот же
 * handleJob под журналом.
 *
 * ЧЕГО ЖУРНАЛ НЕ ВИДИТ (контекста нет — строк нет):
 *  - вызовов модели из API-роутов без журнала: структуризация кейса
 *    (staff-роут cases, caseBank.structureCaseText) и классификатор сегментов
 *    staff-запуска, у которого роут не прочитал рынок проекта (журнал тогда не
 *    открыт; расход классификатора пишет аудит запуска, context
 *    classifierCostUsd);
 *  - конструктора баз (отдельный воркер: краул, SMTP-пробы; в
 *    base_constructor_jobs.result_stats только тайминги шагов и токены оценки
 *    ЦА, долларов там нет);
 *  - вызова, который был в полёте, когда процесс умер (ни строки, ни расхода в
 *    he_jobs — та же слепая зона, что у he_jobs.cost_usd).
 * Отчёт (costReport.ts) перечисляет это в `excludes`.
 *
 * BEST-EFFORT, НЕ FAIL-CLOSED. Журнал не имеет права уронить или повторить
 * платную стадию и не задерживает ни одного платного вызова:
 *  - noteHeProviderCall синхронен и никогда не бросает: строка ставится в
 *    запись и пишется в фоне, платный вызов её не ждёт;
 *  - единственное ожидание — settle в воркере ПОСЛЕ стадии (сторож уже снят):
 *    обычно 0 мс (строки легли по ходу стадии), при лежащей БД — не дольше
 *    SETTLE_LIMIT_MS;
 *  - запись: до WRITE_ATTEMPTS попыток по WRITE_ATTEMPT_TIMEOUT_MS, upsert по
 *    своему id (повтор после таймаута, который на деле лёг, дубля не даёт);
 *  - не легла и после повторов — строка в лог воркера и МАРКЕР ПРОБЕЛА:
 *    (а) в he_jobs.result этой джобы, если прогон кончится done-записью
 *    (markHeJournalGap — едет на существующей done-записи, новой записи в
 *    горячую строку нет); (б) в поле lost_before следующей легшей строки
 *    этого же проекта из этого же процесса (так видны пробелы прогонов, не
 *    дошедших до done: отказ, отмена, ожидание base_collect). Отчёт с любым
 *    маркером говорит «incomplete», а не называет ложный итог.
 * Крючок Serper (withProviderUsage) устроен fail-closed: отказ писателя он
 * превращает в ProviderUsageWriteError стадии. Наш писатель не бросает
 * никогда, поэтому эта ветка у ENG недостижима.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { withProviderUsage, type ProviderUsageEvent } from '@/lib/providerUsage';
import { aggregateHeCalls, heLostRowsByJob, heUnpricedCalls, parseHeCostCall, type HeCostCall } from './costReport';
import type { HeMarket } from './market';
import type { HeJob } from './types';

export const HE_USAGE_SOURCE = 'he_provider_usage';
export const HE_USAGE_EVENT = 'provider_call';
/** Версия формы context. Отчёт строки другой версии не считает, а называет. */
export const HE_USAGE_VERSION = 1;

/** Попыток записать ОДНУ строку. */
const WRITE_ATTEMPTS = 3;
/** Срок одной попытки записи (сигнал на запрос). */
const WRITE_ATTEMPT_TIMEOUT_MS = 10_000;
/** Пауза перед повтором: 250 мс, затем 500 мс. */
const WRITE_RETRY_BASE_MS = 250;
/**
 * Сколько воркер ждёт незаписанные строки в конце прогона (settle). Одна
 * строка укладывается в 3 × (10 с срока + до 1,5 с паузы повтора админского
 * fetch внутри срока) + 0,75 с пауз = ~35 с; сверху запас. Не дождались —
 * такие строки считаются потерянными (консервативно: если лягут позже, отчёт
 * всё равно скажет «incomplete», а не занизит итог молча).
 */
const SETTLE_LIMIT_MS = 40_000;
/** Сколько разных джоб держит перенос пробела на проект (остальное — '_other'). */
const CARRIED_JOBS_MAX = 100;

/**
 * Исход обращения — что ответил провайдер:
 *  - ok — ответ принят (Requesty: конверт чата; Serper: выдача, возможно пустая);
 *  - failed — провайдер отказал кодом ошибки или телом-ошибкой (HTTP ≥ 400,
 *    Serper: 200 с ошибкой в теле): запрос не обслужен;
 *  - aborted — пригодного ответа нет: отмена, свой срок, обрыв связи, тело не
 *    дочиталось или не похоже на ответ. Исполнил ли провайдер запрос и
 *    выставил ли счёт — НЕ известно.
 */
export type HeProviderCallOutcome = 'ok' | 'failed' | 'aborted';

/** Обращение к модели (llm.ts, rawCall). */
export interface HeRequestyCall {
  provider: 'requesty';
  /** Запрошенная модель (по ней же считает he_jobs.cost_usd). */
  model: string;
  outcome: HeProviderCallOutcome;
  httpStatus?: number;
  /** Токены ответа; нет блока usage в ответе — поля нет (не нули). */
  usage?: { tokensIn: number; tokensOut: number; tokensTotal: number };
  /** Цена вызова; null — неизвестна (никогда не 0 вместо «не знаем»). */
  costUsd: number | null;
  /** Откуда цена: счёт роутера (usage.cost) или ставка таблицы llm.ts с наценкой. */
  costSource: 'router' | 'table' | null;
}

/** Поиск Serper (serperClient через providerUsage). */
export interface HeSerperCall {
  provider: 'serper';
  endpoint: 'search';
  outcome: HeProviderCallOutcome;
  httpStatus?: number;
  /** Кредиты, которые вернул провайдер; не вернул — поля нет. */
  credits?: number;
}

export type HeProviderCall = HeRequestyCall | HeSerperCall;

/**
 * Форма context строки журнала (версия 1). У КАЖДОГО поля есть читатель в
 * costReport.ts (parseHeCostCall → buildHeCostReport / aggregateHeCalls).
 */
export interface HeProviderCallContext {
  v: typeof HE_USAGE_VERSION;
  project_id: string;
  job_id: string;
  stage: string;
  /** База джобы (payload.base_id: base_collect, base_analyze, template). */
  base_id?: string;
  /** Всегда 'us': журнал открывается только для этого рынка. */
  market: 'us';
  provider: 'requesty' | 'serper';
  /** Requesty: запрошенная модель. */
  model?: string;
  /** Serper: точка API. */
  endpoint?: 'search';
  outcome: HeProviderCallOutcome;
  /** Код ответа неуспешного обращения (failed; aborted — если заголовки успели прийти). */
  http_status?: number;
  tokens_in?: number;
  tokens_out?: number;
  /** Число, которое прибавляет he_jobs.tokens_used (usage.total_tokens ?? in + out). */
  tokens_total?: number;
  credits?: number;
  /**
   * Цена; null — неизвестна. У Serper всегда null: тарифа кредита в коде нет,
   * отчёт переводит кредиты в доллары по тарифу, переданному при чтении.
   */
  cost_usd: number | null;
  price_known: boolean;
  cost_source?: 'router' | 'table';
  /** Строки, потерянные этим процессом ДО этой (id джобы → число), — маркер пробела. */
  lost_before?: Record<string, number>;
}

interface HeJournalScope {
  projectId: string;
  jobId: string;
  stage: string;
  baseId?: string;
}

interface HeJournalState {
  db: SupabaseClient;
  scope: HeJournalScope;
  pending: Set<Promise<void>>;
  /** Строк ЭТОГО прогона, которые не легли (они же уходят в перенос carriedLosses). */
  lost: number;
  warn: (msg: string) => void;
}

export interface HeProviderJournal {
  /** Выполнить работу стадии внутри журнала (оба крючка видят контекст). */
  run<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Дождаться фоновых записей этого прогона (не дольше SETTLE_LIMIT_MS) и
   * вернуть, сколько строк потеряно. Никогда не бросает.
   */
  settle(): Promise<number>;
}

const storage = new AsyncLocalStorage<HeJournalState>();

/**
 * Пробелы, которые ещё не попали ни в одну легшую строку: проект → джоба →
 * число строк. Память процесса: рестарт её теряет (тогда остаются маркер в
 * he_jobs.result и сверка с he_jobs.tokens_used в отчёте).
 */
const carriedLosses = new Map<string, Map<string, number>>();

const identifier = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[\w-]{1,100}$/.test(value) ? value : undefined;

/**
 * Открыть журнал для джобы. null — журнала у этой джобы нет (рынок не 'us'):
 * воркер тогда зовёт стадию как раньше, без контекста и без ожиданий.
 */
export function openHeProviderJournal(
  db: SupabaseClient,
  market: HeMarket,
  job: Pick<HeJob, 'id' | 'project_id' | 'stage' | 'payload'>,
  warn: (msg: string) => void,
): HeProviderJournal | null {
  if (market !== 'us') return null;
  const baseId = identifier(job.payload?.base_id);
  const state: HeJournalState = {
    db,
    scope: { projectId: job.project_id, jobId: job.id, stage: job.stage, ...(baseId ? { baseId } : {}) },
    pending: new Set(),
    lost: 0,
    warn,
  };
  return {
    run: (work) =>
      storage.run(state, () =>
        withProviderUsage(
          { ...state.scope },
          // Писатель крючка Serper: 'started' не пишем (строка одна на поиск —
          // по его завершении), 'finished' только ставится в запись. Не
          // бросает никогда — иначе withProviderUsage уронил бы стадию.
          async (_scope, event) => {
            try {
              if (event.phase === 'finished' && event.provider === 'serper') enqueue(state, serperCall(event));
            } catch {
              // enqueue сам не бросает; страховка от формы события — молча.
            }
          },
          work,
        ),
      ),
    settle: () => settle(state),
  };
}

/** Стадия внутри журнала, а без журнала — тот же вызов без единой обёртки. */
export function withHeProviderJournal<T>(journal: HeProviderJournal | null, work: () => Promise<T>): Promise<T> {
  return journal ? journal.run(work) : work();
}

/** Открыт ли журнал в текущем контексте (llm.ts: без него ничего не считает). */
export function heProviderJournalActive(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * Записать обращение к провайдеру в журнал текущего контекста. Нет контекста —
 * ничего. Синхронно, никогда не бросает: платный вызов строку не ждёт.
 */
export function noteHeProviderCall(call: HeProviderCall): void {
  const state = storage.getStore();
  if (state) enqueue(state, call);
}

/**
 * Маркер пробела в результат done-записи. Нет потерь или результат не объект —
 * результат как есть (тогда пробел видят перенос и сверка в отчёте).
 */
export function markHeJournalGap(result: unknown, lost: number): unknown {
  if (!(lost > 0) || !result || typeof result !== 'object' || Array.isArray(result)) return result;
  return { ...(result as Record<string, unknown>), journal_gap: { lost } };
}

function serperCall(event: ProviderUsageEvent): HeSerperCall {
  return {
    provider: 'serper',
    endpoint: 'search',
    outcome: event.status === 'success' ? 'ok' : event.status === 'http_error' ? 'failed' : 'aborted',
    ...(event.httpStatus !== undefined ? { httpStatus: event.httpStatus } : {}),
    ...(event.serperCredits !== undefined ? { credits: event.serperCredits } : {}),
  };
}

const finiteNonNegative = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

function contextFor(scope: HeJournalScope, call: HeProviderCall, lostBefore?: Record<string, number>): HeProviderCallContext {
  const context: HeProviderCallContext = {
    v: HE_USAGE_VERSION,
    project_id: scope.projectId,
    job_id: scope.jobId,
    stage: scope.stage,
    ...(scope.baseId ? { base_id: scope.baseId } : {}),
    market: 'us',
    provider: call.provider,
    outcome: call.outcome,
    // Код ответа — только у неуспешного обращения: у ok он всегда 2xx и ничего
    // не говорит, а поле без читателя не пишем.
    ...(call.outcome !== 'ok' && finiteNonNegative(call.httpStatus) ? { http_status: call.httpStatus } : {}),
    cost_usd: null,
    price_known: false,
  };
  if (call.provider === 'requesty') {
    context.model = call.model.slice(0, 200);
    if (call.usage) {
      context.tokens_in = call.usage.tokensIn;
      context.tokens_out = call.usage.tokensOut;
      context.tokens_total = call.usage.tokensTotal;
    }
    if (finiteNonNegative(call.costUsd) && call.costSource) {
      context.cost_usd = call.costUsd;
      context.price_known = true;
      context.cost_source = call.costSource;
    }
  } else {
    context.endpoint = call.endpoint;
    if (finiteNonNegative(call.credits)) context.credits = call.credits;
  }
  if (lostBefore) context.lost_before = lostBefore;
  return context;
}

function takeCarried(projectId: string): Record<string, number> | undefined {
  const jobs = carriedLosses.get(projectId);
  if (!jobs?.size) return undefined;
  carriedLosses.delete(projectId);
  return Object.fromEntries(jobs);
}

function carry(projectId: string, jobId: string, rows: number): void {
  if (!(rows > 0)) return;
  let jobs = carriedLosses.get(projectId);
  if (!jobs) carriedLosses.set(projectId, (jobs = new Map()));
  const key = jobs.has(jobId) || jobs.size < CARRIED_JOBS_MAX ? jobId : '_other';
  jobs.set(key, (jobs.get(key) ?? 0) + rows);
}

function enqueue(state: HeJournalState, call: HeProviderCall): void {
  let carried: Record<string, number> | undefined;
  try {
    carried = takeCarried(state.scope.projectId);
    const row = {
      id: randomUUID(),
      // Время ОБРАЩЕНИЯ, а не записи: повтор после блипа не сдвигает строку в
      // другие сутки отчёта.
      created_at: new Date().toISOString(),
      level: 'info',
      source: HE_USAGE_SOURCE,
      event: HE_USAGE_EVENT,
      message: 'ENG provider call',
      request_id: state.scope.projectId,
      context: contextFor(state.scope, call, carried),
    };
    // Промис записи не отклоняется никогда (persist ловит всё сам, второй
    // обработчик — страховка): иначе необработанный отказ уронил бы процесс.
    const write = persist(state.db, row).then(
      (failureCode) => {
        if (failureCode !== null) lose(state, carried, failureCode);
      },
      () => lose(state, carried, 'unknown'),
    );
    state.pending.add(write);
    void write.then(() => state.pending.delete(write));
  } catch {
    // Сбой ДО записи (строку не собрать) — тот же пробел, без исключения наружу.
    lose(state, carried, 'build');
  }
}

/** Строка не легла: счётчик прогона, перенос на следующую строку проекта, лог. */
function lose(state: HeJournalState, carried: Record<string, number> | undefined, code: string): void {
  try {
    state.lost += 1;
    for (const [jobId, rows] of Object.entries(carried ?? {})) carry(state.scope.projectId, jobId, rows);
    carry(state.scope.projectId, state.scope.jobId, 1);
    state.warn(
      `[he-cost] строка журнала расхода не записана (code=${code}, попыток ${WRITE_ATTEMPTS}) — ` +
        `пробел отмечен, стадия не затронута`,
    );
  } catch {
    // Лог воркера недоступен — пробел всё равно посчитан выше.
  }
}

/**
 * Записать строку: до WRITE_ATTEMPTS попыток, у каждой свой срок. Повтор — той
 * же строки с тем же id (upsert без перезаписи): таймаут мог прийти после
 * коммита. Платный вызов не повторяется никогда — его здесь нет.
 * Возвращает null (легла) или безопасный код отказа: сырой текст ошибки БД в
 * лог не идёт — в нём бывают URL и данные строки.
 */
async function persist(db: SupabaseClient, row: Record<string, unknown>): Promise<string | null> {
  let failureCode = 'unknown';
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt++) {
    try {
      const { error } = await db
        .from('application_logs')
        .upsert(row, { onConflict: 'id', ignoreDuplicates: true })
        .abortSignal(AbortSignal.timeout(WRITE_ATTEMPT_TIMEOUT_MS));
      if (!error) return null;
      failureCode = safeCode(error);
    } catch (error) {
      failureCode = safeCode(error);
    }
    if (attempt < WRITE_ATTEMPTS - 1) {
      await new Promise((resolve) => setTimeout(resolve, WRITE_RETRY_BASE_MS * 2 ** attempt));
    }
  }
  return failureCode;
}

function safeCode(error: unknown): string {
  const failure = error as { code?: unknown; name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  const code = failure?.cause?.code ?? failure?.code;
  if (typeof code === 'string' && /^[A-Z0-9_]{1,64}$/i.test(code)) return code;
  return /abort|timeout/i.test(`${String(failure?.name ?? '')} ${String(failure?.message ?? '')}`) ? 'DEADLINE' : 'unknown';
}

async function settle(state: HeJournalState): Promise<number> {
  try {
    if (state.pending.size) {
      let timer: NodeJS.Timeout | undefined;
      const late = new Promise<'late'>((resolve) => {
        timer = setTimeout(() => resolve('late'), SETTLE_LIMIT_MS);
        timer.unref?.();
      });
      const outcome = await Promise.race([
        Promise.allSettled([...state.pending]).then(() => 'settled' as const),
        late,
      ]);
      clearTimeout(timer);
      if (outcome === 'late') return state.lost + state.pending.size;
    }
    return state.lost;
  } catch {
    return state.lost;
  }
}

/* ─────────────────────── Чтение журнала ─────────────────────── */

/** Строка журнала, как её читает отчёт (без level/message/request_id — они постоянны). */
export interface HeProviderJournalRow {
  id: string;
  created_at: string;
  context: unknown;
}

export interface HeProviderJournalFilter {
  /** Один проект (request_id). Нет — все проекты рынка 'us'. */
  projectId?: string;
  /** Нижняя граница created_at включительно (ISO). */
  fromIso?: string;
  /**
   * Верхняя граница created_at ИСКЛЮЧИТЕЛЬНО (ISO). Нет — момент начала чтения:
   * строки, которые живой прогон пишет во время чтения, не сдвигают страницы.
   */
  toIso?: string;
}

const JOURNAL_PAGE = 1000;
/** Потолок чтения: 20 000 строк. Больше — отчёт помечается неполным, а не режется молча. */
const JOURNAL_MAX_PAGES = 20;

/**
 * Прочитать строки журнала по фильтру, страницами по created_at, id.
 * truncated — прочитано не всё (потолок страниц или журнал менялся во время
 * чтения: число строк между страницами разошлось). Ошибку чтения бросает —
 * решает вызывающий (роут отвечает 500, потолок расхода решает сам).
 */
export async function readHeProviderJournal(
  db: SupabaseClient,
  filter: HeProviderJournalFilter,
): Promise<{ rows: HeProviderJournalRow[]; truncated: boolean }> {
  const rows: HeProviderJournalRow[] = [];
  const seen = new Set<string>();
  const toIso = filter.toIso ?? new Date().toISOString();
  let expected: number | null = null;
  for (let page = 0; page < JOURNAL_MAX_PAGES; page++) {
    let query = db
      .from('application_logs')
      .select('id, created_at, context', { count: 'exact' })
      .eq('source', HE_USAGE_SOURCE)
      .eq('event', HE_USAGE_EVENT)
      .lt('created_at', toIso);
    if (filter.projectId) query = query.eq('request_id', filter.projectId);
    if (filter.fromIso) query = query.gte('created_at', filter.fromIso);
    const offset = page * JOURNAL_PAGE;
    const { data, error, count } = await query
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(offset, offset + JOURNAL_PAGE - 1);
    if (error) throw new Error(`application_logs ${HE_USAGE_SOURCE} read: ${error.message}`);
    if (typeof count !== 'number' || (expected !== null && count !== expected)) {
      for (const row of (data ?? []) as HeProviderJournalRow[]) if (!seen.has(row.id)) { seen.add(row.id); rows.push(row); }
      return { rows, truncated: true };
    }
    expected = count;
    for (const row of (data ?? []) as HeProviderJournalRow[]) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      rows.push(row);
    }
    if (offset + JOURNAL_PAGE >= count) return { rows, truncated: false };
    if (!data?.length) return { rows, truncated: true };
  }
  return { rows, truncated: true };
}

/** Расход по журналу — для потолка расхода (P-A-project-spend-ceiling). */
export interface HeProviderSpend {
  /** Сумма известных цен: Requesty (счёт роутера или таблица) + Serper по тарифу, если передан. НИЖНЯЯ граница. */
  knownUsd: number;
  /** Обращения без цены (считаются, но не оцениваются; Serper без тарифа — все). */
  unpricedCalls: number;
  /** Разобранные строки журнала (обращения), по которым посчитан knownUsd. */
  calls: number;
  /** Сумма маркеров lost_before в прочитанных строках (маркеры в he_jobs.result здесь не читаются). */
  lostRows: number;
  /** Строки, которые нельзя считать (версия, рынок, форма), — пропущены, в сумму не вошли. */
  skippedRows: number;
  /**
   * Прочитано не всё. Бывает ТОЛЬКО у постраничного запасного пути (функции
   * he_provider_spend_sum в БД нет): потолок страниц или журнал менялся во
   * время чтения. Сумма на сервере читает журнал целиком и всегда false.
   */
  truncated: boolean;
}

/** Функция суммы на сервере (миграция 20261009_0001_he_provider_spend_sum). */
const HE_PROVIDER_SPEND_SUM_RPC = 'he_provider_spend_sum';

/**
 * Функции нет в БД — миграция ещё не применена: 42883 (undefined_function) от
 * Postgres либо PGRST202 (нет в кэше схемы) от PostgREST. Любой другой отказ —
 * настоящая ошибка чтения, её решает вызывающий.
 */
function isMissingSpendSumRpc(error: { code?: unknown } | null | undefined): boolean {
  return error?.code === '42883' || error?.code === 'PGRST202';
}

/** Округление суммы — как у costReport.aggregateHeCalls (9 знаков): обе ветки отдают одно и то же число. */
const round9 = (value: number): number => Number(value.toFixed(9));

/** Число из ответа функции (numeric/bigint PostgREST отдаёт числом; строку тоже примем). */
function spendSumNumber(row: Record<string, unknown>, field: string): number {
  const raw = row[field];
  const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${HE_PROVIDER_SPEND_SUM_RPC}: field ${field} is not a non-negative number`);
  }
  return value;
}

/**
 * Известный расход ОДНОГО проекта рынка 'us' по журналу: за всё время (без
 * окна) или за окно [fromIso, toIso) — потолок суток передаёт скользящие
 * последние 24 часа.
 *
 * КАК СЧИТАЕТ. Сначала одной суммой на сервере — функция he_provider_spend_sum
 * (миграция 20261009_0001): весь журнал проекта, без потолка строк, отбор по
 * request_id (индекс idx_application_logs_request_id); правила разбора строки те же, что у
 * parseHeCostCall / aggregateHeCalls ниже. Функции нет (миграция не применена:
 * 42883 / PGRST202) — прежнее постраничное чтение (readHeProviderJournal, до
 * 20 страниц по 1 000 строк, старые раньше) с пометкой truncated, если
 * прочитано не всё; что делать с неполной суммой, решает потолок (ниже порога
 * — «неизвестно», пускаем).
 *
 * Построен ТОЛЬКО из строк 'he_provider_usage' — не из he_jobs.cost_usd: тот
 * не знает Serper, а неизвестную цену пишет нулём. Чего здесь нет: цены
 * обращений без цены (только их число), Serper без тарифа, конструктора баз,
 * staff-структуризации кейсов и классификатора staff-запуска с непрочитанным
 * рынком проекта (API-роуты без журнала), вызова в полёте при смерти процесса,
 * строк, не легших в журнал (видно только число переносов lost_before), и
 * всего, что было до выката журнала.
 * Ошибку чтения бросает: решение «нет данных — что делать» — за вызывающим.
 */
export async function readHeProviderSpend(
  db: SupabaseClient,
  filter: { projectId: string; fromIso?: string; toIso?: string; serperUsdPer1000?: number | null },
): Promise<HeProviderSpend> {
  // Тот же разбор тарифа, что у aggregateHeCalls: конечное неотрицательное
  // число — тариф, иначе поиски без цены.
  const tariff = typeof filter.serperUsdPer1000 === 'number'
    && Number.isFinite(filter.serperUsdPer1000)
    && filter.serperUsdPer1000 >= 0
    ? filter.serperUsdPer1000
    : null;

  const { data, error } = await db.rpc(HE_PROVIDER_SPEND_SUM_RPC, {
    p_project_id: filter.projectId,
    p_from: filter.fromIso ?? null,
    p_to: filter.toIso ?? null,
  });
  if (!error) {
    const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
    if (!row || typeof row !== 'object') throw new Error(`${HE_PROVIDER_SPEND_SUM_RPC}: empty answer`);
    const pricedUsd = spendSumNumber(row, 'priced_usd');
    const serperCredits = spendSumNumber(row, 'serper_credits');
    const serperCalls = spendSumNumber(row, 'serper_calls');
    return {
      knownUsd: round9(pricedUsd + (tariff === null ? 0 : (serperCredits * tariff) / 1000)),
      // То же правило, что heUnpricedCalls: без тарифа «без цены» все поиски,
      // с тарифом — только те, по которым провайдер не вернул кредиты.
      unpricedCalls:
        spendSumNumber(row, 'requesty_unpriced')
        + (tariff === null ? serperCalls : spendSumNumber(row, 'serper_credits_unknown')),
      calls: spendSumNumber(row, 'calls'),
      lostRows: spendSumNumber(row, 'lost_rows'),
      skippedRows: spendSumNumber(row, 'skipped_rows'),
      truncated: false,
    };
  }
  if (!isMissingSpendSumRpc(error)) {
    throw new Error(`${HE_PROVIDER_SPEND_SUM_RPC} rpc: ${error.code ?? 'error'}`);
  }

  // Запасной путь до применения миграции — прежнее постраничное чтение.
  const { rows, truncated } = await readHeProviderJournal(db, {
    projectId: filter.projectId,
    fromIso: filter.fromIso,
    toIso: filter.toIso,
  });
  const calls: HeCostCall[] = [];
  let skippedRows = 0;
  for (const row of rows) {
    const parsed = parseHeCostCall(row, filter.projectId);
    if ('issue' in parsed) skippedRows += 1;
    else calls.push(parsed);
  }
  const bucket = aggregateHeCalls(calls, tariff);
  let lostRows = 0;
  for (const rows of heLostRowsByJob(calls).values()) lostRows += rows;
  return {
    knownUsd: bucket.knownUsd,
    unpricedCalls: heUnpricedCalls(bucket),
    calls: calls.length,
    lostRows,
    skippedRows,
    truncated,
  };
}
