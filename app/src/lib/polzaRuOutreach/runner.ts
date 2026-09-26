/**
 * Раннер «Нашего автоаутрича» (parser_type='polza_ru_outreach').
 *
 * Поток — дорогое в конце (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md §2 RU):
 *  1. бесплатно: AMO по ИНН → домен (в т.ч. сайт работодателя hh) → AMO по
 *     домену, повторы в запуске, «уже выгружалась»;
 *  2. почта, тоже бесплатно: поиск на сайте, SMTP-проверка, стоп-лист. Нет
 *     рабочей почты — отсев до ИИ: разбор компании, которой некуда писать, —
 *     выброшенные деньги. Почта не проверена — строка сразу очень спорная,
 *     тоже без ИИ;
 *  3. дешёвый ИИ: вакансии hh и разбор сайта (кэш 30 дней); затем ползунки,
 *     ФНС и новости, оффер, оценка, порог;
 *  4. сомнения — сразу после оценки, все признаки уже известны: очень спорная
 *     строка писем не получает;
 *  5. письма и QA — прошедшим, от самых сильных к слабым (pre-LPR rerank CEO),
 *     пока не набрано заказанное число готовых. Письма — из шаблона цепочки
 *     оффера: его один раз на оффер запуска пишет Gemini 3.1 Pro
 *     (letters/templateWriter.ts), под компанию подставляются проверенные
 *     факты. Шаблон не прошёл проверку или письма компании не прошли
 *     автопроверку — строка очень спорная (спека §4). Строки, ждущие шаблон
 *     оффера, идут в счёт заказанного числа — их поднимет «Переписать
 *     цепочку», и разбор сверх этого не покупаем. Шаблон, который модель не
 *     написала (ошибка, а не замечания проверки), пишется ещё раз на следующей
 *     волне или в конце запуска; снова нет и ни одного написанного — стоп.
 *
 * Волна идёт тремя пулами по очереди: почта (свой параллелизм — обход сайта и
 * SMTP-проверка больше ждут, чем работают), разбор ИИ, письма.
 *
 * Отсеянная строка остаётся в журнале с этапом, кодом и пояснением — по ним
 * считается воронка. Ошибка одной строки не валит запуск.
 *
 * ИИ — общий клиент аутричей: свой ключ, дешёвая модель разбора и лимит
 * расхода на запуск (спека §1). Лимит исчерпан (или остался только запас под
 * шаблоны цепочек) — новые строки не начинаются, запуск завершается штатно
 * (stop_reason 'budget'), готовое остаётся. Ключ не работает, модель молчит 10
 * компаний подряд или писатель не написал ни одной цепочки на двух офферах —
 * запуск сразу failed с понятным текстом, а не сотни строк «ИИ не ответил».
 * Так же и с проверкой почт: 15 адресов подряд «не удалось проверить» — лежат
 * SMTP-прокси.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  smtpAvailable,
  type EmailDomainCache,
  type OutreachEmailVerdict,
  type OutreachEmailVerification,
} from '@/lib/outreachEmail/findAndVerify';
import { outreachApiKey } from '@/lib/outreachLlm/client';
import {
  BudgetExceededError,
  JobBudget,
  LlmAuthError,
  LlmCallError,
  runWithOutreachContext,
  type OutreachLlmBudgetSnapshot,
} from '@/lib/outreachLlm/context';
import { pruneSiteAnalysisCache } from '@/lib/outreachLlm/siteAnalysisCache';
import {
  JobOwner,
  JobStatusReader,
  STATUS_UNREADABLE_TEXT,
  WORKER_LEASE_KEY,
  WORKER_LEASE_TOKEN_PATH,
  withoutWorkerLease,
} from '@/lib/outreachLlm/workerLease';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { analyzeVacancy, findStrictOutboundDuty, isSdrRoleTitle, type VacancyAnalysis } from './analyze';
import { collectCandidates, type Candidate } from './collect';
import {
  computeDoubts,
  lettersQaDoubtText,
  templateDoubtText,
  unverifiedEmailDoubts,
  withLettersDoubt,
  type Doubts,
} from './doubts';
import { companyBrand, isSuppressed, loadPreviouslyExported, normalizeDomain, siteUrl, type ExportedIndex } from './company';
import { findRuCompanyEmail } from './findEmail';
import { journalCounts } from './funnel';
import { buildSegmentsHypothesis, type SegmentsHypothesis } from './letters/chains';
import { composeCompanyLetters } from './letters/renderTemplate';
import {
  createChainTemplates,
  WORKER_WRITER_TIMEOUT_MS,
  writerAttemptWorstUsd,
  type ChainTemplate,
  type ChainTemplates,
} from './letters/templateWriter';
import { loadLibraries, type CaseRecord } from './libraries';
import { isFatalLlmError, llmAnswersInRun } from './llm';
import { baseChain, decide, routeCase, routeChain, scoreCompany, splitAutomation, type Route, type Score } from './router';
import { amoLookup, loadAmoIndex, type AmoIndex, type AmoRecord } from './sources/amo';
import { loadSizeByInn } from './sources/directory';
import { fetchRevenue, revenueGrowthSignal } from './sources/fnsRevenue';
import { fetchEmployerSite, fetchVacancyCard, type HhVacancyCard } from './sources/hhCard';
import type { HhVacancyRef } from './sources/hhPool';
import { findNewsSignals } from './sources/news';
import { analyzeSite, type SiteAnalysis } from './sources/siteSignals';
import {
  CHAIN_LABELS,
  CHAIN_TYPES,
  sanitizeRuOutreachConfig,
  STAGES,
  TEMPLATE_VERSION,
  type ChainType,
  type RuOutreachConfig,
  type Signal,
  type Stage,
} from './types';

/** Целое из env в рамках. Пусто или мусор — значение по умолчанию: NaN в пуле дал бы ноль потоков. */
function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.max(min, Math.min(max, Math.trunc(n))) : fallback;
}

/** Число из env в рамках (деньги — с копейками). Пусто или мусор — значение по умолчанию. */
function envNumber(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

/**
 * Запас лимита на ИИ под шаблоны цепочек, $: когда до лимита (за вычетом броней
 * идущих запросов) остаётся меньше, новый разбор компаний не начинается —
 * иначе разбор съел бы весь лимит, и оплаченные компании остались бы без писем
 * (писать шаблон уже не на что).
 *
 * Лимит строгий: каждый вызов писателя бронирует свою оценку сверху
 * (writerAttemptWorstUsd — около $0.14: 12 000 токенов ответа Gemini 3.1 Pro
 * по $10.8 за миллион и промпт, с наценкой Requesty), а шаблоны офферов волны
 * пишутся разом. Поэтому запас — не меньше первых попыток всех семи офферов
 * (около $1) с четвертью сверху: её съедят строки, чей разбор начался до
 * стоп-линии, и гипотезы сегментов. Базовый запас — $1 (env), но не больше
 * пятой части лимита; итог — не больше половины лимита: при маленьком лимите
 * разбору должно что-то остаться, и первых попыток тогда хватит не на все
 * офферы.
 */
const WRITER_RESERVE_USD = envNumber('POLZA_RU_OUTREACH_WRITER_RESERVE_USD', 1, 0, 20);
const WRITER_RESERVE_SHARE = 0.2;
const WRITER_RESERVE_MARGIN = 1.25;
const WRITER_RESERVE_MAX_SHARE = 0.5;

export function writerReserveUsd(limitUsd: number): number {
  const firstAttempts = CHAIN_TYPES.length * writerAttemptWorstUsd() * WRITER_RESERVE_MARGIN;
  const base = Math.min(WRITER_RESERVE_USD, limitUsd * WRITER_RESERVE_SHARE);
  return Math.min(limitUsd * WRITER_RESERVE_MAX_SHARE, Math.max(base, firstAttempts));
}

/**
 * Сколько ждать идущие вызовы ИИ, прежде чем записать итог расхода. После
 * остановки или сбоя они оборваны и списываются сразу — ждём с запасом. У
 * законченного запуска могут дописываться шаблоны, начатые заранее (их
 * компании ушли в LIMIT_REACHED): писатель — до двух попыток по пять минут.
 */
const ABORTED_SETTLE_MS = 30_000;
const COMPLETED_SETTLE_MS = 2 * WORKER_WRITER_TIMEOUT_MS + 30_000;
/** Строки шаблонов после ответа или обрыва писателя дописываются за миллисекунды — ждём с запасом. */
const TEMPLATE_ROWS_SETTLE_MS = 10_000;

/**
 * Сколько офферов с «ИИ не ответил» у писателя — при ни одном удавшемся
 * шаблоне — уже не случайность, а лежащий Gemini: каждая следующая компания
 * ушла бы в «спорные» без писем. Провал проверки (замечания QA) не в счёт —
 * Gemini отвечает, просто не так.
 */
const WRITER_FAIL_OFFERS = 2;
/** Как часто воркер смотрит, не остановили ли запуск, пока потоки ждут писателя. */
const CANCEL_WATCH_MS = 15_000;

const ENRICH_CONCURRENCY = envInt('POLZA_RU_OUTREACH_CONCURRENCY', 4, 1, 6);
// Шаг почты: обход сайта до минуты и SMTP-проверка через прокси — потоки
// больше ждут, чем работают, и ИИ не тратят. Поэтому свой пул, шире разбора.
const EMAIL_CONCURRENCY = envInt('POLZA_RU_OUTREACH_EMAIL_CONCURRENCY', 8, 1, 16);
// Письма — подстановка в шаблон оффера (и необязательная гипотеза сегментов).
// Шаблон пишется один раз на оффер: компании оффера, дошедшие до писем
// одновременно, ждут одного писателя.
const LETTERS_CONCURRENCY = 4;
/** Карточек вакансий на компанию: у неё может быть и РОП, и SDR. */
const MAX_VACANCY_CARDS = 2;
const MIN_WAVE = 20;
const MAX_WAVE = 200;
const BLIND_YIELD_GUESS = 0.08;
const DB_CHUNK = 100;
const DAY = 86_400_000;

class CancelledError extends Error {
  constructor() {
    super('Запуск остановлен');
    this.name = 'CancelledError';
  }
}
/** ИИ не отвечает серией (разбор или писатель цепочек) — запуск падает целиком, как при неверном ключе. */
class LlmSilentError extends Error {}
/** Сколько компаний подряд с «ИИ не ответил» — уже не случайность, а лежащая модель. */
const LLM_FAIL_STREAK = 10;
/** SMTP-проверка не отвечает серией — запуск падает целиком: дальше все строки ушли бы в очень спорные. */
class SmtpSilentError extends Error {}
/**
 * Сколько адресов подряд «не удалось проверить» — уже не greylisting одного
 * сервера, а лежащие SMTP-прокси.
 */
const SMTP_UNVERIFIED_STREAK = 15;

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) {
  const line = `[polza-ru-outreach][${level.toUpperCase()}] ${msg}`;
  if (extra !== undefined) console[level](line, extra);
  else console[level](line);
}

export function maxCandidatesFor(target: number): number {
  return Math.min(12_000, Math.max(300, target * 15));
}

export function nextWaveSize(target: number, totals: { scanned: number; ready: number }): number {
  const missing = Math.max(1, target - totals.ready);
  const rate = totals.scanned > 0 && totals.ready > 0 ? totals.ready / totals.scanned : BLIND_YIELD_GUESS;
  return Math.max(MIN_WAVE, Math.min(MAX_WAVE, Math.ceil(missing / Math.max(0.02, rate))));
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const item = items[next];
        next += 1;
        await worker(item);
      }
    }),
  );
}

interface Rejection {
  stage: Stage;
  status: 'rejected' | 'manual_review' | 'failed';
  reason: string;
  detail?: string;
}

/**
 * Вклад строки в счётчики запуска: этапы воронки, отчёт SDR, цепочка. Строку,
 * которую остановил лимит на ИИ, вычитаем обратно — её как будто не брали из
 * пула, и на экране она не должна числиться ни в воронке, ни в цепочках.
 */
interface Tally {
  /** Строка журнала: по ней дедуп знает, кто занял домен и ИНН. */
  id: string;
  stages: Stage[];
  sdr: 'strict' | 'broad' | null;
  chain: string | null;
  /** Домен и ИНН, которые строка заняла в дедупе запуска. */
  domain: string | null;
  inn: string | null;
}

/** Почта строки: адрес с сайта с вердиктом проверки или контакт из AMO («Возврат»). */
interface RowEmail {
  email: string;
  emailType: 'department' | 'generic' | 'person' | null;
  isRouting: boolean;
  recipientRole: string | null;
  sourceUrl: string | null;
  /** ok / catch_all / unverified — вердикт SMTP-проверки; crm_contact — адрес из AMO, его не проверяем. */
  verification: OutreachEmailVerification | 'crm_contact';
}

/** Итог бесплатного шага: компания с доменом и рабочей почтой — вход разбора ИИ. */
interface Prepared {
  id: string;
  tally: Tally;
  candidate: Candidate;
  domain: string;
  website: string;
  amo: AmoRecord | null;
  /** Давний отказ в AMO с записанным разговором — цепочка «Возврат». */
  reactivation: boolean;
  email: RowEmail;
  /** Карточки вакансий, уже скачанные ради сайта работодателя: разбор не качает их второй раз. */
  cards: Map<string, HhVacancyCard | null>;
}

/** Всё, что известно о компании после разбора и оценки, — вход писем. */
interface Qualified {
  id: string;
  tally: Tally;
  domain: string;
  brand: string;
  amo: AmoRecord | null;
  email: RowEmail;
  site: SiteAnalysis;
  vacancy: VacancyAnalysis | null;
  signals: Signal[];
  route: Route;
  caseHit: { record: CaseRecord; reason: string } | null;
  score: Score;
  marketQuote: string | null;
  /** Признаки сомнения с оценки: шаг писем добавляет к ним свой, если письма не вышли. */
  doubts: Doubts;
}

/** «Повтор компании в запуске» и строки, чей домен или ИНН он повторил. */
interface Duplicate {
  id: string;
  tally: Tally;
  owners: string[];
}

type SizeIndex = Map<string, { revenue: number | null; employees: number | null }>;

/**
 * Весь запуск идёт внутри контекста ИИ (lib/outreachLlm/context.ts): каждый
 * вызов разбора знает язык и списывает деньги с лимита именно этого запуска —
 * воркер одновременно ведёт и английский аутрич. Сигнал контекста —
 * остановка всего запуска: он обрывает каждый идущий вызов ИИ, не только
 * писателя, и итог расхода пишется сразу, а не когда они сами закончатся.
 *
 * Запуск воркер держит арендой (lib/outreachLlm/workerLease.ts): пока он
 * доводит остановленный запуск, «Переписать цепочку» ждёт, и итог воркера не
 * стирает её расход.
 */
export async function runRuOutreachJob(jobId: string): Promise<void> {
  const db = supabaseAdmin;
  if (!db) {
    log('error', 'supabaseAdmin not configured');
    return;
  }
  const runAbort = new AbortController();
  const owner = new JobOwner({
    db,
    jobId,
    log,
    // Запуск забрали (аренда истекла, отметку снял роут) — прогон больше не
    // наш: обрываем его, записывать итог он не будет.
    onLost: () => {
      if (!runAbort.signal.aborted) runAbort.abort(new CancelledError());
    },
  });
  // Остановку или сбой воркер заметил — до итоговой записи держит аренду свежей.
  runAbort.signal.addEventListener('abort', () => owner.windDown(), { once: true });
  let start: JobStart;
  try {
    start = await loadJobStart(db, jobId);
    // Только идущий запуск: остановленный между захватом и стартом (его уже
    // может переписывать «Переписать цепочку») заново не начинается.
    if (!(await owner.claim(start.previousDetail))) {
      log('info', `job ${jobId}: not running anymore — the run is not started`);
      return;
    }
  } catch (err) {
    // Лимит и прошлый расход не прочитались — не запускаем: с лимитом по
    // умолчанию и нулём потраченного перезапуск мог бы потратить лимит ещё раз.
    const message = err instanceof Error ? err.message : String(err);
    log('error', `job ${jobId}: ${message}`);
    const { error } = await db
      .from('parser_jobs')
      .update({ status: 'failed', progress_stage: 'failed', completed_at: new Date().toISOString(), error_message: message })
      .eq('id', jobId)
      .eq('status', 'running');
    if (error) log('warn', `job ${jobId}: failed status update failed`, error);
    return;
  }
  await runWithOutreachContext({ lang: 'ru', budget: start.budget, signal: runAbort.signal }, () =>
    runJob(db, jobId, start.budget, start.previousDetail, runAbort, owner),
  );
}

interface JobStart {
  budget: JobBudget;
  /** progress_detail прошлого прогона (перезапуск воркера) или null у нового запуска. */
  previousDetail: Record<string, unknown> | null;
}

const START_READ_RETRY_MS = 2_000;

/**
 * Бюджет нужен до входа в контекст, поэтому конфиг здесь читается отдельно от
 * runJob. Лимит — из конфига, потраченное — из снимка progress_detail.llm. У
 * нового запуска снимка нет, счёт с нуля. После падения воркера запуск
 * возвращается в очередь (recoverRunningParserJobs) и идёт заново, а снимок
 * остаётся от прерванного прогона: деньги уже потрачены, и без него каждый
 * перезапуск получал бы лимит целиком ещё раз. Читаем до runJob — первая же
 * публикация прогресса снимок перезапишет. Снимок сохраняется продлением
 * аренды раз в 30 с и сразу после каждого вызова писателя, вместе с бронями
 * идущих запросов (они считаются потраченными): при падении теряются только
 * запросы, начатые в последние секунды.
 *
 * Не прочиталось (сбой PostgREST или сети) — одна повторная попытка, потом
 * ошибка: молча начать с лимитом по умолчанию и нулём потраченного нельзя.
 */
async function loadJobStart(db: SupabaseClient, jobId: string): Promise<JobStart> {
  let problem = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, START_READ_RETRY_MS));
    try {
      const { data, error } = await db.from('parser_jobs').select('config, progress_detail').eq('id', jobId).maybeSingle();
      if (error) {
        problem = error.message;
        continue;
      }
      if (!data) {
        problem = 'запуск не найден';
        continue;
      }
      const limit = sanitizeRuOutreachConfig((data.config ?? {}) as Partial<RuOutreachConfig>).llm_budget_usd;
      const raw: unknown = data.progress_detail;
      const previousDetail = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
      const snapshot = (previousDetail?.llm ?? null) as Partial<OutreachLlmBudgetSnapshot> | null;
      return { budget: JobBudget.fromSnapshot(snapshot, limit), previousDetail };
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`Не удалось прочитать запуск и расход на ИИ из базы: ${problem}`);
}

interface JournalRow {
  id: string;
  row_status: string;
  pipeline_stage: string | null;
  reason_code: string | null;
  chain_type: string | null;
  normalized_domain: string | null;
  inn: string | null;
  doubt_flags: string[] | null;
}

/**
 * Перезапуск воркера, когда лимит на ИИ уже исчерпан или от него остался только
 * запас под шаблоны (по снимку progress_detail.llm): разбирать больше не на
 * что, а журнал прошлого прогона —
 * готовые, отсеянные, очень спорные — оплачен. Поэтому журнал не стираем:
 * убираем только необработанные строки (и повторы, чей оригинал среди них —
 * как при обычном стопе по лимиту), счётчики пересчитываем по журналу тем же
 * правилом, что экран (funnel.ts), и завершаем запуск остановленным лимитом.
 * Отчёт SDR, пул и ошибки источников по журналу не пересчитать — они
 * остаются из снимка.
 */
async function completeSpentRun(
  db: SupabaseClient,
  jobId: string,
  target: number,
  budget: JobBudget,
  previousDetail: Record<string, unknown> | null,
  finishRun: (patch: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  const { error: dropErr } = await db.from('polza_ru_outreach_companies').delete().eq('job_id', jobId).eq('row_status', 'processing');
  if (dropErr) throw new Error(`Не удалось убрать необработанные строки журнала: ${dropErr.message}`);
  const rows: JournalRow[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    // Страницы — в порядке id: без порядка соседние страницы могли бы
    // пропустить или повторить строки, и счётчики разошлись бы с журналом.
    const { data, error } = await db
      .from('polza_ru_outreach_companies')
      .select('id,row_status,pipeline_stage,reason_code,chain_type,normalized_domain,inn,doubt_flags')
      .eq('job_id', jobId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`Не удалось прочитать журнал запуска: ${error.message}`);
    rows.push(...((data ?? []) as JournalRow[]));
    if (!data || data.length < PAGE) break;
  }
  // Повтор без оригинала: ни одна строка, кроме повторов, не держит его домен или ИНН.
  const held = rows.filter((r) => r.reason_code !== 'DUPLICATE_COMPANY');
  const domains = new Set(held.map((r) => r.normalized_domain).filter(Boolean));
  const inns = new Set(held.map((r) => r.inn).filter(Boolean));
  const orphans = rows
    .filter((r) => r.reason_code === 'DUPLICATE_COMPANY' && !(r.normalized_domain && domains.has(r.normalized_domain)) && !(r.inn && inns.has(r.inn)))
    .map((r) => r.id);
  const gone = new Set<string>();
  for (let i = 0; i < orphans.length; i += DB_CHUNK) {
    const { data, error } = await db
      .from('polza_ru_outreach_companies')
      .delete()
      .eq('job_id', jobId)
      .eq('reason_code', 'DUPLICATE_COMPANY')
      .in('id', orphans.slice(i, i + DB_CHUNK))
      .select('id');
    if (error) log('warn', `job ${jobId}: orphan duplicates cleanup failed`, error);
    for (const r of data ?? []) gone.add(String(r.id));
  }
  const kept = rows.filter((r) => !gone.has(String(r.id)));
  const { funnel, reasons, chains, ready, doubtful, awaiting } = journalCounts(kept);
  const stopReason = ready >= target ? 'target_reached' : 'budget';
  const spend = budget.snapshot();
  log('info', `job ${jobId}: no LLM budget left for new analysis ($${spend.spent_usd}/$${spend.limit_usd}) — restart keeps the journal: ${kept.length} rows, ${ready} ready (${stopReason})`);
  await finishRun({
    status: 'completed',
    progress_stage: 'completed',
    progress_percent: 100,
    total_found: kept.length,
    total_parsed: ready,
    completed_at: new Date().toISOString(),
    error_message: null,
    progress_detail: {
      ...withoutWorkerLease(previousDetail ?? {}),
      scanned: kept.length,
      ready,
      funnel,
      reasons,
      chains,
      doubtful,
      awaiting_templates: awaiting,
      llm: spend,
      stop_reason: stopReason,
    },
  });
}

async function runJob(
  db: SupabaseClient,
  jobId: string,
  budget: JobBudget,
  previousDetail: Record<string, unknown> | null,
  // Остановка обрывает все вызовы ИИ запуска (сигнал контекста): писатель ждёт
  // Gemini до пяти минут, и без сигнала «Остановить» ждало бы, пока он допишет
  // (и заплатило бы за это).
  runAbort: AbortController,
  owner: JobOwner,
): Promise<void> {
  // Прогресс и итог пишем только идущему запуску. Упал или остановлен — потоки
  // пула ещё добегают свои строки, и их публикации перетёрли бы «failed» и
  // «Остановлено пользователем». И только при своей аренде: запуск, который
  // подхватил другой прогон, этот не перетирает.
  const setRunningProgress = async (patch: Record<string, unknown>) => {
    const { error } = await db
      .from('parser_jobs')
      .update(patch)
      .eq('id', jobId)
      .eq('status', 'running')
      .eq(WORKER_LEASE_TOKEN_PATH, owner.token);
    if (error) log('warn', `progress update failed for ${jobId}`, error);
  };
  /**
   * Итог законченного запуска — последняя запись, она же отпускает аренду.
   * Остановили в последний момент — статус остановки не трогаем и причину
   * окончания не утверждаем, но прогресс и расход всё равно пишем.
   */
  const finishRun = async (patch: Record<string, unknown>) => {
    await owner.close();
    if ((await owner.write(patch, { requireRunning: true })) !== 'skipped') return;
    const progressDetail = { ...(patch.progress_detail as Record<string, unknown>) };
    delete progressDetail.stop_reason;
    delete progressDetail.stop_reason_base;
    await owner.write({ progress_detail: progressDetail });
  };
  // Шаблоны цепочек запуска — когда созданы: итог ждёт и их строк.
  let templatesRef: ChainTemplates | null = null;
  /**
   * Дождаться идущих вызовов ИИ: итог расхода пишется после них. false — не
   * дождались, и их брони (оценку сверху) итог считает потраченными. Потом —
   * строки шаблонов, которые писатели дописывают или отпускают после обрыва:
   * «Переписать цепочку» сразу после итога не должна видеть шаблон «пишется».
   */
  const settleCalls = async (timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    let settled = budget.idle();
    if (!settled) {
      log('info', `job ${jobId}: waiting for LLM calls in flight before writing the final spend`);
      settled = await budget.whenIdle(timeoutMs);
      if (!settled) log('warn', `job ${jobId}: LLM calls still in flight after ${Math.round(timeoutMs / 1000)} s — their upper estimate is counted as spent`);
    }
    if (templatesRef) await templatesRef.settled(Math.min(TEMPLATE_ROWS_SETTLE_MS, Math.max(0, deadline - Date.now())));
    return settled;
  };
  // Остановка — только прочитанный статус «не идёт» (или запуска нет). Сбой
  // чтения — не остановка: раньше он бросал здоровый запуск «идущим» без
  // воркера навсегда. Статус не читается больше 3 минут подряд — запуск падает
  // с понятной причиной (JobStatusReader).
  const statusReader = new JobStatusReader(db, jobId);
  const ensureNotCancelled = async () => {
    // Запуск уже оборван (остановка или сбой) — новую строку не начинаем.
    if (runAbort.signal.aborted) throw new CancelledError();
    const read = await statusReader.read();
    if (!read.ok) {
      if (statusReader.unreadableTooLong()) throw new Error(STATUS_UNREADABLE_TEXT);
      log('warn', `job ${jobId}: status check failed, the run goes on — ${read.error}`);
      return;
    }
    if (read.status !== 'running') {
      const cancelled = new CancelledError();
      if (!runAbort.signal.aborted) runAbort.abort(cancelled);
      throw cancelled;
    }
  };
  let cancelWatch: ReturnType<typeof setInterval> | null = null;
  const updateRow = async (id: string, patch: Record<string, unknown>) => {
    const { error } = await db
      .from('polza_ru_outreach_companies')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', id);
    if (error) log('warn', `row update failed (${id})`, error);
  };
  // Прогресс «как сейчас» — для сбоя и остановки: к нему дописывается итог
  // расходов на ИИ. Появляется, когда запуск дошёл до обработки строк.
  let currentDetail: (() => Record<string, unknown>) | null = null;
  // До того — прошлый прогон и расход (его пишут продление аренды и итог).
  // Расход, пока запуск идёт, — с бронями идущих запросов (оценкой сверху):
  // упадёт воркер (SIGKILL, OOM) посреди семи писателей — перезапуск начнёт со
  // снимка, где эти, может быть, уже оплаченные запросы учтены, и лимит
  // останется строгим. Итог запуска пишет факт (после ответа или обрыва).
  const baseDetail = (): Record<string, unknown> => ({
    ...withoutWorkerLease(previousDetail ?? {}),
    llm: budget.snapshot({ includeReserved: true }),
    [WORKER_LEASE_KEY]: owner.lease(),
  });
  // Раз в 30 с воркер сохраняет изменившийся progress_detail — расход на ИИ
  // (при падении теряются только запросы последних секунд). Вызов писателя —
  // дорогой: его расход сохраняем сразу, иначе перезапуск воркера заплатил бы
  // за шаблон ещё раз мимо лимита.
  owner.start(() => (currentDetail ? currentDetail() : baseDetail()));
  budget.onCharge((role) => {
    if (role === 'writer') owner.save();
  });

  try {
    const { data: job, error: jobErr } = await db.from('parser_jobs').select('config').eq('id', jobId).single();
    if (jobErr || !job) throw new Error(jobErr?.message ?? 'Job not found');
    const config: RuOutreachConfig = sanitizeRuOutreachConfig((job.config ?? {}) as Partial<RuOutreachConfig>);
    const target = config.limit;
    const maxScan = maxCandidatesFor(target);
    const reserveUsd = writerReserveUsd(budget.limitUsd);
    // На разбор новых компаний денег нет: лимит исчерпан или от него, за
    // вычетом броней идущих запросов, остался только запас под шаблоны цепочек.
    const analysisBudgetLeft = (): boolean => !budget.exhausted() && budget.available() >= reserveUsd;
    // Перезапуск после исчерпанного лимита: журнал оплачен и остаётся, новых
    // строк не будет — ни ключ, ни источники не нужны. То же, если остался
    // только запас: новый прогон стёр бы оплаченный журнал и сразу встал.
    if (!analysisBudgetLeft()) {
      await completeSpentRun(db, jobId, target, budget, previousDetail, finishRun);
      return;
    }
    // Роут не создаёт запуск без ключа, но окружение воркера — отдельное. Без
    // ключа ни одна компания не пройдёт разбор: падаем до сбора источников.
    if (!outreachApiKey('ru')) {
      throw new LlmAuthError('Не задан ключ ИИ для RU автоаутрича (POLZA_RU_OUTREACH_API_KEY) в окружении воркера', 'missing_key');
    }
    // Без SMTP-прокси проверка почт — только синтаксис и MX: адрес «рабочий»,
    // если у домена есть почтовый сервер. Запуск идёт, но экран об этом
    // предупреждает (progress_detail.smtp_unavailable).
    const smtpOn = smtpAvailable();
    if (!smtpOn) log('warn', `job ${jobId}: SMTP_PROXY_URLS not set — emails are checked by syntax and MX only`);

    // Только идущему: статус остановки не перетираем (запуск, остановленный
    // после захвата, заново не начинается — ensureNotCancelled ниже).
    await setRunningProgress({
      started_at: new Date().toISOString(),
      error_message: null,
      progress_stage: 'loading_sources',
      progress_percent: 1,
      total_found: 0,
      total_parsed: 0,
    });
    // Потоки писем могут минутами ждать писателя и на статус не смотреть —
    // остановку ловим отдельно, чтобы она обрывала и запись шаблона. Только
    // явную: сбой запроса статуса — не повод обрывать оплаченную запись (но
    // идёт в счёт «статус не читается» у проверки перед строкой).
    cancelWatch = setInterval(() => {
      void statusReader.read().then((read) => {
        if (read.ok && read.status !== 'running' && !runAbort.signal.aborted) runAbort.abort(new CancelledError());
      });
    }, CANCEL_WATCH_MS);
    cancelWatch.unref?.();
    // Остановленный между захватом и стартом запуск журнал прошлого прогона не стирает.
    await ensureNotCancelled();
    // Повтор после падения воркера — с чистого журнала, иначе дубли в воронке.
    // Лимит при этом ещё не исчерпан (иначе — completeSpentRun выше): разборы
    // сайтов в кэше, и заново платим в основном за вакансии.
    await db.from('polza_ru_outreach_companies').delete().eq('job_id', jobId);
    // Из шаблонов цепочек прошлого прогона — только не готовые: failed-шаблон
    // иначе сразу отправил бы компании оффера в спорные без новой попытки, а
    // pending умершего прогона заставил бы ждать. Готовые (ok) оплачены и
    // годятся этому же запуску — новый прогон возьмёт их, а не заплатит
    // писателю второй раз. Путь «лимит уже исчерпан» выше шаблоны не трогает —
    // журнал и его письма остаются.
    const { error: templatesErr } = await db.from('polza_chain_templates').delete().eq('job_id', jobId).eq('lang', 'ru').neq('status', 'ok');
    if (templatesErr) throw new Error(`Не удалось убрать цепочки прошлого прогона: ${templatesErr.message}`);
    // Устаревшие разборы сайтов читатель не берёт — чистим, чтобы кэш не рос без конца.
    await pruneSiteAnalysisCache('ru');

    const libraries = await loadLibraries(db, config.sender_id);
    if (!libraries.sender) throw new Error('Нет активной подписи отправителя — добавьте её во вкладке «Библиотеки»');
    const sender = libraries.sender;
    // Шаблоны цепочек запуска: пишутся лениво, один раз на оффер.
    const templates = createChainTemplates({
      db, jobId, sender, claims: libraries.claims, writerTimeoutMs: WORKER_WRITER_TIMEOUT_MS, signal: runAbort.signal,
    });
    templatesRef = templates;
    const amo: AmoIndex = await loadAmoIndex(db);
    const exported: ExportedIndex = config.include_previously_exported
      ? { domains: new Set(), inns: new Set() }
      : await loadPreviouslyExported(db, jobId);
    const { pool, sourceErrors } = await collectCandidates(db, config, amo, maxScan);
    if (Object.keys(sourceErrors).length) log('warn', `job ${jobId}: source errors`, sourceErrors);
    log('info', `job ${jobId}: pool=${pool.length}, target=${target}, sources=${config.sources.join(',')}`);

    const funnel = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
    const reasons: Record<string, number> = {};
    const chains: Record<string, number> = {};
    const doubtful = { count: 0 };
    // Предохранитель обогащения: 5 ошибок подряд — источник выключается до конца запуска.
    const enrichFails: Record<'revenue_growth' | 'news', number> = { revenue_growth: 0, news: 0 };
    const enrichOff = new Set<string>();
    const enrich = async <T>(code: 'revenue_growth' | 'news', what: string, fn: () => Promise<T>): Promise<T | null> => {
      if (enrichOff.has(code)) return null;
      try {
        const res = await fn();
        enrichFails[code] = 0;
        return res;
      } catch (err) {
        // Лимит на ИИ, неверный ключ и остановка запуска (оборванный вызов
        // новостей) — не сбой источника: предохранитель их не считает и не
        // глотает, иначе строка молча ушла бы дальше без новостей, а запуск
        // продолжил бы тратить или падать построчно.
        if (isFatalLlmError(err) || err instanceof CancelledError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        log('warn', `${what} failed`, msg);
        enrichFails[code] += 1;
        if (enrichFails[code] >= 5 && !enrichOff.has(code)) {
          enrichOff.add(code);
          sourceErrors[code] = `отключён на этот запуск после 5 ошибок подряд: ${msg.slice(0, 300)}`;
          log('warn', `job ${jobId}: ${code} disabled for this run`);
        }
        return null;
      }
    };
    // Отчёт о попадании в SDR (SDR_ENTERPRISE_PROOF_AND_OFFER_ROUTING §3):
    // уникальные компании, а не вакансии — видно, не «пылесосит» ли SDR поток.
    // Вакансии разбираются после почты, поэтому считаются компании с рабочей почтой.
    const sdr = { any_sales_vacancy: 0, strict_sdr: 0, broad_to_general_queue: 0 };
    const totals = { scanned: 0, ready: 0 };
    // Дедуп запуска: какая строка заняла домен и какая — ИНН. Строка,
    // возвращённая в необработанные, их освобождает; повтор помнит, чей домен
    // или ИНН он повторил (уборка после стопа по лимиту).
    const domainOwner = new Map<string, string>();
    const innOwner = new Map<string, string>();
    const duplicates: Duplicate[] = [];
    // MX и catch-all доменов для SMTP-проверки почты — один кэш на запуск.
    const emailDomainCache: EmailDomainCache = new Map();
    let cursor = 0;
    let waveNo = 0;
    let processed = 0;
    // Шаг волны, который сейчас идёт, — для progress_stage.
    let phase = 'finding_emails';
    // Лимит на ИИ исчерпан или от него остался только запас под шаблоны:
    // новые строки и волны не начинаем, запуск завершится штатно. Строки,
    // которые лимит остановил, уберём из журнала. Запас тратит только
    // писатель — у уже разобранных компаний будут письма.
    let budgetStop = false;
    const stopForBudget = (): boolean => {
      if (!analysisBudgetLeft()) budgetStop = true;
      return budgetStop;
    };
    // Предохранитель «писатель молчит»: ни одного написанного шаблона, а
    // модель не ответила на WRITER_FAIL_OFFERS офферах — или на одном, но и в
    // повторе на следующей волне. Значит, лежит Gemini (или Requesty), и каждая
    // следующая компания ушла бы в спорные без писем. Провал по замечаниям
    // проверки не в счёт: писатель отвечает. Считаем попытки записи (attempt
    // шаблона), а не строки: строк у одной попытки много.
    let writerWorks = false;
    const writerFailures = new Map<ChainType, { error: string; attempts: Set<number> }>();
    const noteTemplate = (template: ChainTemplate) => {
      if (template.status === 'ok') {
        writerWorks = true;
        return;
      }
      if (!template.error || writerWorks) return;
      const seen = writerFailures.get(template.chain) ?? { error: template.error, attempts: new Set<number>() };
      seen.error = template.error;
      seen.attempts.add(template.attempt);
      writerFailures.set(template.chain, seen);
      const failedTwice = [...writerFailures.values()].some((f) => f.attempts.size >= 2);
      if (writerFailures.size >= WRITER_FAIL_OFFERS || failedTwice) {
        const list = [...writerFailures].map(([chain, f]) => `«${CHAIN_LABELS[chain]}» — ${f.error}`).join('; ');
        throw new LlmSilentError(`Gemini не пишет цепочки: ${list}`.slice(0, 1000));
      }
    };
    // Строки, которые ждут шаблон оффера, не прошедший проверку или не
    // написанный (очень спорные с TEMPLATE_FAILED). «Переписать цепочку» может
    // сделать их готовыми, поэтому они идут в счёт заказанного числа: иначе
    // запуск докупал бы разбор новых компаний сверх того, что потом можно
    // выложить.
    const awaiting = { count: 0 };
    // Из них — те, чей шаблон не написан из-за молчания модели: на шаге писем
    // следующей волны (или в конце запуска) шаблон пишется ещё раз, и эти
    // строки собираются заново.
    const parked = new Map<ChainType, Qualified[]>();
    const parkedIds = new Set<string>();
    const retriedChains = new Set<ChainType>();
    // Ключ ИИ отвергнут или ИИ молчит: запуск уже падает — остальным потокам
    // новых строк не брать.
    let halted = false;
    // Предохранитель «ИИ молчит»: LLM_FAIL_STREAK компаний подряд отсеяны с
    // «ИИ не ответил», и между ними ни одного удачного ответа — значит, лежат
    // модель или Requesty, и так же упадёт каждая следующая строка. Считаем
    // только отсевы по ИИ; любой удачный (целый) ответ — в том числе на другой
    // строке — серию обнуляет, ответ без обязательных полей — нет (llm.ts).
    let llmFailStreak = 0;
    let llmAnswersSeen = 0;
    const noteLlmFailed = () => {
      const answers = llmAnswersInRun();
      if (answers !== llmAnswersSeen) {
        llmAnswersSeen = answers;
        llmFailStreak = 0;
      }
      llmFailStreak += 1;
      if (llmFailStreak >= LLM_FAIL_STREAK) {
        throw new LlmSilentError(`ИИ не отвечает: ${LLM_FAIL_STREAK} компаний подряд без ответа модели — проверьте Requesty/модель`);
      }
    };
    // Предохранитель «проверка почт молчит»: SMTP_UNVERIFIED_STREAK адресов
    // подряд «не удалось проверить» — лежат SMTP-прокси, и каждая следующая
    // компания уйдёт в очень спорные. Любой определённый ответ проверки
    // (рабочий, catch-all, нерабочий) серию обнуляет; «адресов на сайте нет» и
    // контакт из AMO её не трогают. Без SMTP-прокси проверки SMTP нет — нет и
    // предохранителя.
    let smtpUnverifiedStreak = 0;
    /** true — серия дошла до порога: строку дописываем и валим запуск. */
    const noteEmailVerdict = (verdict: OutreachEmailVerdict): boolean => {
      if (!smtpOn || verdict === 'none') return false;
      if (verdict !== 'unverified') {
        smtpUnverifiedStreak = 0;
        return false;
      }
      smtpUnverifiedStreak += 1;
      return smtpUnverifiedStreak >= SMTP_UNVERIFIED_STREAK;
    };
    const smtpSilentError = () =>
      new SmtpSilentError(`Проверка почт не отвечает: ${SMTP_UNVERIFIED_STREAK} адресов подряд не удалось проверить — проверьте SMTP-прокси`);
    // Гипотеза сегментов после лимита на ИИ пропускается; в лог — один раз за запуск.
    let hypothesisSkipLogged = false;

    // llm — снимок расходов: экран пишет «ИИ: потрачено $X из $Y».
    // smtp_unavailable — плашка «SMTP-проверка почт недоступна».
    // awaiting_templates — сколько компаний ждут «Переписать цепочку».
    // worker — аренда запуска воркером: её несёт каждая запись progress_detail.
    const detail = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      wave: waveNo, target, pool: pool.length, scanned: totals.scanned, ready: totals.ready, funnel, reasons, chains, sdr,
      offer_version: libraries.offerVersion, source_errors: sourceErrors, doubtful: doubtful.count,
      // С бронями идущих запросов — как baseDetail; итог запуска пишет факт.
      llm: budget.snapshot({ includeReserved: true }),
      awaiting_templates: awaiting.count,
      ...(smtpOn ? {} : { smtp_unavailable: true }), ...extra,
      [WORKER_LEASE_KEY]: owner.lease(),
    });
    currentDetail = () => detail();
    const publish = async (stage: string, extra: Record<string, unknown> = {}) => {
      await setRunningProgress({
        progress_stage: stage,
        progress_percent: Math.min(97, 3 + Math.round(94 * Math.max(totals.ready / target, Math.min(1, totals.scanned / maxScan)))),
        total_found: totals.scanned,
        total_parsed: totals.ready,
        progress_detail: detail(extra),
      });
    };
    const newTally = (id: string): Tally => ({ id, stages: [], sdr: null, chain: null, domain: null, inn: null });
    const reach = (tally: Tally, ...stages: Stage[]) => {
      for (const s of stages) {
        funnel[s] += 1;
        tally.stages.push(s);
      }
    };
    /** Строка возвращается в необработанные: её вклад в счётчики вычитаем. */
    const untally = (tally: Tally) => {
      for (const s of tally.stages) funnel[s] -= 1;
      if (tally.sdr) {
        sdr.any_sales_vacancy -= 1;
        if (tally.sdr === 'strict') sdr.strict_sdr -= 1;
        else sdr.broad_to_general_queue -= 1;
      }
      if (tally.chain) {
        const left = (chains[tally.chain] ?? 0) - 1;
        if (left > 0) chains[tally.chain] = left;
        else delete chains[tally.chain];
      }
      // Домен и ИНН строки освобождаем: иначе такая же компания дальше в
      // запуске отсеялась бы «повтором» строки, которой в журнале уже нет.
      if (tally.domain && domainOwner.get(tally.domain) === tally.id) domainOwner.delete(tally.domain);
      if (tally.inn && innOwner.get(tally.inn) === tally.id) innOwner.delete(tally.inn);
      tally.stages = [];
      tally.sdr = null;
      tally.chain = null;
      tally.domain = null;
      tally.inn = null;
    };
    const finish = async (id: string, r: Rejection, patch: Record<string, unknown> = {}) => {
      reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
      await updateRow(id, { ...patch, row_status: r.status, pipeline_stage: r.stage, reason_code: r.reason, reason_detail: r.detail ?? null });
    };
    /**
     * Строка, которую лимит на ИИ вернул в необработанные: вклад в счётчики
     * вычитаем, а в журнале сбрасываем то, по чему её посчитал бы экран, —
     * этап и цепочку. В конце запуска такие строки удаляются; если удаление не
     * пройдёт, строка, дошедшая, скажем, до оценки, иначе числилась бы в
     * воронке до «Оценки» и в цепочках, хотя из счётчиков запуска её уже
     * вычли.
     */
    const returnToPool = async (id: string, tally: Tally) => {
      untally(tally);
      await updateRow(id, {
        row_status: 'processing', pipeline_stage: 'candidates_loaded', chain_type: null, reason_code: null, reason_detail: null,
      });
    };

    /**
     * Живая карточка вакансии, если она годится поводом: открыта, с текстом и
     * свежая. Скачанные карточки строки запоминаем: карточку, взятую ради
     * сайта работодателя, разбор вакансий второй раз не качает.
     */
    const liveCard = async (ref: HhVacancyRef, cards: Map<string, HhVacancyCard | null>): Promise<HhVacancyCard | null> => {
      if (cards.has(ref.vacancy_id)) return cards.get(ref.vacancy_id) ?? null;
      const res = await fetchVacancyCard(ref.vacancy_id);
      let card: HhVacancyCard | null = null;
      if (res.ok && !res.card.archived && res.card.descriptionText.length >= 200) {
        const published = res.card.publishedAt ? new Date(res.card.publishedAt).getTime() : NaN;
        if (!(Number.isFinite(published) && published < Date.now() - config.freshness_days * DAY)) card = res.card;
      }
      cards.set(ref.vacancy_id, card);
      return card;
    };
    /** Id работодателя из живой карточки вакансии — у кандидата hh его может не быть. */
    const employerIdFromCards = async (c: Candidate, cards: Map<string, HhVacancyCard | null>): Promise<string | null> => {
      for (const ref of c.vacancies.slice(0, MAX_VACANCY_CARDS)) {
        const card = await liveCard(ref, cards);
        if (card?.employerId) return card.employerId;
      }
      return null;
    };

    // ── Шаг 1 (бесплатно): AMO, домен, повторы, почта, стоп-лист ──
    const prepare = async (id: string, c: Candidate, tally: Tally): Promise<Prepared | null> => {
      reach(tally, 'candidates_loaded');
      const amoByInn = c.inn ? amoLookup(amo, null, c.inn) : null;
      if (amoByInn && (amoByInn.status === 'open_deal' || amoByInn.status === 'client')) {
        await finish(id, { stage: 'amo_checked', status: 'rejected', reason: amoByInn.status === 'client' ? 'AMO_CLIENT' : 'AMO_OPEN_DEAL', detail: amoByInn.statusName }, { amo_status: amoByInn.status });
        return null;
      }
      reach(tally, 'amo_checked');

      // Домен. Сайта нет в источнике — берём сайт работодателя hh: id
      // работодателя из источника или из живой карточки вакансии (hh API, без ИИ).
      const cards = new Map<string, HhVacancyCard | null>();
      let website = c.website;
      let domain = normalizeDomain(website);
      if (!domain) {
        const employerId = c.hhEmployerId ?? (await employerIdFromCards(c, cards));
        if (employerId) {
          website = await fetchEmployerSite(employerId);
          domain = normalizeDomain(website);
        }
      }
      if (!domain) {
        await finish(id, { stage: 'company_resolved', status: 'rejected', reason: 'DOMAIN_NOT_FOUND' });
        return null;
      }
      const site_url = website && /^https?:\/\//i.test(website) ? website : siteUrl(domain);
      await updateRow(id, { normalized_domain: domain, company_website: site_url, pipeline_stage: 'company_resolved' });

      // AMO по домену: клиент, открытая сделка, свежий отказ — не пишем.
      const amoRec = amoLookup(amo, domain, c.inn) ?? c.amo;
      if (amoRec && amoRec.status !== 'lost' && amoRec.status !== 'none') {
        const reason = amoRec.status === 'client' ? 'AMO_CLIENT' : amoRec.status === 'open_deal' ? 'AMO_OPEN_DEAL' : 'CRM_RECENT_CONTACT';
        await finish(id, { stage: 'amo_checked', status: 'rejected', reason, detail: amoRec.statusName }, { amo_status: amoRec.status });
        return null;
      }
      reach(tally, 'company_resolved');

      // Проверка и захват домена/ИНН — без await между ними: параллельные
      // потоки не займут одну компанию дважды.
      const owners = [domainOwner.get(domain), c.inn ? innOwner.get(c.inn) : undefined].filter((o): o is string => Boolean(o));
      if (owners.length) {
        duplicates.push({ id, tally, owners: Array.from(new Set(owners)) });
        await finish(id, { stage: 'deduplicated', status: 'rejected', reason: 'DUPLICATE_COMPANY' });
        return null;
      }
      domainOwner.set(domain, id);
      tally.domain = domain;
      if (c.inn) {
        innOwner.set(c.inn, id);
        tally.inn = c.inn;
      }
      if (exported.domains.has(domain) || (c.inn && exported.inns.has(c.inn))) {
        await finish(id, { stage: 'deduplicated', status: 'rejected', reason: 'PREVIOUSLY_EXPORTED' });
        return null;
      }
      reach(tally, 'deduplicated');

      // Почта — до ИИ: компания без рабочего адреса не стоит разбора. Возврату
      // берём контакт из AMO без поиска и проверки — с ним уже был разговор.
      const reactivation = Boolean(amoRec && amoRec.status === 'lost' && amoRec.priorContact);
      let email: RowEmail;
      // Серия «не удалось проверить» дошла до порога — строку дописываем, запуск валим.
      let smtpSilent = false;
      if (reactivation && amoRec?.contactEmail) {
        email = { email: amoRec.contactEmail, emailType: 'person', isRouting: false, recipientRole: 'Контакт из AMO', sourceUrl: null, verification: 'crm_contact' };
      } else {
        const found = await findRuCompanyEmail(site_url, domain, emailDomainCache);
        smtpSilent = noteEmailVerdict(found.verdict);
        if (!found.email || !found.verification) {
          // Адреса на сайте есть, но все не прошли проверку, — своя причина:
          // «почты нет» и «почта мёртвая» — разные выводы об источнике.
          const invalid = found.verdict === 'invalid';
          await finish(id, {
            stage: 'recipient_resolved',
            status: 'rejected',
            reason: invalid ? 'EMAIL_INVALID' : 'EMAIL_NOT_FOUND',
            detail: invalid ? `не прошли проверку: ${found.triedInvalid.join(', ')}`.slice(0, 500) : undefined,
          });
          return null;
        }
        email = {
          email: found.email,
          emailType: found.emailType,
          isRouting: found.isRouting,
          recipientRole: found.recipientRole,
          sourceUrl: found.sourceUrl,
          verification: found.verification,
        };
      }
      if (await isSuppressed(db, email.email)) {
        await finish(id, { stage: 'recipient_resolved', status: 'rejected', reason: 'SUPPRESSED_CONTACT', detail: email.email });
        if (smtpSilent) throw smtpSilentError();
        return null;
      }
      // Почту и вердикт проверки пишем сразу: строка, отсеянная дальше разбором
      // или оценкой, показывает в журнале, какой адрес у неё был и чем
      // кончилась проверка.
      const emailPatch = {
        recipient_email: email.email,
        email_type: email.emailType,
        email_verification: email.verification,
        email_source_url: email.sourceUrl,
        recipient_role: email.recipientRole,
        is_routing: email.isRouting,
      };
      if (email.verification === 'unverified') {
        // Почта не проверена — строка сразу очень спорная и дальше не идёт:
        // разбор ИИ, ФНС и новости ей не оплачиваем, письма не пишем. Решает
        // человек по выгрузке «очень спорные». Как отсев, она задержана на шаге
        // почты: в воронке «Почту» не проходит (results/route.ts).
        const doubts = unverifiedEmailDoubts(email.email);
        doubtful.count += 1;
        await updateRow(id, {
          ...emailPatch,
          doubt_flags: doubts.flags,
          doubt_detail: doubts.detail.join('; '),
          row_status: 'doubtful',
          pipeline_stage: 'recipient_resolved',
          reason_code: null,
          reason_detail: null,
        });
        if (smtpSilent) throw smtpSilentError();
        return null;
      }
      await updateRow(id, { ...emailPatch, pipeline_stage: 'recipient_resolved' });
      reach(tally, 'recipient_resolved');
      return { id, tally, candidate: c, domain, website: site_url, amo: amoRec, reactivation, email, cards };
    };

    // ── Шаг 2 (дешёвый ИИ): вакансии, сайт, ползунки, ФНС, новости, оффер, оценка, сомнения ──
    const analyze = async (p: Prepared, size: SizeIndex): Promise<Qualified | null> => {
      const { id, tally, candidate: c, domain, website: site_url, amo: amoRec, reactivation, email } = p;

      // Вакансии hh: живая карточка и цитата функции продаж.
      let vacancy: VacancyAnalysis | null = null;
      const signals: Signal[] = [...c.signals];
      if (c.vacancies.length) {
        // Смотрим до двух свежих карточек: у компании может быть и РОП, и SDR —
        // строгий SDR-сигнал ищем среди всех, одна компания = одна цепочка.
        let broad: Signal | null = null;
        for (const ref of c.vacancies.slice(0, MAX_VACANCY_CARDS)) {
          const card = await liveCard(ref, p.cards);
          if (!card) continue;
          // Пока качалась карточка, соседние потоки могли дотратить до запаса
          // под шаблоны: платный разбор компании не начинаем, строка вернётся
          // в необработанные (safe()). Уже начатый (разобрана первая
          // вакансия) доводим: деньги за него потрачены.
          if (!vacancy && !analysisBudgetLeft()) throw new BudgetExceededError('Осталось только на шаблоны цепочек — новый разбор не начинаем');
          let analysis: VacancyAnalysis;
          try {
            analysis = await analyzeVacancy({ title: card.title, description: card.descriptionText, companyName: c.companyName });
          } catch (err) {
            // ИИ не ответил (или ответил без главных полей) — отсев с честной
            // причиной. Лимит, ключ и прочее — выше, в safe().
            if (!(err instanceof LlmCallError)) throw err;
            await finish(id, { stage: 'enriched', status: 'rejected', reason: 'LLM_FAILED', detail: `разбор вакансии: ${err.message}`.slice(0, 500) });
            noteLlmFailed();
            return null;
          }
          if (analysis.excludedCategory === 'recruitment_agency' || analysis.excludedCategory === 'leadgen_competitor') {
            await finish(id, { stage: 'enriched', status: 'rejected', reason: 'EXCLUDED_CATEGORY', detail: analysis.excludedCategory });
            return null;
          }
          vacancy ??= analysis;

          // Строгий SDR (Максим 23.09, SDR_ENTERPRISE_PROOF_AND_OFFER_ROUTING §3):
          // роль первичного outbound И цитата холодного поиска новых B2B-клиентов.
          const duty = analysis.sdrQuote ?? findStrictOutboundDuty(`${card.title}\n${card.descriptionText}`);
          const sdrTitle = isSdrRoleTitle(card.title);
          const inboundOnly = analysis.excludedCategory === 'inbound_retail_only' || analysis.excludedCategory === 'b2c_only';
          if (sdrTitle && duty && analysis.isB2b && !inboundOnly) {
            vacancy = analysis;
            signals.push({
              type: 'sales_hiring', source: 'hh', title: card.title, date: card.publishedAt, url: card.url, quote: duty, level: 'A',
              meta: { vacancy_count: c.vacancyCount, role_match_rule: 'sdr_title+b2b_outbound_duty', override_reason: 'strict_sdr_signal' },
            });
            broad = null;
            break;
          }
          // Обычная вакансия продаж — не повод для SDR-цепочки: компания идёт
          // по остальным поводам. Причину храним для отчёта «сколько ушло в общую очередь».
          broad ??= {
            type: 'sales_hiring_broad', source: 'hh', title: card.title, date: card.publishedAt, url: card.url, quote: duty ?? null, level: 'C',
            meta: {
              sdr_override: false,
              non_sdr_reason: !sdrTitle ? 'title_not_sdr' : !duty ? 'no_b2b_outbound_duty' : inboundOnly ? 'inbound_or_b2c' : 'not_b2b',
            },
          };
        }
        if (broad) signals.push(broad);
        if (signals.some((s) => s.type === 'sales_hiring')) {
          sdr.any_sales_vacancy += 1;
          sdr.strict_sdr += 1;
          tally.sdr = 'strict';
        } else if (broad) {
          sdr.any_sales_vacancy += 1;
          sdr.broad_to_general_queue += 1;
          tally.sdr = 'broad';
        }
      }

      // Сайт: один обход, один разбор — или готовый разбор из кэша за 30 дней.
      // Не открылся — SITE_UNREACHABLE. ИИ не ответил — LLM_FAILED: сайт мог
      // быть в порядке, и прятать сбой ИИ под «сайт не открылся» нельзя.
      // Лимит, ключ и ошибки кода — выше, в safe().
      let site: SiteAnalysis;
      try {
        site = await analyzeSite(site_url, domain);
      } catch (err) {
        if (!(err instanceof LlmCallError)) throw err;
        log('warn', `site analysis LLM failed for ${domain}`, err.message);
        await finish(id, { stage: 'enriched', status: 'rejected', reason: 'LLM_FAILED', detail: `разбор сайта: ${err.message}`.slice(0, 500) }, { signals });
        noteLlmFailed();
        return null;
      }
      if (!site.reachable) {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: 'SITE_UNREACHABLE', detail: site_url }, { signals });
        return null;
      }
      if (site.excludedCategory) {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: site.excludedCategory === 'b2c_only' ? 'NOT_B2B' : 'EXCLUDED_CATEGORY', detail: site.excludedCategory });
        return null;
      }
      const since = Date.now() - config.freshness_days * DAY;
      for (const f of site.facts) {
        const standing = f.type === 'partner_program' || f.type === 'dealer_search';
        if (standing || (f.date && new Date(f.date).getTime() >= since)) signals.push(f);
      }
      const isB2b = site.isB2b || Boolean(vacancy?.isB2b && vacancy.b2bQuote) || signals.some((s) => s.type === 'contract_won' || s.type === 'trade_show_exhibitor');
      if (!isB2b || vacancy?.excludedCategory === 'b2c_only') {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: 'NOT_B2B' }, { signals, ta_score: site.taScore, ta_reason: site.taReason });
        return null;
      }
      // Бренд: у кандидата из Директа есть только домен — название берём со страницы.
      const onlyDomainName = c.companyName === domain;
      const brand = site.brand ?? (onlyDomainName ? null : companyBrand(c.companyName));
      if (!brand) {
        await finish(id, { stage: 'enriched', status: 'rejected', reason: 'COMPANY_AMBIGUOUS' }, { signals });
        return null;
      }
      reach(tally, 'enriched');

      const known = c.inn ? size.get(c.inn) : undefined;
      let revenue = c.revenue ?? known?.revenue ?? null;
      const employees = c.employees ?? known?.employees ?? null;

      // Ползунки размера и похожести режут все источники; неизвестный размер не отсеиваем.
      // Дешёвые отсевы — до платных по времени ФНС и новостей. Реактивацию не режем и не обогащаем.
      const sizeRejected = async (): Promise<boolean> => {
        const tooSmall = (revenue !== null && revenue < config.min_revenue) || (employees !== null && employees < config.min_employees);
        const tooBig = revenue !== null && revenue > config.max_revenue;
        if (!tooSmall && !tooBig) return false;
        await finish(id, {
          stage: 'scored', status: 'rejected', reason: 'SIZE_OUT_OF_RANGE',
          detail: `выручка ${revenue ?? '—'}, штат ${employees ?? '—'}`,
        }, { signals, company_brand: brand, ta_score: site.taScore, ta_reason: site.taReason });
        return true;
      };
      if (!reactivation) {
        if (site.taScore < config.min_ta_score) {
          await finish(id, { stage: 'scored', status: 'rejected', reason: 'TA_TOO_LOW', detail: `ЦА ${site.taScore}/10 при пороге ${config.min_ta_score}` }, { signals, company_brand: brand, ta_score: site.taScore, ta_reason: site.taReason });
          return null;
        }
        if (await sizeRejected()) return null;

        // Рост выручки по ФНС: повод и, если размер был неизвестен, выручка.
        const inn = c.inn;
        if (inn && config.sources.includes('revenue_growth')) {
          const fact = await enrich('revenue_growth', `fns revenue ${inn}`, () => fetchRevenue(db, inn));
          if (fact) {
            if (fact.revenue != null && revenue === null) {
              revenue = fact.revenue;
              if (await sizeRejected()) return null;
            }
            const growth = revenueGrowthSignal(fact);
            if (growth) signals.push(growth);
          }
        }

        if (config.sources.includes('news')) {
          const news = await enrich('news', `news ${domain}`, () => findNewsSignals(brand, config.freshness_days));
          if (news) signals.push(...news);
        }
      }

      const picked = routeChain({
        signals,
        reactivation,
        taScore: site.taScore,
        freshnessDays: config.freshness_days,
        revenue,
        employees,
        hasAdPixel: site.hasAdPixel,
        hasCaseFor: (chain) => Boolean(routeCase(libraries.cases, site.industryGroup, chain)),
      });
      const marketQuote = vacancy?.marketQuote ?? site.customerQuote ?? null;
      const base = {
        company_brand: brand,
        signals,
        amo_status: amoRec?.status ?? 'none',
        prior_contact: reactivation,
        prior_contact_date: reactivation ? amoRec?.lastContactAt ?? null : null,
        ta_score: site.taScore,
        ta_reason: site.taReason,
        market_evidence_quote: marketQuote,
        target_market: vacancy?.targetMarket ?? null,
        fit_reasons: [
          ...(site.b2bQuote ? [`B2B: «${site.b2bQuote}»`] : []),
          ...(site.productSummary ? [`Продукт: ${site.productSummary}`] : []),
          ...(site.industryGroup ? [`Отрасль: ${site.industryGroup}`] : []),
          ...(site.hasAdPixel ? ['На сайте стоят рекламные счётчики'] : []),
        ],
      };
      if (!picked) {
        await finish(id, { stage: 'scored', status: 'rejected', reason: 'NO_CHAIN', detail: `ЦА ${site.taScore}/10` }, base);
        return null;
      }
      // Сплит 50/50: половина подходящих компаний получает «Автоматизированный аутрич».
      const route = splitAutomation(picked, domain, { signals, reactivation, isB2b, marketQuote });
      const caseHit = routeCase(libraries.cases, site.industryGroup, route.chain);
      const score = scoreCompany({
        // Скоринг — по исходной цепочке, чтобы сплит не менял, кто проходит порог.
        chain: picked.chain,
        primary: route.primary,
        freshnessDays: config.freshness_days,
        taScore: site.taScore,
        isB2b,
        revenue,
        employees,
        hasAdPixel: site.hasAdPixel,
        siteReachable: true,
        // SDR-цепочке кейс по отрасли не нужен (Максим 23.09): письмо 2 —
        // механика, балл за доказательство не снимаем.
        hasCase: picked.chain === 'hiring' || Boolean(routeCase(libraries.cases, site.industryGroup, picked.chain)),
        // Почта уже найдена и прошла проверку (или это контакт из AMO) — шаг 1.
        emailFound: true,
      });
      chains[route.chain] = (chains[route.chain] ?? 0) + 1;
      tally.chain = route.chain;
      const primary = route.primary;
      const patch = {
        ...base,
        chain_type: route.chain,
        signal_type: primary?.type ?? null,
        signal_date: primary?.date ?? null,
        signal_title: primary?.title ?? null,
        source_url: primary?.url ?? c.sourceUrls[0] ?? null,
        evidence_quote: primary?.quote ?? null,
        evidence_level: primary ? primary.level : 'NONE',
        generation_mode: route.chain,
        route_reason: route.reason,
        route_runner_up: route.runnerUp,
        case_id: caseHit?.record.case_id ?? null,
        case_match_reason: caseHit?.reason ?? null,
        priority_score: score.total,
        signal_score: score.total,
        fit_reasons: [...base.fit_reasons, `Скоринг: ${Object.entries(score.parts).map(([k, v]) => `${k}=${v}`).join(', ')}`],
      };
      const decision = decide(score.total, config.write_threshold);
      if (decision === 'skip') {
        await finish(id, { stage: 'scored', status: 'rejected', reason: 'SCORE_TOO_LOW', detail: `${score.total}/100` }, patch);
        return null;
      }

      // Сомнения — до писем: все признаки уже известны. Очень спорная строка
      // писем не получает, в Instantly не идёт и места в лимите готовых не
      // занимает — ищем дальше. Почему она спорная — в doubt_detail и в выгрузке.
      const doubts = computeDoubts({
        email: email.email,
        emailType: email.emailType,
        score: score.total,
        writeThreshold: config.write_threshold,
        chain: baseChain(route),
        primary: route.primary,
        b2bQuoted: Boolean(site.b2bQuote || vacancy?.b2bQuote),
        sourceName: c.companyName,
        brand,
        sourceIsDomainOnly: onlyDomainName,
      });
      const doubtPatch = { doubt_flags: doubts.flags, doubt_detail: doubts.detail.join('; ') || null };
      if (doubts.veryDoubtful) {
        // Как отсев, очень спорная задержана на оценке: в воронке «Оценку» не проходит.
        doubtful.count += 1;
        await updateRow(id, { ...patch, ...doubtPatch, row_status: 'doubtful', pipeline_stage: 'scored', reason_code: null, reason_detail: null });
        return null;
      }
      await updateRow(id, { ...patch, ...doubtPatch, pipeline_stage: 'scored' });
      reach(tally, 'scored');
      return { id, tally, domain, brand, amo: amoRec, email, site, vacancy, signals, route, caseHit, score, marketQuote, doubts };
    };

    /**
     * Запуск остановлен или падает — строку дальше не доводим: её письма и
     * «готово» легли бы после итоговой записи, и счётчики запуска разошлись бы
     * с журналом. Проверка — после каждого ожидания шага писем (шаблон,
     * гипотеза).
     */
    const lettersStillWanted = () => {
      if (runAbort.signal.aborted) throw new CancelledError();
    };
    // Гипотеза сегментов для письма 3 без кейса — дешёвой моделью. Она
    // необязательна: без неё письмо 3 — механика. Поэтому и исчерпанный лимит
    // на ИИ строку не останавливает — письма собираем без гипотезы, уже
    // оплаченный разбор не пропадает. Неверный ключ — про весь запуск, его
    // отдаём в safe(). Остановка запуска — тоже: оборванная гипотеза не
    // превращается в «письма без гипотезы», строка не доводится до готовой.
    const skipHypothesis = () => {
      if (!hypothesisSkipLogged) {
        hypothesisSkipLogged = true;
        log('info', `job ${jobId}: LLM budget exhausted — letters go without the segments hypothesis`);
      }
      return null;
    };
    const segmentsHypothesis = async (req: { brand: string; productSummary: string | null; marketQuote: string }): Promise<SegmentsHypothesis | null> => {
      lettersStillWanted();
      if (budget.exhausted()) return skipHypothesis();
      return buildSegmentsHypothesis(req).catch((err: unknown) => {
        if (err instanceof LlmAuthError || err instanceof CancelledError) throw err;
        lettersStillWanted();
        if (err instanceof BudgetExceededError) return skipHypothesis();
        // Ключа в тексте нет: клиент аутричей вычищает его из ошибок.
        log('warn', `segments hypothesis failed for ${req.brand}: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      });
    };

    // Места в лимите готовых для писем, которые сейчас собираются. Между
    // проверкой лимита и готовой строкой — ожидание шаблона оффера (писатель
    // пишет до нескольких минут): без мест все потоки пула прошли бы проверку
    // разом, готовых вышло бы больше заказанного, а за шаблон оффера, чьи
    // компании всё равно уйдут в LIMIT_REACHED, мы бы заплатили. Строка без
    // места ждёт: место освободится, если письма соседа не выйдут, — в
    // LIMIT_REACHED она уходит, только когда лимит действительно набран (как у
    // английского аутрича).
    let lettersInFlight = 0;
    let slotWaiters: Array<() => void> = [];
    const takeLettersSlot = async (): Promise<boolean> => {
      for (;;) {
        if (totals.ready >= target) return false;
        if (totals.ready + lettersInFlight < target) {
          lettersInFlight += 1;
          return true;
        }
        await new Promise<void>((resolve) => slotWaiters.push(resolve));
      }
    };
    const releaseLettersSlot = () => {
      lettersInFlight -= 1;
      const waiting = slotWaiters;
      slotWaiters = [];
      for (const wake of waiting) wake();
    };

    /** Признаки сомнения с оценки — без признака шага писем (строка собирается заново). */
    const scoringDoubts = (q: Qualified) => ({ doubt_flags: q.doubts.flags, doubt_detail: q.doubts.detail.join('; ') || null });

    // ── Шаг 3: письма и QA — только прошедшим порог и не очень спорным ──
    const finalize = async (q: Qualified) => {
      // Строка ждала шаблон, который модель не написала, и собирается заново:
      // из ждущих и очень спорных она выходит (вернётся, если шаблон опять не
      // выйдет).
      const retry = parkedIds.delete(q.id);
      if (retry) {
        awaiting.count -= 1;
        doubtful.count -= 1;
      }
      // Лимит готовых набран — строка оценку прошла, а до писем не дошла: стоит
      // на этапе писем, воронка (funnel.ts) считает её до «Оценки» включительно.
      if (!(await takeLettersSlot())) {
        await finish(q.id, { stage: 'sequence_assembled', status: 'manual_review', reason: 'LIMIT_REACHED', detail: 'лимит готовых компаний уже набран' }, scoringDoubts(q));
        return;
      }
      try {
        await buildLetters(q);
      } catch (err) {
        // Повтор записи шаблона упёрся в лимит на ИИ: в базе строка не
        // менялась и по-прежнему ждёт шаблон — оставляем её так, а не в
        // необработанные (её разбор оплачен, «Переписать цепочку» её поднимет).
        if (retry && err instanceof BudgetExceededError) {
          budgetStop = true;
          awaiting.count += 1;
          doubtful.count += 1;
          return;
        }
        throw err;
      } finally {
        releaseLettersSlot();
      }
    };

    /** Письма строки с занятым местом в лимите готовых. */
    const buildLetters = async (q: Qualified) => {
      // Шаблон цепочки оффера: пишется, когда до писем дошла первая компания
      // оффера; остальные ждут тот же промис. Лимит на ИИ до записи шаблона —
      // BudgetExceededError: строка возвращается в необработанные (safe()).
      const template = await templates.get(q.route.chain);
      lettersStillWanted();
      const scoringDetail = q.doubts.detail.join('; ') || null;
      if (template.status !== 'ok' || !template.letters) {
        // Шаблон оффера не прошёл проверку или не написан — письма собирать не
        // из чего. Строка очень спорная и стоит на этапе писем (оценку прошла,
        // писем нет); «Переписать цепочку» найдёт её по TEMPLATE_FAILED. Она
        // идёт в счёт заказанного числа (awaiting). Модель не ответила и
        // повтора ещё не было — строка соберётся заново на следующей волне.
        doubtful.count += 1;
        awaiting.count += 1;
        if (template.error && !retriedChains.has(q.route.chain)) {
          parkedIds.add(q.id);
          parked.set(q.route.chain, [...(parked.get(q.route.chain) ?? []), q]);
        }
        await updateRow(q.id, {
          ...withLettersDoubt(q.doubts.flags, scoringDetail, 'TEMPLATE_FAILED', templateDoubtText(template)),
          chain_template_id: template.id,
          row_status: 'doubtful',
          pipeline_stage: 'sequence_assembled',
          reason_code: null,
          reason_detail: null,
        });
        // Строка записана — теперь предохранитель: писатель молчит серией, валим запуск.
        noteTemplate(template);
        return;
      }
      noteTemplate(template);
      const composed = await composeCompanyLetters(
        template.letters,
        {
          chain: q.route.chain,
          brand: q.brand,
          isRouting: q.email.isRouting,
          primary: q.route.primary,
          signals: q.signals,
          priorContact: baseChain(q.route) === 'reactivation',
          baseChain: q.route.from,
          marketQuote: q.marketQuote,
          productSummary: q.site.productSummary,
          targetMarket: q.vacancy?.targetMarket ?? null,
          caseRecord: q.caseHit?.record ?? null,
          recipientEmail: q.email.email,
          amoStatus: q.amo?.status ?? null,
        },
        { sender, claims: libraries.claims, hypothesis: segmentsHypothesis },
      );
      lettersStillWanted();
      reach(q.tally, 'sequence_assembled');
      // Признаки сомнения с оценки письма не трогают — только добавляют свой,
      // если письма не прошли проверку. Второй темы (subject_b) у шаблона нет.
      const base = {
        letters: composed.letters,
        subject_b: null,
        case_id: composed.caseId,
        campaign_hypothesis: composed.hypothesisText,
        offer_version: libraries.offerVersion,
        offer_claim_ids: composed.claimIds,
        sender_id: sender.id,
        template_version: TEMPLATE_VERSION,
        chain_template_id: template.id,
        qa_status: composed.qa.status,
        qa_flags: composed.qa.flags,
      };
      if (composed.qa.status !== 'passed') {
        // Письма собраны, но автопроверку не прошли — очень спорная: в рассылку
        // не идёт, письма остаются в строке, решает человек. Стоит на проверке
        // писем: воронка считает её до «Цепочки» включительно.
        doubtful.count += 1;
        await updateRow(q.id, {
          ...base,
          ...withLettersDoubt(q.doubts.flags, scoringDetail, 'LETTERS_QA_FAILED', lettersQaDoubtText(composed.qa.flags)),
          row_status: 'doubtful',
          pipeline_stage: 'qa_checked',
          reason_code: null,
          reason_detail: null,
        });
        return;
      }
      reach(q.tally, 'qa_checked');
      // Письма готовы и проверены, но лимит набран: с местами в лимите так не
      // бывает — страховка. Строка стоит на «Готово», воронка считает её до
      // проверки писем включительно.
      if (totals.ready >= target) {
        await finish(q.id, { stage: 'ready', status: 'manual_review', reason: 'LIMIT_REACHED', detail: 'лимит готовых компаний уже набран' }, { ...base, ...scoringDoubts(q) });
        return;
      }
      totals.ready += 1;
      reach(q.tally, 'ready');
      // Признаки сомнения — с оценки: у строки, ждавшей шаблон, в базе ещё стоит
      // TEMPLATE_FAILED.
      await updateRow(q.id, { ...base, ...scoringDoubts(q), row_status: 'ready', pipeline_stage: 'ready', reason_code: null, reason_detail: null });
    };

    const safe = async (id: string, tally: Tally, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        if (err instanceof CancelledError) throw err;
        if (err instanceof LlmAuthError || err instanceof LlmSilentError || err instanceof SmtpSilentError) {
          // Ключ не работает, ИИ или проверка почт молчат серией — так же
          // упадёт каждая строка. Валим запуск целиком.
          halted = true;
          throw err;
        }
        if (err instanceof BudgetExceededError) {
          // Лимит на ИИ: строка не отсеяна и не сломана — она не обработана.
          // Вклад в счётчики вычитаем, саму строку в конце уберём из журнала
          // вместе с остальными необработанными.
          budgetStop = true;
          await returnToPool(id, tally);
          return;
        }
        reasons.PROCESSING_ERROR = (reasons.PROCESSING_ERROR ?? 0) + 1;
        await updateRow(id, { row_status: 'failed', reason_code: 'PROCESSING_ERROR', reason_detail: err instanceof Error ? err.message.slice(0, 500) : String(err) });
      } finally {
        // Шаг строки, а не строка: строка, дошедшая до писем, считается трижды —
        // счётчик нужен только для частоты публикаций.
        processed += 1;
        // Запуск уже падает — прогресс не публикуем, итог запишет обработчик сбоя.
        if (!halted && processed % 5 === 0) await publish(phase);
      }
    };

    /**
     * Стоп по лимиту убрал из журнала необработанные строки. «Повтор компании
     * в запуске», чья строка-оригинал среди них, остался бы повтором записи,
     * которой в журнале нет, — а повторный запуск возьмёт компанию заново.
     * Такие повторы убираем вместе с ней; повтор, у которого жив хоть один
     * оригинал (по домену или ИНН), остаётся.
     */
    const dropOrphanDuplicates = async (droppedIds: ReadonlySet<string>) => {
      const orphans = duplicates.filter((d) => d.owners.every((o) => droppedIds.has(o)));
      for (let i = 0; i < orphans.length; i += DB_CHUNK) {
        const chunk = orphans.slice(i, i + DB_CHUNK);
        const { data, error } = await db
          .from('polza_ru_outreach_companies')
          .delete()
          .eq('job_id', jobId)
          .eq('reason_code', 'DUPLICATE_COMPANY')
          .in('id', chunk.map((d) => d.id))
          .select('id');
        if (error) {
          log('warn', `job ${jobId}: orphan duplicates cleanup failed`, error);
          continue;
        }
        const gone = new Set((data ?? []).map((r) => String(r.id)));
        for (const d of chunk) {
          if (!gone.has(d.id)) continue;
          untally(d.tally);
          const left = (reasons.DUPLICATE_COMPANY ?? 0) - 1;
          if (left > 0) reasons.DUPLICATE_COMPANY = left;
          else delete reasons.DUPLICATE_COMPANY;
          totals.scanned = Math.max(0, totals.scanned - 1);
        }
      }
    };

    /**
     * Шаг писем: pre-LPR rerank, от самых сильных к слабым. Лимит на ИИ здесь
     * не проверяем: по готовому шаблону оффера письма бесплатны, а
     * необязательную гипотезу сегментов после лимита просто пропускаем — уже
     * оплаченный разбор доводим до готовых. Шаблон, который ещё не написан,
     * после лимита не написать: такие строки вернутся в необработанные
     * (BudgetExceededError в safe()). Сюда же — строки, чей шаблон модель не
     * написала на прошлой волне: шаблон пишется ещё раз, один на оффер.
     */
    const lettersStep = async (fresh: Qualified[]) => {
      const again = templates.retryFailed();
      const retryRows: Qualified[] = [];
      for (const chain of again) {
        retriedChains.add(chain);
        retryRows.push(...(parked.get(chain) ?? []));
        parked.delete(chain);
      }
      if (again.length) {
        log('info', `job ${jobId}: writing chain templates again after the model did not answer: ${again.join(', ')} (${retryRows.length} rows waiting)`);
      }
      // При равной оценке — сначала ждавшие с прошлой волны: они раньше в пуле
      // и уже разобраны (сортировка устойчивая).
      const rows = [...retryRows, ...fresh].sort((a, b) => b.score.total - a.score.total);
      phase = 'writing_letters';
      await publish(phase, { qualified: fresh.length });
      // Шаблоны офферов — заранее и все сразу: иначе четыре потока писем ждали
      // бы писателя по очереди, оффер за оффером. Только офферы строк, которым
      // хватит мест в лимите готовых, — за лишний оффер не платим. Ошибку
      // записи увидит строка оффера в finalize.
      if (!halted) {
        const room = Math.max(0, target - totals.ready);
        for (const chain of new Set(rows.slice(0, room).map((q) => q.route.chain))) {
          templates.get(chain).catch(() => undefined);
        }
      }
      await runPool(rows, LETTERS_CONCURRENCY, async (q) => {
        if (halted) return;
        await ensureNotCancelled();
        await safe(q.id, q.tally, () => finalize(q));
      });
    };

    // Строки, ждущие шаблон оффера, — в счёт заказанного: их поднимет
    // «Переписать цепочку», и разбор сверх этого — выброшенные деньги.
    while (totals.ready + awaiting.count < target && totals.scanned < maxScan && cursor < pool.length) {
      // Лимит на ИИ исчерпан — новую волну не начинаем: её строкам нужен разбор.
      // Внутри волны шаг почты ИИ не тратит, поэтому лимит в нём не кончается.
      if (stopForBudget()) break;
      await ensureNotCancelled();
      waveNo += 1;
      const want = Math.min(nextWaveSize(target, { scanned: totals.scanned, ready: totals.ready + awaiting.count }), maxScan - totals.scanned);
      const wave = pool.slice(cursor, cursor + want);
      cursor += wave.length;

      const ids: string[] = [];
      for (let i = 0; i < wave.length; i += DB_CHUNK) {
        const chunk = wave.slice(i, i + DB_CHUNK);
        const { data, error } = await db
          .from('polza_ru_outreach_companies')
          .insert(
            chunk.map((c) => ({
              job_id: jobId,
              source_type: c.sources.join('+'),
              source_record_id: c.sourceRecordId,
              source_url: c.sourceUrls[0] ?? null,
              source_urls: c.sourceUrls,
              company_name: c.companyName,
              inn: c.inn,
              hh_employer_id: c.hhEmployerId,
              crm_lead_id: c.amo?.amoId ?? null,
              signals: c.signals,
              row_status: 'processing',
              pipeline_stage: 'candidates_loaded',
            })),
          )
          .select('id');
        if (error) throw new Error(`journal insert failed: ${error.message}`);
        for (const r of data ?? []) ids.push(String(r.id));
      }
      totals.scanned += wave.length;
      const size: SizeIndex = await loadSizeByInn(db, wave.map((c) => c.inn).filter((x): x is string => Boolean(x)));
      phase = 'finding_emails';
      await publish(phase, { wave_size: wave.length });
      log('info', `wave ${waveNo}: ${wave.length} candidates (ready ${totals.ready}/${target})`);

      // Шаг 1: бесплатные проверки и почта — у всей волны.
      const prepared: Prepared[] = [];
      await runPool(wave.map((c, i) => ({ c, id: ids[i] })).filter((x) => x.id), EMAIL_CONCURRENCY, async ({ c, id }) => {
        if (halted) return;
        await ensureNotCancelled();
        const tally = newTally(id);
        await safe(id, tally, async () => {
          const p = await prepare(id, c, tally);
          if (p) prepared.push(p);
        });
      });

      // Шаг 2: разбор ИИ — только у компаний с рабочей почтой.
      const qualified: Qualified[] = [];
      phase = 'enriching';
      await publish(phase, { with_email: prepared.length });
      await runPool(prepared, ENRICH_CONCURRENCY, async (p) => {
        if (halted) return;
        if (stopForBudget()) {
          // Лимит на ИИ исчерпан (или остался только запас под шаблоны) —
          // разбор не начинаем. Почту строка прошла, но этот шаг бесплатный, а
          // без разбора она ни отсеяна, ни готова: возвращаем в необработанные,
          // как строку, которую лимит прервал (в конце уйдёт из журнала,
          // повторный запуск возьмёт её заново) — вклад в воронку вычитаем,
          // домен и ИНН освобождаем.
          await returnToPool(p.id, p.tally);
          return;
        }
        await ensureNotCancelled();
        await safe(p.id, p.tally, async () => {
          const q = await analyze(p, size);
          if (q) qualified.push(q);
        });
      });

      // Шаг 3: письма.
      await lettersStep(qualified);
    }

    // Волн больше не будет, а строки ждут шаблон, который модель не написала:
    // повтор записи им положен — сейчас, один раз. Лимит исчерпан — писать не
    // на что, строки ждут «Переписать цепочку».
    if (!halted && parked.size && !budget.exhausted()) {
      await ensureNotCancelled();
      await lettersStep([]);
    }

    // Пока добегала последняя волна, запуск могли остановить — не перетираем «Остановлено».
    await ensureNotCancelled();
    if (budgetStop) {
      // Строки, до которых из-за лимита не дошли или которые он прервал, — не
      // отсев и не ошибка. Среди них и прошедшие почту, но не успевшие к
      // разбору ИИ: почта бесплатна и готовой строку не делает. Убираем их из
      // журнала: воронка и «просмотрено» считают только то, что действительно
      // разобрали. Повторный запуск возьмёт эти компании заново.
      const { data: dropped, error: dropErr } = await db
        .from('polza_ru_outreach_companies')
        .delete()
        .eq('job_id', jobId)
        .eq('row_status', 'processing')
        .select('id');
      if (dropErr) log('warn', `job ${jobId}: unprocessed rows cleanup failed`, dropErr);
      else {
        const droppedIds = new Set((dropped ?? []).map((r) => String(r.id)));
        totals.scanned = Math.max(0, totals.scanned - droppedIds.size);
        await dropOrphanDuplicates(droppedIds);
      }
    }

    // awaiting_templates — заказанное набрано вместе с компаниями, которые
    // ждут «Переписать цепочку»: разбор новых компаний на этом остановлен.
    // stop_reason_base — причина, какой она была бы без ждущих (null — волны
    // шли бы дальше): если после «Переписать цепочку» ждущих не хватит до
    // заказанного, экран покажет её (regenerate.ts).
    const baseReason = budgetStop ? 'budget' : cursor >= pool.length ? 'pool_exhausted' : totals.scanned >= maxScan ? 'scan_limit' : null;
    const stopReason = totals.ready >= target
      ? 'target_reached'
      : totals.ready + awaiting.count >= target
        ? 'awaiting_templates'
        : baseReason ?? 'scan_limit';
    // Шаблон, начатый заранее для компаний, которые ушли в LIMIT_REACHED, ещё
    // пишется — его расход часть итога: дожидаемся (запуск пока идёт).
    const settled = await settleCalls(COMPLETED_SETTLE_MS);
    const spend = budget.snapshot({ includeReserved: !settled });
    log('info', `job ${jobId} done: scanned=${totals.scanned} ready=${totals.ready}/${target} (${stopReason}), llm $${spend.spent_usd}/$${spend.limit_usd} in ${spend.calls} calls`, { reasons, chains });
    // Тоже только идущему: остановку между проверкой выше и этой записью не перетираем.
    await finishRun({
      status: 'completed',
      progress_stage: 'completed',
      progress_percent: 100,
      total_found: totals.scanned,
      total_parsed: totals.ready,
      completed_at: new Date().toISOString(),
      error_message: null,
      progress_detail: {
        ...detail({ stop_reason: stopReason, ...(stopReason === 'awaiting_templates' ? { stop_reason_base: baseReason } : {}) }),
        llm: spend,
      },
    });
  } catch (err) {
    // Остановка или сбой: идущие вызовы ИИ запуска обрываем — другие офферы
    // писали бы шаблоны (может, и повтор) и тратили деньги, которые итог уже
    // не увидит. Оборванные списываются оценкой сверху; итог расхода — после
    // них, последней записью, она же отпускает аренду.
    if (!runAbort.signal.aborted) runAbort.abort(new CancelledError());
    const settled = await settleCalls(ABORTED_SETTLE_MS);
    const finalDetail = { ...(currentDetail ? currentDetail() : baseDetail()), llm: budget.snapshot({ includeReserved: !settled }) };
    await owner.close();
    if (err instanceof CancelledError) {
      log('info', `job ${jobId} cancelled`);
      // Статус поставил тот, кто остановил; дописываем только итог — сколько
      // успели потратить на ИИ и докуда дошли. Только при своей аренде: после
      // перезапуска воркера запуск мог подхватить новый прогон, его прогресс
      // не трогаем. Запуск всё ещё «идёт» под нашей арендой — его никто не
      // останавливал: failed с понятной причиной, а не «идущий» без воркера.
      await owner.writeCancelled(finalDetail);
      return;
    }
    log('error', `job ${jobId} failed`, err);
    await owner.write({
      status: 'failed',
      progress_stage: 'failed',
      completed_at: new Date().toISOString(),
      error_message: err instanceof Error ? err.message : 'Unknown error',
      progress_detail: finalDetail,
    });
  } finally {
    if (cancelWatch) clearInterval(cancelWatch);
    await owner.close();
  }
}
