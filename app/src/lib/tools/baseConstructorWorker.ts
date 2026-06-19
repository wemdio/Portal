import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  stepRemoveEmpty,
  stepFullDedup,
  stepEmailDedup,
  stepFindEmails,
  stepSplitEmails,
  stepRemoveSupportEmails,
  stepSiteCheck,
  stepEnrich,
  stepTAScore,
  stepNameCleanup,
  stepPersonalize,
  stepValidateEmails,
  FOUND_EMAIL_COL,
  type StepKey,
  type ProgressFn,
  type CancelCheckFn,
} from './processingSteps';
import { extractEmail, findColumnIndex } from './dfybUtils';

const admin = supabaseAdmin!;

interface StepConfig {
  brief?: string;
  prompt?: string;
  column_mapping?: string;
  /**
   * Куда find_emails пишет результат (когда в файле уже есть email-колонка):
   *   - 'separate' (default из UI): новая колонка 'Найденный Email' рядом с исходной;
   *   - 'same' (legacy/explicit choice): дополнение существующей колонки.
   * Если колонки email в исходных данных нет — опция игнорируется, шаг создаёт «Email».
   */
  find_emails_target?: 'same' | 'separate';
  /**
   * Какие email-колонки валидирует validate_emails:
   *   - 'original' (default из UI когда есть только исходная): валидируем исходную;
   *   - 'found': валидируем только «Найденный Email» (создан find_emails в режиме separate);
   *   - 'both': обе колонки. Строка остаётся если хотя бы в одной email прошёл.
   * Имеет смысл только когда find_emails работал в target='separate' и колонок две.
   */
  validate_target?: 'original' | 'found' | 'both';
  /** When true, ta_scoring annotates rows with score+reason but does NOT filter <7. */
  keepAllScored?: boolean;
  onCheckpoint?: (data: string[][]) => Promise<void>;
  onTaScoringStats?: (stats: TaScoringStats) => void;
}

export interface TaScoringStats {
  /** Сколько строк AI реально оценил (включая «Ошибка оценки» = 5). */
  pre_filter_rows: number;
  /** Сколько строк отфильтровалось по порогу (< TA_MIN_SCORE). */
  filtered_out_count: number;
  /** Средний балл по всем оцененным до фильтра (для понимания «было ли что-то релевантное»). */
  pre_filter_avg_score: number;
}

/**
 * Очистка ячеек от управляющих символов и битого UTF-16 перед jsonb-PATCH'ем.
 *
 * Две независимых проблемы, обе ловятся PostgREST'ом как PGRST102
 * «Empty or invalid json» — этой же ошибкой ломаются jobs в production
 * (job 6b7b0bb4 был ровно про это: финальный update упал, файл пустой):
 *
 * 1. **Control-символы** (NUL, LS, PS, FFFE/FFFF и т.д.) — PostgreSQL
 *    отказывается принимать null-байты в jsonb, PostgREST падает
 *    на остальных. Скрапленные описания и AI-ответы — основной источник.
 *
 * 2. **Непарные UTF-16 суррогаты** (\uD800-\uDFFF без партнёра). Появляются
 *    когда String#slice/substring обрезает строку посередине surrogate
 *    pair'а. Типичные источники в нашем пайплайне:
 *      - stepEnrich: `text.slice(0, 2000)` для скрапленного описания
 *        с эмодзи попадает в середину пары;
 *      - AI-ответы (ta_scoring, clean_names, personalization) обрезанные
 *        по max_tokens в OpenRouter — модель не догенерила low surrogate.
 *    Аналогичный фикс уже стоит в tgParserJobWorker.ts:40-60.
 *
 * Контрольные через regex (быстрый native pass), суррогаты — через
 * char-by-char loop ТОЛЬКО если SURROGATE_RE нашёл хоть один кодпоинт
 * в диапазоне. Для B2B-баз без эмодзи это два дешёвых regex-теста.
 *
 * Замена на пустую строку / пробел: данные не критичны для CSV-выгрузки,
 * важнее чтобы jsonb принял весь массив целиком.
 */
// Через RegExp+строку с \u-escape — control-chars в /.../ литерале
// TypeScript парсит как «Unterminated regular expression literal».
// Сохраняем \t, \n, \r — они допустимы в jsonb.
const PROBLEMATIC_CHARS_RE = new RegExp(
  '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u2028\u2029\uFFFE\uFFFF]',
  'g',
);
const HAS_SURROGATE_RE = new RegExp('[\uD800-\uDFFF]');

function sanitizeCell(cell: string): string {
  // 1) Control chars — пройдёмся быстрым native regex'ом.
  const noCtl = cell.replace(PROBLEMATIC_CHARS_RE, '');
  // 2) Fast-path: суррогатов нет вообще — не идём в per-codepoint loop.
  // Для B2B-баз с обычным кириллическим/латинским текстом это норма.
  if (!HAS_SURROGATE_RE.test(noCtl)) return noCtl;
  // 3) Walk char-by-char, валидные пары оставляем, орфаны → пробел.
  let out = '';
  for (let i = 0; i < noCtl.length; i += 1) {
    const ch = noCtl.charCodeAt(i);
    if (ch >= 0xd800 && ch <= 0xdbff) {
      const next = i + 1 < noCtl.length ? noCtl.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += noCtl[i] + noCtl[i + 1];
        i += 1;
      } else {
        out += ' ';
      }
      continue;
    }
    if (ch >= 0xdc00 && ch <= 0xdfff) {
      out += ' ';
      continue;
    }
    out += noCtl[i];
  }
  return out;
}

export function sanitizeRowsForJsonb(rows: string[][]): string[][] {
  let dirty = 0;
  const out = rows.map((row) =>
    row.map((cell) => {
      if (typeof cell !== 'string') return cell;
      const cleaned = sanitizeCell(cell);
      if (cleaned !== cell) dirty += 1;
      return cleaned;
    }),
  );
  if (dirty > 0) {
    console.warn(
      `[base-constructor] sanitized ${dirty} cell(s) with control chars / orphan surrogates before persist`,
    );
  }
  return out;
}

const PERSIST_MAX_ATTEMPTS = 3;
const PERSIST_BASE_DELAY_MS = 1000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry-обёртка над `UPDATE base_constructor_jobs ... WHERE id = ?`.
 *
 * Зачем: 8-часовой job не должен умирать от единичного блипа PostgREST —
 * 502/503/504 от gateway'я, connection-reset, таймаут пула. Без retry'я
 * каждая такая ошибка — failed job и реран всех 8к строк юзером.
 *
 * НЕ серебряная пуля для PGRST102 «Empty or invalid json»: эта ошибка
 * детерминирована для битого payload'a — sanitize выше её и должен ловить.
 * Но retry всё равно крутим унифицированно: иногда PGRST102 возвращается
 * из-за гонки с background VACUUM на jsonb-колонке и второй attempt
 * проходит. ~7s максимум на retry-цикл — мизер на фоне 8 часов работы.
 *
 * Returns: `error: null` при успехе, иначе последняя ошибка после всех попыток.
 * Не throws — caller сам решает, fatal это или нет (persistData логирует
 * и продолжает, финальный update — throws чтобы пометить job как failed).
 */
/** @internal — exported только для тестов; не использовать снаружи модуля. */
export async function updateJobWithRetry(
  jobId: string,
  patch: Record<string, unknown>,
  label: string,
): Promise<{ error: { message: string } | null; ms: number; attempts: number }> {
  const t0 = Date.now();
  let lastError: { message: string } | null = null;
  for (let attempt = 1; attempt <= PERSIST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const { error } = await admin
        .from('base_constructor_jobs')
        .update(patch)
        .eq('id', jobId);
      if (!error) return { error: null, ms: Date.now() - t0, attempts: attempt };
      lastError = { message: error.message };
    } catch (err) {
      // supabase-js обычно возвращает { error }, но network-fail может throw
      // (fetch abort, DNS, TLS). Ловим обоих, чтоб ничего не утекло наружу.
      lastError = { message: err instanceof Error ? err.message : String(err) };
    }
    if (attempt < PERSIST_MAX_ATTEMPTS) {
      const delay = PERSIST_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `[base-constructor][${jobId}] update(${label}) attempt ${attempt}/${PERSIST_MAX_ATTEMPTS} failed: ${lastError?.message}. Retrying in ${delay}ms.`,
      );
      await sleepMs(delay);
    }
  }
  return { error: lastError, ms: Date.now() - t0, attempts: PERSIST_MAX_ATTEMPTS };
}

const CANONICAL_NAMES: Record<string, string> = {
  company: 'компания',
  site: 'сайт',
  email: 'email',
};

function applyColumnMapping(data: string[][], rawMapping?: string): string[][] {
  if (!rawMapping) return data;
  let mapping: Record<string, string>;
  try { mapping = JSON.parse(rawMapping); } catch { return data; }
  if (!mapping || Object.keys(mapping).length === 0) return data;

  const header = [...data[0]];
  for (const [role, originalHeader] of Object.entries(mapping)) {
    const canonical = CANONICAL_NAMES[role];
    if (!canonical) continue;
    const idx = header.findIndex((h) => h.trim() === originalHeader.trim());
    if (idx >= 0 && header[idx].trim().toLowerCase() !== canonical.toLowerCase()) {
      header[idx] = canonical;
    }
  }

  return [header, ...data.slice(1)];
}

async function updateJobProgress(
  jobId: string,
  stepIndex: number,
  stepKey: string,
  progress: number,
) {
  await admin
    .from('base_constructor_jobs')
    .update({
      current_step: stepIndex + 1,
      current_step_key: stepKey,
      current_step_progress: Math.min(100, Math.max(0, Math.round(progress))),
      status: 'processing',
      // Heartbeat: каждое обновление прогресса bumps started_at. Семантика
      // меняется с «когда началось» на «когда была последняя активность».
      // Нужно для resume-логики в autoCompleteIfStuck: если started_at
      // свежий — worker реально работает; если устарел >15 мин — умер,
      // безопасно пере-запустить с этого места.
      started_at: new Date().toISOString(),
    })
    .eq('id', jobId);
}

async function isCancelled(jobId: string): Promise<boolean> {
  const { data } = await admin.from('base_constructor_jobs').select('status').eq('id', jobId).single();
  return data?.status === 'cancelled';
}

type StepRunner = (
  data: string[][],
  onProgress: ProgressFn,
  isCancelled: CancelCheckFn,
  config: StepConfig,
) => Promise<string[][]>;

const STEP_RUNNERS: Record<StepKey, StepRunner> = {
  remove_empty: (data, prog) => stepRemoveEmpty(data, prog),
  dedup_full: (data, prog) => stepFullDedup(data, prog),
  dedup_email: (data, prog) => stepEmailDedup(data, prog),
  clean_names: (data, prog, cancel) => stepNameCleanup(data, prog, cancel),
  find_emails: (data, prog, cancel, cfg) =>
    stepFindEmails(data, prog, cancel, {
      // Default 'separate' выбран в UI: при наличии email-колонки в файле новые
      // скрапленные email НЕ перетирают исходные данные юзера, кладутся отдельно.
      // Legacy-юзер с прежним поведением может явно поставить 'same' в UI.
      target: cfg.find_emails_target ?? 'separate',
      // Прокидываем чекпоинт из cfg — позволяет resume'у на redeploy
      // продолжить find_emails с того места, где упал, а не с нуля.
      // Без этой строчки шаг рестартанул для polza@polza.ru job 55d37e8e
      // (с 84% → 28%) после утреннего деплоя.
      onCheckpoint: cfg.onCheckpoint,
    }),
  split_emails: (data, prog) => stepSplitEmails(data, prog),
  remove_support_emails: (data, prog) => stepRemoveSupportEmails(data, prog),
  validate_emails: (data, prog, cancel, cfg) =>
    stepValidateEmails(data, prog, cancel, {
      validateTarget: cfg.validate_target ?? 'original',
      // onCheckpoint прокидываем из cfg чтобы базовый runner мог
      // персистить промежуточные состояния каждые N строк — иначе
      // resume после redeploy перезапускает весь validate с нуля.
      onCheckpoint: cfg.onCheckpoint,
    }),
  check_sites: (data, prog, cancel) => stepSiteCheck(data, prog, cancel),
  enrich_descriptions: (data, prog, cancel, cfg) => stepEnrich(data, prog, cancel, cfg.onCheckpoint),
  ta_scoring: (data, prog, cancel, cfg) =>
    stepTAScore(data, cfg.brief || '', prog, cancel, {
      keepAllScored: cfg.keepAllScored,
      onStats: cfg.onTaScoringStats,
    }),
  personalization: (data, prog, cancel, cfg) => stepPersonalize(data, cfg.prompt || '', prog, cancel),
};

/**
 * Финальный merge: если в data есть и исходная email-колонка, и FOUND_EMAIL_COL —
 * объединяем их в одну (исходную), удаляем FOUND_EMAIL_COL из header'а и тела.
 *
 * Зачем: юзер хочет получить итоговый файл с одной email-колонкой, даже если
 * на промежуточных шагах мы хранили исходник и scrape-результат раздельно
 * (см. stepFindEmails target='separate'). Merge даёт юзеру свободу выбрать
 * на этапе настройки (1 колонка / 2 раздельные), но **финальный экспорт всегда
 * 1 колонка** — это требование специалиста.
 *
 * Дедуп case-insensitive:
 *   - оригинал: 'Sales@x.ru'
 *   - найденный: 'sales@x.ru, info@x.ru'
 *   - merged: 'Sales@x.ru, info@x.ru' (порядок: исходные, потом найденные;
 *     сохраняем регистр первого вхождения)
 *
 * Безопасно вызывать всегда — если FOUND_EMAIL_COL отсутствует, функция возвращает
 * data как есть (no-op). Если есть FOUND_EMAIL_COL но нет исходной — переименовываем
 * FOUND_EMAIL_COL в 'Email' (странный case, но не теряем данные).
 *
 * @internal — exported только для тестов; не использовать снаружи модуля.
 */
export function mergeFoundEmailColumn(data: string[][]): string[][] {
  if (data.length === 0) return data;
  const header = data[0];
  const foundIdx = header.findIndex((h) => h.trim() === FOUND_EMAIL_COL);
  if (foundIdx < 0) return data; // нечего мерджить

  // Ищем исходную email-колонку (тот же набор alias'ов что и findColumnIndex
  // в шагах). Re-implementируем здесь чтобы не тащить лишний import.
  const aliases = ['email', 'e-mail', 'почта', 'mail'];
  const lower = header.map((h) => h.trim().toLowerCase());
  let originalIdx = -1;
  for (const a of aliases) {
    const idx = lower.indexOf(a);
    if (idx >= 0 && idx !== foundIdx) { originalIdx = idx; break; }
  }

  if (originalIdx < 0) {
    // Нет исходной — просто переименовываем FOUND_EMAIL_COL → 'Email'. Случай
    // редкий (find_emails в режиме separate без исходной колонки не должен
    // создавать FOUND_EMAIL_COL — она бы fallback'нулась в 'Email'). Но
    // защитимся на resume/багов будущего.
    const newHeader = [...header];
    newHeader[foundIdx] = 'Email';
    return [newHeader, ...data.slice(1)];
  }

  // Email-регекс берём такой же как stepSplitEmails — общий паттерн.
  const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

  const mergedBody = data.slice(1).map((row) => {
    const origCell = row[originalIdx] || '';
    const foundCell = row[foundIdx] || '';
    if (!foundCell) {
      // В found-колонке пусто — нечего сливать, оставляем оригинал.
      const out = [...row];
      out.splice(foundIdx, 1);
      return out;
    }
    // Парсим email'ы из обеих ячеек, дедуплицируем case-insensitive с сохранением
    // регистра первого вхождения. Порядок: исходные, потом найденные (юзер так
    // ожидает — «свои» вперёд).
    const seen = new Map<string, string>(); // lowercase → original-case
    const collect = (cell: string) => {
      const matches = cell.match(EMAIL_RE);
      if (!matches) return;
      for (const m of matches) {
        const lc = m.toLowerCase();
        if (!seen.has(lc)) seen.set(lc, m);
      }
    };
    collect(origCell);
    collect(foundCell);
    const merged = [...seen.values()].join(', ');
    const out = [...row];
    out[originalIdx] = merged;
    out.splice(foundIdx, 1);
    return out;
  });

  const newHeader = [...header];
  newHeader.splice(foundIdx, 1);
  return [newHeader, ...mergedBody];
}

export async function runBaseConstructorJob(jobId: string): Promise<void> {
  try {
    const { data: job, error } = await admin
      .from('base_constructor_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !job) throw new Error(`Job not found: ${error?.message}`);

    const selectedSteps: StepKey[] = job.selected_steps || [];
    const stepConfig: StepConfig = job.step_config || {};

    if (selectedSteps.length === 0) throw new Error('Не выбрано ни одного шага');

    // Resume vs fresh-start:
    //   - Свежий запуск (только что POST'нули) — status='pending', current_step ещё 0/null.
    //   - Resume после рестарта — status='processing' и current_step>0; данные
    //     уже частично обработаны и сохранены в job.data между шагами.
    //
    // На resume:
    //   1) пропускаем уже завершённые шаги.
    //   2) если последний активный шаг finished (progress=100) — стартуем
    //      со следующего; если был mid-step (<100) — перезапускаем его же.
    //      Все наши шаги достаточно идемпотентны: enrich_descriptions
    //      фильтрует уже-обогащённые строки по непустому targetDescIdx,
    //      find_emails — по непустому email, dedup/remove_empty —
    //      идемпотентны по определению, ta_scoring и clean_names AI
    //      просто перезапишут.
    const isResume = job.status === 'processing' && (job.current_step ?? 0) > 0;
    const resumeFromStep = isResume
      ? (job.current_step_progress ?? 0) >= 100
        ? job.current_step // последний шаг finished — стартуем со следующего (1-based → как 0-based индекс след. шага)
        : Math.max(0, job.current_step - 1) // mid-step — перезапускаем его
      : 0;

    await admin.from('base_constructor_jobs').update({
      started_at: new Date().toISOString(),
      status: 'processing',
      total_steps: selectedSteps.length,
    }).eq('id', jobId);

    if (isResume) {
      console.log(
        `[base-constructor][${jobId}] RESUMING from step ${resumeFromStep + 1}/${selectedSteps.length} ` +
          `(current_step=${job.current_step}, progress=${job.current_step_progress ?? 0}%)`,
      );
    }

    let data: string[][] = applyColumnMapping(job.data || [], stepConfig.column_mapping);
    if (data.length === 0) throw new Error('Нет данных для обработки');

    const cancelCheck: CancelCheckFn = () => isCancelled(jobId);

    /**
     * Persist `data` to the row, with timing + size + supabase error logging.
     * Без этого факт «update вызвался, но в БД ничего не лежит» был невидимым:
     * supabase-js при неудачном PATCH возвращает `{ error }`, не throw,
     * а вызывающий код раньше его игнорировал. Теперь любая такая молчаливая
     * потеря всплывёт в `[base-constructor]` логах, и можно будет искать
     * по jobId в `docker logs portal`.
     *
     * Retry: updateJobWithRetry — 3 попытки с 1s/2s/4s backoff, защищает от
     * транзитных 5xx/network-блипов в PostgREST gateway. Не throws после
     * исчерпания — persistData продолжает pipeline (на следующем шаге может
     * повезти, плюс finally-блок выше может пометить failed по-другому).
     */
    async function persistData(label: string, payload: string[][]): Promise<void> {
      const sanitized = sanitizeRowsForJsonb(payload);
      const headerCols = sanitized[0]?.length ?? 0;
      const rows = Math.max(0, sanitized.length - 1);
      // Approximate size — JSON.stringify is O(n) but cheap relative to a network round-trip.
      const approxBytes = JSON.stringify(sanitized).length;
      const { error, ms, attempts } = await updateJobWithRetry(
        jobId,
        { data: sanitized },
        `persistData:${label}`,
      );
      if (error) {
        console.error(
          `[base-constructor][${jobId}] persistData(${label}) FAILED in ${ms}ms after ${attempts} attempt(s) — ${error.message} (rows=${rows}, cols=${headerCols}, ~${approxBytes}B)`,
        );
      } else {
        const retryNote = attempts > 1 ? ` (after ${attempts} attempts)` : '';
        console.log(
          `[base-constructor][${jobId}] persistData(${label}) OK in ${ms}ms${retryNote} (rows=${rows}, cols=${headerCols}, ~${approxBytes}B)`,
        );
      }
    }

    let taScoringStats: TaScoringStats | undefined;

    for (let i = resumeFromStep; i < selectedSteps.length; i++) {
      const stepKey = selectedSteps[i];
      const runner = STEP_RUNNERS[stepKey];
      if (!runner) {
        console.warn(`[base-constructor][${jobId}] Unknown step: ${stepKey}, skipping`);
        continue;
      }

      if (await isCancelled(jobId)) return;

      const progressFn: ProgressFn = (progress) => updateJobProgress(jobId, i, stepKey, progress);
      await progressFn(0);

      // Шаги которые мутируют состояние строк И идут >> минуты — у них в
      // памяти worker'а копится прогресс, который без mid-step checkpoint'а
      // теряется при redeploy/crash. Раньше только enrich_descriptions
      // имел checkpoint, find_emails и validate_emails — нет. Реальный
      // случай: polza@polza.ru job 55d37e8e на redeploy потерял find_emails
      // прогресс с 84% → 28% (рестарт с нуля для 4297 строк).
      const stepsNeedingCheckpoint = new Set<string>([
        'enrich_descriptions',
        'find_emails',
        'validate_emails',
      ]);
      const effectiveStepConfig: StepConfig = {
        ...stepConfig,
        ...(stepsNeedingCheckpoint.has(stepKey)
          ? {
              onCheckpoint: async (checkpointData) => {
                await persistData(`checkpoint:${stepKey}`, checkpointData);
              },
            }
          : {}),
        ...(stepKey === 'ta_scoring'
          ? {
              onTaScoringStats: (stats) => {
                taScoringStats = stats;
                console.log(
                  `[base-constructor][${jobId}] ta_scoring stats: scored=${stats.pre_filter_rows}, ` +
                    `avg=${stats.pre_filter_avg_score.toFixed(2)}, ` +
                    `filtered_out=${stats.filtered_out_count}` +
                    (stepConfig.keepAllScored ? ' (keepAllScored=true → no filter)' : ''),
                );
              },
            }
          : {}),
      };

      // Eagerly merge «Найденный Email» в исходную email-колонку
      // ПЕРЕД запуском шага, если эта колонка уже есть в данных.
      //
      // Сценарий №1 (happy path): на предыдущей итерации find_emails
      // добавил FOUND_EMAIL_COL. Сейчас следующая итерация (например
      // split_emails) — мерджим прямо сейчас, до runner'а, чтобы
      // split увидел все скрапленные адреса в email-колонке и разнёс
      // каждый в отдельную строку. Без этого split трогает только
      // исходную email-колонку, найденные идут в финальный merge
      // через запятую — и в итоговом файле получаются multi-email
      // cells, которые Instantly валидирует как одну строку и
      // отбрасывает (реальный кейс polza@polza.ru
      // constructor_2026-05-27 (1).csv: у Okkam одна строка с
      // email=«jobs@okkam.ru, ekaterina.fisher@…, marina.…»).
      //
      // Сценарий №2 (resume edge case): worker умер сразу после
      // find_emails (progress=100 в DB, current_step_key='find_emails')
      // но до моего merge'а. Новый worker на resume пропускает
      // find_emails (progress=100), приходит на следующий шаг.
      // FOUND_EMAIL_COL ещё в данных — merge сделает то же что и
      // happy path, до runner'а split_emails / последующих шагов.
      //
      // No-op когда FOUND_EMAIL_COL отсутствует (~95% итераций):
      // дешёвый header-only check без копирования данных.
      const preHeader = data[0] ?? [];
      const hasFoundCol = preHeader.some(
        (h) => typeof h === 'string' && h.trim() === FOUND_EMAIL_COL,
      );
      if (hasFoundCol) {
        const beforeMergeCols = preHeader.length;
        data = mergeFoundEmailColumn(data);
        const afterMergeCols = data[0]?.length ?? 0;
        console.log(
          `[base-constructor][${jobId}] eager-merged FOUND_EMAIL_COL into email column before step '${stepKey}' (cols ${beforeMergeCols} → ${afterMergeCols})`,
        );
      }

      const stepStart = Date.now();
      console.log(
        `[base-constructor][${jobId}] step ${i + 1}/${selectedSteps.length} '${stepKey}' starting (input rows=${Math.max(0, data.length - 1)}, cols=${data[0]?.length ?? 0})`,
      );
      data = await runner(data, progressFn, cancelCheck, effectiveStepConfig);
      console.log(
        `[base-constructor][${jobId}] step '${stepKey}' returned in ${Date.now() - stepStart}ms (output rows=${Math.max(0, data.length - 1)}, cols=${data[0]?.length ?? 0})`,
      );

      const isLast = i === selectedSteps.length - 1;
      if (!isLast) {
        // Persist intermediate data so the next step has it on resume.
        await persistData(`after:${stepKey}`, data);
      }
      // For the last step we skip the intermediate write and let the final
      // atomic update below set both `data` and `status='completed'` together —
      // otherwise a process restart between the two writes would leave the job
      // stuck in 'processing' at 100% with no result_stats.
    }

    const header = data[0] || [];
    const body = data.slice(1);
    const emailIdx = findColumnIndex(header, 'email');
    const scoreIdx = findColumnIndex(header, 'ца балл', 'цабалл', 'ta score');
    const emailsFound = emailIdx >= 0 ? body.filter((r) => extractEmail(r[emailIdx] || '')).length : 0;
    const avgScore = scoreIdx >= 0
      ? body.reduce((s, r) => s + (parseInt(r[scoreIdx], 10) || 0), 0) / (body.length || 1)
      : 0;

    // Финальный merge двух email-колонок (если find_emails работал в режиме
    // 'separate' — у нас сейчас и исходная Email, и Найденный Email). Юзер хочет
    // итоговый файл с одной колонкой — мерджим case-insensitive с дедупом.
    data = mergeFoundEmailColumn(data);
    const finalSanitized = sanitizeRowsForJsonb(data);
    const finalApproxBytes = JSON.stringify(finalSanitized).length;
    const { error: finalErr, ms: finalMs, attempts: finalAttempts } = await updateJobWithRetry(
      jobId,
      {
        data: finalSanitized,
        status: 'completed',
        completed_at: new Date().toISOString(),
        current_step: selectedSteps.length,
        current_step_key: 'done',
        current_step_progress: 100,
        result_stats: {
          total_rows: body.length,
          emails_found: emailsFound,
          avg_ta_score: Math.round(avgScore * 10) / 10,
          columns: header.length,
          // Pre-filter ta_scoring telemetry — лежит здесь, чтобы UI мог показать
          // «AI оценил 27, средний балл 4.2, ниже 7 — отфильтровано 27» и юзер
          // не подумал что инструмент сломался при пустом результате.
          ...(taScoringStats
            ? {
                ta_scoring_pre_filter_rows: taScoringStats.pre_filter_rows,
                ta_scoring_filtered_out: taScoringStats.filtered_out_count,
                ta_scoring_pre_filter_avg: Math.round(taScoringStats.pre_filter_avg_score * 10) / 10,
              }
            : {}),
        },
      },
      'final',
    );
    if (finalErr) {
      console.error(
        `[base-constructor][${jobId}] FINAL update FAILED in ${finalMs}ms after ${finalAttempts} attempt(s) — ${finalErr.message} (rows=${body.length}, cols=${header.length}, ~${finalApproxBytes}B)`,
      );
      throw new Error(`Final update failed: ${finalErr.message}`);
    }
    const finalRetryNote = finalAttempts > 1 ? ` (after ${finalAttempts} attempts)` : '';
    console.log(
      `[base-constructor][${jobId}] FINAL update OK in ${finalMs}ms${finalRetryNote} — completed (rows=${body.length}, cols=${header.length}, emails=${emailsFound}, avg_ta=${Math.round(avgScore * 10) / 10})`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`[base-constructor][${jobId}] Job FAILED:`, message);
    await admin.from('base_constructor_jobs').update({
      status: 'failed',
      error_message: message.slice(0, 500),
      completed_at: new Date().toISOString(),
    }).eq('id', jobId);
  }
}
