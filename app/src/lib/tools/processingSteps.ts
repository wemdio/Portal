/**
 * Shared processing step functions for base pipelines.
 * Used by the Base Constructor worker (+ helpers like companyNameCleanupBatch).
 * NB: the DFYB worker has its OWN private step implementations and does NOT
 * import this module - so the BASE_*_SCRAPE_CONCURRENCY env vars below affect
 * only Base Constructor, never DFYB.
 * Each step accepts a ProgressFn callback to decouple from specific job tables.
 */

import {
  removeEmptyRowsAndCols,
  deduplicateRows,
  deduplicateByEmail,
  findColumnIndex,
  findPreferredSiteColumnIndexes,
  getPreferredSiteUrl,
  processInPool,
  extractEmail,
  extractEmails,
} from './dfybUtils';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import { validateEmail, type DomainInfo } from '@/lib/emailValidation/validator';
import { isSupportEmail } from './supportEmails';
import { makeCheckpointGate } from './checkpointGate';
import {
  CLEANUP_JSON_SYSTEM_PROMPT,
  CLEANUP_BATCH,
  buildCleanupUserMessage,
  parseCleanupResponseJson,
  parseCleanupResponse,
} from '@/lib/nameCleanupProtocol';

// Re-export: исторический дом парсеров — здесь; тесты и внешние импортёры
// продолжают работать. Каноничная реализация теперь в nameCleanupProtocol.
export { parseCleanupResponseJson, parseCleanupResponse };

export type ProgressFn = (progress: number) => Promise<void>;
export type CancelCheckFn = () => Promise<boolean>;
export type CheckpointFn = (data: string[][]) => Promise<void>;

/**
 * Локаль джобы конструктора баз ('ru' — default и прежнее поведение).
 * Джобы с locale='en' создаёт Движок вертикалей для англоязычных рынков:
 * у них английские служебные колонки («Found Email», «Description»),
 * расширенный блок-лист хостов (linkedin/indeed/…) и доп. ролевые
 * email-префиксы (legal@/privacy@/abuse@). RU-путь нигде не меняется.
 */
export type ConstructorLocale = 'ru' | 'en';

export function normalizeConstructorLocale(value: unknown): ConstructorLocale {
  return value === 'en' ? 'en' : 'ru';
}

const OPENROUTER_BRIEF_API_KEY = process.env.OPENROUTER_BRIEF_API_KEY || '';
const OPENROUTER_PERSONALIZATION_API_KEY =
  process.env.OPENROUTER_PERSONALIZATION_API_KEY || process.env.OPENROUTER_BRIEF_API_KEY || '';
const OPENROUTER_CLEANUP_API_KEY = process.env.OPENROUTER_CLEANUP_API_KEY || '';
const CLEANUP_MODEL = 'policy/cleanup';
const AI_MODEL = 'policy/gemini-flash';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const SITE_CHECK_TIMEOUT = 12_000;

// Raised from 5 → 15 after polza@polza.ru job 55d37e8e ran for ~8h on
// 4297 rows with `find_emails` at 75%. Throughput here is wall-clock
// bound by remote HTTP, not by CPU/memory — higher fan-out gives
// linear speedup until we hit (a) target-host rate-limits or (b) our
// outbound socket pool. 15 is conservative for shared infrastructure;
// can lift further if telemetry shows no upstream complaints.
// Env-настраиваемо: при высокой глобальной параллельности (base-constructor =
// 3 реплики x 4 = 12 job'ов) дефолтные 15+5 дали бы сотни исходящих коннектов
// и риск IP-бана. base-constructor-контейнеры ставят BASE_*_SCRAPE_CONCURRENCY
// ниже; кто не ставит (напр. DFYB) - остаётся на дефолтах 15/5.
const EMAIL_CONCURRENCY = Math.max(1, Number(process.env.BASE_EMAIL_SCRAPE_CONCURRENCY) || 15);
const ENRICH_CONCURRENCY = Math.max(1, Number(process.env.BASE_ENRICH_SCRAPE_CONCURRENCY) || 5);
/**
 * Hard ceiling per site for enrich. fetchAndExtract internally tries main +
 * www + http variants + up to N about-page candidates with retries — each
 * with its own 8s soft timeout. Worst-case the chain can stretch to a
 * minute+ for a single tarpit/proxy-blocked site, blocking one worker slot.
 * With concurrency=5, if all five slots latch onto such hosts at once, the
 * step's `await processInPool(...)` never returns and the whole job hangs.
 *
 * 60s is generous enough for honest slow servers but caps the catastrophic
 * tail. Worker abandons the in-flight promise and moves on.
 */
const ENRICH_PER_SITE_TIMEOUT_MS = 60_000;
const SITE_CHECK_BATCH = 50;
const TA_BATCH = 10;
/** Дополнительные попытки только для индексов, пропущенных в успешном HTTP 200. */
const TA_RESPONSE_MAX_RETRIES = 3;
// CLEANUP_BATCH (50, не 100) и обоснование — в nameCleanupProtocol.ts.
const PERSONALIZATION_BATCH = 5;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Максимальная пауза между попытками. Провайдер не должен вешать джоб надолго. */
const MAX_RETRY_DELAY_MS = 60_000;

export type AiRetryKind = 'permanent' | 'rate_limit' | 'server' | 'network' | 'exhausted';

export interface AiRetryDecision {
  retry: boolean;
  delayMs: number;
  kind: AiRetryKind;
}

/**
 * Что делать после неудачного обращения к ИИ.
 *
 * Разбор 04.08.2026 (шаг «Оценка ЦА»): повторы были, но одинаковые для всех
 * ошибок — 1.5 + 3 + 6 секунд, всего около десяти. Окно лимита запросов у
 * провайдера живёт примерно минуту, а заголовок Retry-After игнорировался,
 * поэтому пачка честно делала четыре попытки внутри одного и того же окна и
 * всё равно падала. При двенадцати параллельных джобах base-constructor,
 * которые делят один ключ, это давало ровно наблюдаемую картину: часть пачек
 * проходит, часть — нет (замеры по проду: 0 из 69 строк, 10 из 154, 98 из 304).
 *
 * Отсюда два разных расписания. Лимит запросов пересиживаем долго и уважаем
 * Retry-After. На «постоянных» ошибках (неверный ключ, кривой запрос) повторы
 * бессмысленны — сдаёмся сразу, чтобы не терять десять секунд на каждой пачке
 * и получить честную причину в логе.
 */
export function planAiRetry(params: {
  /** HTTP-статус ответа; null/undefined — сеть не ответила или таймаут. */
  status?: number | null;
  attempt: number;
  maxRetries?: number;
  /** Значение заголовка Retry-After в секундах, если провайдер его прислал. */
  retryAfterSec?: number | null;
}): AiRetryDecision {
  const { status, attempt, retryAfterSec } = params;
  const maxRetries = params.maxRetries ?? MAX_RETRIES;

  const permanent =
    typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
  if (permanent) return { retry: false, delayMs: 0, kind: 'permanent' };

  if (attempt >= maxRetries) return { retry: false, delayMs: 0, kind: 'exhausted' };

  if (status === 429 || status === 408) {
    const fromHeader = retryAfterSec != null && retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
    // 5 → 15 → 30 секунд: минутное окно лимита пересиживается за три попытки.
    const ladder = [5_000, 15_000, 30_000][Math.min(attempt, 2)];
    return {
      retry: true,
      delayMs: Math.min(Math.max(fromHeader, ladder), MAX_RETRY_DELAY_MS),
      kind: 'rate_limit',
    };
  }

  const delayMs = Math.min(RETRY_BASE_DELAY * 2 ** attempt, MAX_RETRY_DELAY_MS);
  return { retry: true, delayMs, kind: typeof status === 'number' ? 'server' : 'network' };
}

function parseRetryAfter(res: { headers?: { get?: (n: string) => string | null } }): number | null {
  const raw = res.headers?.get?.('retry-after');
  if (!raw) return null;
  const sec = Number(raw);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

interface OpenRouterCompletion {
  content: string;
  finishReason?: string | null;
}

async function callOpenRouterRaw(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number; json?: boolean; title?: string } = {},
): Promise<OpenRouterCompletion> {
  let lastError: Error = new Error('Обращение к ИИ не состоялось');

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 70_000);
    try {
      const res = await fetch('https://router.requesty.ai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://portal.app',
          'X-Title': opts.title ?? 'Portal - Base Constructor',
        },
        signal: controller.signal,
        body: JSON.stringify({
          model,
          messages,
          temperature: opts.temperature ?? 0.3,
          max_tokens: opts.max_tokens ?? 4000,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
        }),
      });
      clearTimeout(timeout);
      if (res.ok) {
        const json = await res.json();
        const choice = json.choices?.[0];
        return {
          content: choice?.message?.content || '',
          finishReason: choice?.finish_reason,
        };
      }

      // Текст ответа кладём в ошибку: без него причина провала теряется, и
      // разбирать инцидент не по чему (см. комментарий к planAiRetry).
      let body = '';
      try {
        body = (await res.text()).slice(0, 200);
      } catch {
        // тело недоступно — статуса достаточно
      }
      lastError = new Error(`ИИ ответил HTTP ${res.status}${body ? `: ${body}` : ''}`);

      const plan = planAiRetry({ status: res.status, attempt, retryAfterSec: parseRetryAfter(res) });
      if (!plan.retry) throw lastError;
      await sleep(plan.delayMs);
    } catch (err) {
      clearTimeout(timeout);
      const isOurs = err === lastError;
      if (!isOurs) {
        const msg = err instanceof Error ? err.message : String(err);
        lastError = new Error(`Обращение к ИИ не удалось: ${msg}`);
        const plan = planAiRetry({ status: null, attempt });
        if (!plan.retry) throw lastError;
        await sleep(plan.delayMs);
        continue;
      }
      throw lastError;
    }
  }
  throw lastError;
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number; json?: boolean; title?: string } = {},
): Promise<string> {
  const { content } = await callOpenRouterRaw(apiKey, model, messages, opts);
  return content;
}

/* ═══════════════════════════════════════════
   STEP: Remove empty rows/columns
   ═══════════════════════════════════════════ */

export async function stepRemoveEmpty(
  data: string[][],
  onProgress: ProgressFn,
): Promise<string[][]> {
  await onProgress(50);
  const result = removeEmptyRowsAndCols(data);
  await onProgress(100);
  return result;
}

/* ═══════════════════════════════════════════
   STEP: Full deduplication
   ═══════════════════════════════════════════ */

export async function stepFullDedup(
  data: string[][],
  onProgress: ProgressFn,
): Promise<string[][]> {
  await onProgress(50);
  const result = deduplicateRows(data);
  await onProgress(100);
  return result;
}

/* ═══════════════════════════════════════════
   STEP: Email deduplication
   ═══════════════════════════════════════════ */

export async function stepEmailDedup(
  data: string[][],
  onProgress: ProgressFn,
): Promise<string[][]> {
  await onProgress(50);
  const result = deduplicateByEmail(data);
  await onProgress(100);
  return result;
}

/* ═══════════════════════════════════════════
   STEP: Find emails (scrape from websites)
   ═══════════════════════════════════════════ */

/**
 * Канон-имя колонки куда find_emails пишет scrape-результат когда target='separate'.
 *
 * Зачем отдельная колонка: если в исходной базе уже есть email от sales-process'а
 * (введены вручную, проверены продажниками), скрапленные с сайтов email — это
 * ДРУГОЕ качество. Юзер хочет хранить их в разных колонках, чтобы:
 *   - validate'ить отдельно (например, доверять «своим» без re-validate);
 *   - в финальном экспорте видеть оба источника;
 *   - при выборе «обе колонки» merge на финале объединит их через запятую
 *     (с дедупом case-insensitive — см. mergeFoundEmailColumn в baseConstructorWorker).
 *
 * Важно: имя НЕ совпадает ни с одним alias'ом 'email'/'e-mail'/'почта'/'mail' —
 * findColumnIndex делает exact-match, так что эта колонка не будет случайно
 * подобрана как «email-column» в других шагах (validate знает про неё отдельно).
 */
export const FOUND_EMAIL_COL = 'Найденный Email';

/** EN-вариант FOUND_EMAIL_COL для джобов с locale='en' (см. ConstructorLocale). */
export const FOUND_EMAIL_COL_EN = 'Found Email';

/** Имя колонки scrape-результата find_emails (target='separate') по локали. */
export function foundEmailColForLocale(locale?: ConstructorLocale): string {
  return locale === 'en' ? FOUND_EMAIL_COL_EN : FOUND_EMAIL_COL;
}

/**
 * Заголовок колонки описания, которую создаёт enrich_descriptions, по локали:
 * RU — «Описание» (прежнее поведение), EN — «Description».
 */
export function descriptionColForLocale(locale?: ConstructorLocale): string {
  return locale === 'en' ? 'Description' : 'Описание';
}

export interface StepFindEmailsOptions {
  /**
   * Куда писать scrape-результат:
   *   - 'same' (legacy): дополняем существующую email-колонку (или создаём если её нет).
   *     `find_emails` исторически работал именно так, юзер использовал шаг чтобы
   *     добрать email для строк с сайтом но без email — это сохраняется.
   *   - 'separate': создаём отдельную колонку FOUND_EMAIL_COL и пишем ТУДА.
   *     Исходная email-колонка не трогается. Полезно когда юзер хочет сохранить
   *     первичные данные и иметь scrape-результат «рядом», а потом отдельно решать
   *     что валидировать / как мерджить.
   *
   * Если target='separate' но email-колонки в исходных данных нет — fallback'имся
   * на 'same' (создаём «Email» как раньше). Опция теряет смысл когда нет «исходных».
   */
  target?: 'same' | 'separate';
  /**
   * Callback для checkpoint'а данных в DB jsonb каждые N строк. Если worker
   * умирает посреди шага (redeploy, OOM, hard crash) — на resume следующий
   * worker читает свежий checkpoint, фильтрует строки с уже найденным
   * email'ом и продолжает с того места. Без этого callback'а — restart с нуля.
   *
   * Симптом который этот колбэк закрывает: polza@polza.ru job 55d37e8e на
   * redeploy потерял прогресс с 84% → 28% (рестарт всего шага с 4297 строк).
   * Тяжёлые checkpoint'ы (4MB jsonb) делаются раз в 250 строк — ~17 раз
   * за prod-base ≈ 70MB суммарной записи, что приемлемо.
   */
  onCheckpoint?: CheckpointFn;
  /**
   * Останавливать скрап после первого пригодного адреса (раньше было
   * захардкожено true в вызове scrapeEmails). Default true = прежнее
   * поведение: base-constructor'у исторически хватало одного адреса на
   * компанию, а обход остальных candidate-страниц — доминирующая трата
   * времени шага. false — собираем больше адресов с сайта (до
   * maxEmailsPerSite) — нужно связке с cap_emails_per_company
   * («до N почт на компанию»).
   */
  stopAtFirstUsableEmail?: boolean;
  /**
   * Максимум адресов с одного сайта, которые пишем в ячейку (default 8).
   * Защита от «сайта-простыни» (десятки адресов в футере/на team-странице)
   * когда stopAtFirstUsableEmail=false.
   */
  maxEmailsPerSite?: number;
  /**
   * Локаль джобы (job.locale конструктора баз, пробрасывает worker).
   * При 'en': колонка scrape-результата — «Found Email» (вместо
   * «Найденный Email»), блок-лист хостов расширен EN job-бордами,
   * скрапер ходит с Accept-Language 'en-US,en' и EN-путями первыми.
   * Default 'ru' — прежнее поведение.
   */
  locale?: ConstructorLocale;
}

/* ═══════════════════════════════════════════
   SHARED HELPERS (per-company grouping, validation status rank)
   ═══════════════════════════════════════════ */

/**
 * Ключ «одна компания» для группировки строк после split_emails (одна
 * компания с N почтами → N почти-идентичных строк, различие только в
 * email-колонке). Общий для шагов с пер-компанийной логикой:
 * ta_scoring (дедуп перед AI-оценкой) и cap_emails_per_company.
 *
 * Компания+сайт различают «однофамильцев» (одно имя у разных фирм → разные
 * сайты → разные ключи). Если НЕТ ни компании, ни сайта — не схлопываем
 * разные строки в одну: ключуем по всему контенту строки кроме email,
 * т.е. деградируем к поштучному поведению.
 *
 * Фабрика (не сама функция ключа), чтобы индексы колонок считались один раз
 * на header, а не на каждую строку.
 */
function makeCompanyKeyFn(header: string[]): (row: string[]) => string {
  const companyIdx = findColumnIndex(header, 'company', 'компания', 'название', 'наименование', 'организация');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website', 'домен', 'domain');
  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  return (row: string[]): string => {
    const company = (companyIdx >= 0 ? row[companyIdx] || '' : '').trim().toLowerCase();
    const site = (siteIdx >= 0 ? row[siteIdx] || '' : '').trim().toLowerCase();
    // JSON.stringify даёт collision-proof ключ (["ab","c"] != ["a","bc"]);
    // ключ живёт только в памяти (Map), никогда не попадает в DB.
    if (company || site) return 'cs:' + JSON.stringify([company, site]);
    const copy = [...row];
    if (emailIdx >= 0) copy[emailIdx] = '';
    return 'r:' + JSON.stringify(copy);
  };
}

// Ранг статусов валидации email (колонка «… Статус» от validate_emails):
// ok > catch_all > unknown > error > invalid > disposable. Общий для
// validate_emails (выбор «лучшего» адреса в мульти-email ячейке) и
// cap_emails_per_company (приоритет строк внутри компании).
const STATUS_RANK: Record<string, number> = {
  ok: 5,
  catch_all: 4,
  unknown: 3,
  error: 2,
  invalid: 1,
  disposable: 0,
};

/** Пустой или неизвестный статус — ниже всех (-1). */
function statusRank(s: string): number {
  return STATUS_RANK[s] ?? -1;
}

// Хосты, которые НЕ имеет смысла скрейпить: job-борды/агрегаторы с антиботом.
// Это не сайт компании — описаний/почт там не достать (отдаёт «Произошла
// ошибка…cookie»), только мусор + трата времени. «Обогатить» и «Найти email»
// пропускают такие строки. Жёсткий пол на случай, если hh.ru всё же просочился
// в колонку «сайт» (старый файл, чужой источник, проигнорированное warning).
const NON_SCRAPEABLE_HOSTS: readonly string[] = [
  'hh.ru', 'headhunter.ru',
  'superjob.ru', 'rabota.ru', 'zarplata.ru', 'trudvsem.ru', 'gorodrabot.ru',
];

// EN-локаль (locale='en'): крупнейшие EN job-борды/карьерные агрегаторы —
// тот же класс мусора что hh.ru для RU. Блокируем ТОЛЬКО при locale='en':
// в RU-базах linkedin/indeed исторически не блокировались, поведение по
// умолчанию не меняем.
const NON_SCRAPEABLE_HOSTS_EN_EXTRA: readonly string[] = [
  'linkedin.com', 'indeed.com', 'glassdoor.com', 'wellfound.com',
];

const NON_SCRAPEABLE_HOSTS_EN: readonly string[] = [
  ...NON_SCRAPEABLE_HOSTS,
  ...NON_SCRAPEABLE_HOSTS_EN_EXTRA,
];

function hostOf(raw: string): string {
  let v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  try { return new URL(v).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function isNonScrapeableHost(raw: string, locale?: ConstructorLocale): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  const blocked = locale === 'en' ? NON_SCRAPEABLE_HOSTS_EN : NON_SCRAPEABLE_HOSTS;
  return blocked.some((d) => host === d || host.endsWith(`.${d}`));
}

export async function stepFindEmails(
  data: string[][],
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
  options?: StepFindEmailsOptions,
): Promise<string[][]> {
  let header = [...data[0]];
  let body = data.slice(1).map((r) => [...r]);
  const siteColumnIndexes = findPreferredSiteColumnIndexes(header);
  if (siteColumnIndexes.length === 0) { await onProgress(100); return data; }

  const locale = normalizeConstructorLocale(options?.locale);
  const foundEmailCol = foundEmailColForLocale(locale);
  const existingEmailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const wantsSeparate = options?.target === 'separate';
  // step_config.find_emails.stop_at_first (default true = прежнее захардкоженное
  // поведение) и .max_per_site (default 8) — см. StepFindEmailsOptions.
  const stopAtFirstUsableEmail = options?.stopAtFirstUsableEmail ?? true;
  const maxPerSite = Math.max(1, options?.maxEmailsPerSite ?? 8);

  // Target column resolution:
  //   - target='separate' + есть существующая email-колонка → пишем в FOUND_EMAIL_COL (новая);
  //   - target='separate' + НЕТ email-колонки → нечего «отделять», fallback к 'same' (создаём «Email»);
  //   - target='same' (или не указан) + есть email-колонка → дополняем её (legacy);
  //   - target='same' + НЕТ email-колонки → создаём «Email».
  let targetIdx: number;
  if (wantsSeparate && existingEmailIdx >= 0) {
    const foundExistingFoundIdx = header.findIndex((h) => h.trim() === foundEmailCol);
    if (foundExistingFoundIdx >= 0) {
      // Re-run / resume: колонка уже создана прошлым проходом. Используем её.
      targetIdx = foundExistingFoundIdx;
    } else {
      targetIdx = header.length;
      header = [...header, foundEmailCol];
      body = body.map((row) => [...row, '']);
    }
  } else if (existingEmailIdx >= 0) {
    targetIdx = existingEmailIdx;
  } else {
    targetIdx = header.length;
    header = [...header, 'Email'];
    body = body.map((row) => [...row, '']);
  }

  // Для строк где target-колонка уже заполнена — скипаем (идемпотентно
  // при resume, и сохраняет ручной ввод когда target='same').
  // Для 'separate' это значит «не перезатираем найденный ранее scrape-результат».
  const toProcess = body
    .map((row, i) => ({ row, i, url: getPreferredSiteUrl(row, siteColumnIndexes) }))
    .filter((r) => r.url && !extractEmail(r.row[targetIdx] || '') && !isNonScrapeableHost(r.url, locale));

  if (toProcess.length === 0) { await onProgress(100); return [header, ...body]; }

  let done = 0;
  // Чекпоинт по строкам И по времени, что раньше. Один счётчик строк давал
  // вечный цикл: база в 6602 строки, падение на 3% — это 198-я строка, до
  // 250-й дело не доходило ни разу, resume каждый раз начинал шаг с нуля.
  // См. checkpointGate.
  const onCheckpoint = options?.onCheckpoint;
  const shouldCheckpoint = makeCheckpointGate();
  await processInPool(toProcess, EMAIL_CONCURRENCY, async (item) => {
    if (isCancelled && await isCancelled()) return;
    try {
      // stopAtFirstUsableEmail (default true): bail as soon as the homepage /
      // first contact page gives us a usable address. Base-constructor only
      // needs one — the worker doesn't use the extra addresses, and
      // crawling 4 more pages per company is the dominant time sink.
      // stop_at_first=false (step_config.find_emails) выключает ранний выход —
      // для связки с cap_emails_per_company, где нужно несколько почт с сайта.
      const { emails } = await scrapeEmails(item.url, {
        timeout: 15_000,
        maxPages: 5,
        stopAtFirstUsableEmail,
        locale,
      });
      if (emails.length > 0) {
        body[item.i][targetIdx] = emails.slice(0, maxPerSite).join(', ');
      }
    } catch { /* skip */ }
    done++;
    if (done % 10 === 0 || done === toProcess.length) {
      await onProgress(Math.round((done / toProcess.length) * 100));
    }
    if (onCheckpoint && shouldCheckpoint(done, done === toProcess.length)) {
      await onCheckpoint([header, ...body]);
    }
  });

  await onProgress(100);
  return [header, ...body];
}

/* ═══════════════════════════════════════════
   STEP: Split emails into separate rows
   ═══════════════════════════════════════════ */

const EMAIL_SPLIT_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export async function stepSplitEmails(
  data: string[][],
  onProgress: ProgressFn,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  if (emailIdx < 0) { await onProgress(100); return data; }

  await onProgress(10);

  const result: string[][] = [];
  for (const row of body) {
    const cell = (row[emailIdx] || '').trim();
    const emails = cell.match(EMAIL_SPLIT_REGEX);

    if (!emails || emails.length <= 1) {
      result.push(row);
    } else {
      const unique = [...new Set(emails.map((e) => e.toLowerCase()))];
      for (const email of unique) {
        const newRow = [...row];
        newRow[emailIdx] = email;
        result.push(newRow);
      }
    }
  }

  await onProgress(100);
  return [header, ...result];
}

/* ═══════════════════════════════════════════
   STEP: Remove support / role-based emails
   ═══════════════════════════════════════════ */

/**
 * Drops rows whose only email is a SUPPORT / service mailbox (support@, help@,
 * zakaz@, billing@ …) — not a decision-maker, hurts outreach. Good general
 * inboxes (info@, sales@, contact@, hr@, jobs@ …) are intentionally KEPT
 * (see supportEmails.ts).
 *
 * Checks BOTH the original email column (alias-based) AND the FOUND_EMAIL_COL
 * that `find_emails` (target='separate') writes — otherwise emails scraped from
 * the site (the usual source of these support@ rows) would slip through. Role
 * addresses are stripped from each cell; a row is removed only when it HAD
 * email(s) and none survive (so a mixed «support@x, ivan@x» cell keeps ivan@).
 * Rows without any email are left untouched.
 */

export interface StepRemoveSupportEmailsOptions {
  /**
   * Локаль джобы (job.locale). При 'en' дополнительно выкидываем
   * юридические/комплаенс ящики (legal@, privacy@, abuse@) — в EN-базах это
   * не точка контакта для аутрича. info@/sales@/hello@ остаются в обеих
   * локалях. Default 'ru' — прежнее поведение.
   */
  locale?: ConstructorLocale;
}

// Доп. ролевые ящики ТОЛЬКО для EN-локали. abuse@ уже покрыт базовым списком
// supportEmails.ts — здесь для явности контракта, повторная проверка идемпотентна.
const EN_EXTRA_ROLE_LOCALPARTS = new Set(['legal', 'privacy', 'abuse']);

// Та же семантика, что isRoleLocalPart в supportEmails.ts: точное совпадение
// или слово перед разделителем/цифрой (legal.dept@, privacy2@), но НЕ префикс
// более длинного слова (legalize@ — персональный/прочий ящик, оставляем).
function isEnExtraRoleEmail(email: string): boolean {
  const at = email.indexOf('@');
  if (at <= 0) return false;
  const local = email.slice(0, at).trim().toLowerCase();
  if (!local) return false;
  if (EN_EXTRA_ROLE_LOCALPARTS.has(local)) return true;
  const m = local.match(/^([a-z]+)(?=[._+\-0-9])/);
  return !!m && EN_EXTRA_ROLE_LOCALPARTS.has(m[1]);
}

export async function stepRemoveSupportEmails(
  data: string[][],
  onProgress: ProgressFn,
  options?: StepRemoveSupportEmailsOptions,
): Promise<string[][]> {
  if (data.length < 2) { await onProgress(100); return data; }
  const header = data[0];
  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const foundIdx = header.findIndex((h) => h.trim() === foundEmailColForLocale(options?.locale));
  const cols = [emailIdx, foundIdx].filter((i) => i >= 0);
  if (cols.length === 0) { await onProgress(100); return data; }

  const isRoleEmail = options?.locale === 'en'
    ? (e: string) => isSupportEmail(e) || isEnExtraRoleEmail(e)
    : isSupportEmail;

  await onProgress(40);
  const out: string[][] = [header];
  for (const row of data.slice(1)) {
    let hadEmail = false;
    let hasPersonal = false;
    const newRow = [...row];
    for (const ci of cols) {
      const cell = (row[ci] || '').trim();
      if (!cell) continue;
      const emails = cell.match(EMAIL_SPLIT_REGEX);
      if (!emails || emails.length === 0) continue;
      hadEmail = true;
      const kept = emails.filter((e) => !isRoleEmail(e));
      if (kept.length > 0) hasPersonal = true;
      newRow[ci] = kept.join(', ');
    }
    // Выкидываем строку, только если в ней БЫЛИ email и ВСЕ они ролевые.
    if (hadEmail && !hasPersonal) continue;
    out.push(newRow);
  }
  await onProgress(100);
  return out;
}

/* ═══════════════════════════════════════════
   STEP: Check site availability
   ═══════════════════════════════════════════ */

async function checkSite(url: string): Promise<boolean> {
  let normalized = url;
  if (!/^https?:\/\//i.test(normalized)) normalized = `https://${normalized}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SITE_CHECK_TIMEOUT);
  try {
    const res = await fetch(normalized, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' },
    });
    return res.status >= 200 && res.status < 400;
  } catch { return false; }
  finally { clearTimeout(timeout); }
}

// Эвристика «похоже на сайт»: непустое значение без '@' (т.е. не email) с доменом
// вида name.tld (точка + 2+ буквы, в т.ч. кириллических — .рф). Лояльная: любой
// реальный домен проходит, а email / название / пустышка — нет.
export function looksLikeSite(raw: string): boolean {
  const v = (raw ?? '').trim();
  if (!v || v.includes('@')) return false;
  return /\.[a-zа-яё]{2,}(?:[/?:#]|$)/.test(v.toLowerCase());
}

// Защита от «тихого убийства базы»: если в колонке «сайт» почти нет значений,
// похожих на сайт (например, туда по ошибке сопоставили email или название) —
// check_sites удалил бы ВСЕ строки (каждое «не-сайт» не открывается → строка
// «мёртвая»). Вместо пустого результата падаем с понятной ошибкой, а входные
// данные остаются нетронутыми (клиент правит маппинг и перезапускает).
const SITE_GUARD_MIN_ROWS = 5;             // не судим по слишком мелкой выборке
const SITE_GUARD_MIN_SITE_FRACTION = 0.2;  // <20% похожих на сайт ⇒ колонка не та

export async function stepSiteCheck(
  data: string[][],
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website', 'url', 'домен', 'domain');
  if (siteIdx < 0) { await onProgress(100); return data; }

  const keep: boolean[] = new Array(body.length).fill(true);
  const toCheck = body.map((row, i) => ({ url: (row[siteIdx] || '').trim(), i })).filter((r) => r.url);

  // Гард: колонка «сайт» не похожа на сайты ⇒ не вычищаем всю базу молча.
  if (toCheck.length >= SITE_GUARD_MIN_ROWS) {
    const siteLike = toCheck.reduce((n, r) => (looksLikeSite(r.url) ? n + 1 : n), 0);
    if (siteLike / toCheck.length < SITE_GUARD_MIN_SITE_FRACTION) {
      throw new Error(
        `«Проверка сайтов»: колонка «сайт» не похожа на сайты ` +
          `(только ${siteLike} из ${toCheck.length} значений выглядят как сайт). ` +
          `Похоже, в эту колонку попали не сайты — например, email или название компании. ` +
          `Проверьте сопоставление колонок и запустите заново; база не тронута.`,
      );
    }
  }

  for (let batch = 0; batch < toCheck.length; batch += SITE_CHECK_BATCH) {
    if (isCancelled && await isCancelled()) throw new Error('Отменено');
    const chunk = toCheck.slice(batch, batch + SITE_CHECK_BATCH);
    const results = await Promise.all(chunk.map(async (item) => ({ i: item.i, ok: await checkSite(item.url) })));
    for (const r of results) { if (!r.ok) keep[r.i] = false; }
    await onProgress(Math.round(((batch + chunk.length) / toCheck.length) * 100));
  }

  const filtered = body.filter((_, i) => keep[i]);
  await onProgress(100);
  return [header, ...filtered];
}

/* ═══════════════════════════════════════════
   STEP: Enrich descriptions from websites
   ═══════════════════════════════════════════ */

export interface StepEnrichOptions {
  /**
   * Локаль джобы (job.locale). При 'en': новая колонка описания называется
   * «Description» (вместо «Описание»), блок-лист хостов расширен EN
   * job-бордами. Default 'ru' — прежнее поведение.
   */
  locale?: ConstructorLocale;
}

export async function stepEnrich(
  data: string[][],
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
  onCheckpoint?: CheckpointFn,
  options?: StepEnrichOptions,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const locale = normalizeConstructorLocale(options?.locale);
  const descIdx = findColumnIndex(header, 'описание', 'description');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website', 'url', 'домен', 'domain');

  if (siteIdx < 0) { await onProgress(100); return data; }

  const needsNewCol = descIdx < 0;
  const targetDescIdx = needsNewCol ? header.length : descIdx;
  const newHeader = needsNewCol ? [...header, descriptionColForLocale(locale)] : [...header];

  const newBody = needsNewCol ? body.map((row) => [...row, '']) : body.map((row) => [...row]);

  const toProcess = newBody
    .map((row, i) => ({ row, i, url: (row[siteIdx] || '').trim() }))
    .filter((r) => r.url && !(r.row[targetDescIdx] || '').trim() && !isNonScrapeableHost(r.url, locale));

  if (toProcess.length === 0) { await onProgress(100); return [newHeader, ...newBody]; }

  let done = 0;
  let timedOut = 0;
  const shouldCheckpoint = makeCheckpointGate();
  const settledIndexes = new Set<number>();
  const markSettled = async (index: number, didTimeOut: boolean) => {
    // The watchdog can release the pool slot before the aborted fetch promise
    // unwinds. Whichever path settles first owns progress for this row.
    if (settledIndexes.has(index)) return;
    settledIndexes.add(index);
    done += 1;
    if (didTimeOut) timedOut += 1;
    if (done % 10 === 0 || done === toProcess.length) {
      await onProgress(Math.round((done / toProcess.length) * 100));
    }
    if (onCheckpoint && shouldCheckpoint(done, done === toProcess.length)) {
      await onCheckpoint([newHeader, ...newBody]);
    }
  };
  await processInPool(toProcess, ENRICH_CONCURRENCY, async (item, _i, signal) => {
    if (isCancelled && await isCancelled()) return;
    try {
      // signal comes from the pool's per-task watchdog. Pass it down so a
      // tarpit website's fetch is aborted at ENRICH_PER_SITE_TIMEOUT_MS.
      const text = await fetchAndExtract(item.url, { timeout: 15_000, signal });
      if (text) newBody[item.i][targetDescIdx] = text.slice(0, 2000);
    } catch {
      // Other errors silently skipped: site is unreachable / blocked.
    } finally {
      await markSettled(_i, false);
    }
  }, {
    taskTimeoutMs: ENRICH_PER_SITE_TIMEOUT_MS,
    onTimeout: async (_item, index) => {
      await markSettled(index, true);
      return undefined;
    },
  });

  if (timedOut > 0) {
    console.warn(
      `[stepEnrich] ${timedOut}/${toProcess.length} sites hit the ${ENRICH_PER_SITE_TIMEOUT_MS}ms hard timeout (probably proxy tarpits or unresponsive servers).`,
    );
  }

  await onProgress(100);
  return [newHeader, ...newBody];
}

/* ═══════════════════════════════════════════
   STEP: ICP/TA scoring
   ═══════════════════════════════════════════ */

const TA_SYSTEM_PROMPT = `Ты — эксперт по B2B лидогенерации и квалификации компаний для email-аутрича.

ЗАДАЧА: Оценить релевантность каждой компании как потенциального клиента на основе брифа.

ПРАВИЛА ОЦЕНКИ (0-10):
- 9-10: Идеальное совпадение с ЦА
- 7-8: Сильное совпадение
- 5-6: Среднее совпадение
- 3-4: Слабое совпадение
- 1-2: Очень слабое
- 0: Полное несовпадение или недостаточно данных

БУДЬ СТРОГИМ. Большинство компаний — 3-6 баллов. 9-10 только при идеальном совпадении.
При малом количестве данных — максимум 5.

Всегда копируй idx компании из входа без изменений. Не перенумеровывай компании.

ФОРМАТ ОТВЕТА: Только JSON объект, без пояснений.
{"scores":[{"idx": 0, "score": 7, "reason": "краткое обоснование на русском"}]}`;

interface TAScoreAnswer {
  idx: number;
  score: number;
  reason: string;
}

function parseTAScoreResponse(content: string): unknown[] {
  if (!content.trim()) throw new Error('ИИ вернул пустой ответ');

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = codeBlock ? codeBlock[1].trim() : content.trim();
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    parsed = arrMatch ? JSON.parse(arrMatch[0]) : JSON.parse(raw);
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    const scores = (parsed as { scores?: unknown }).scores;
    if (Array.isArray(scores)) return scores;
  }
  throw new Error('ИИ вернул JSON без массива scores');
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Принимаем только однозначные ответы на ожидаемые индексы. Настоящий score=0
 * валиден; отсутствие, дубль или чужой idx — нет, их нужно запросить повторно.
 */
function collectTAScoreAnswers(rows: unknown[], expectedIndexes: Set<number>): Map<number, TAScoreAnswer> {
  const answers = new Map<number, TAScoreAnswer>();
  const candidatesByIndex = new Map<
    number,
    Array<{ score?: unknown; reason?: unknown }>
  >();

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue;
    const candidate = raw as { idx?: unknown; score?: unknown; reason?: unknown };
    const idx = candidate.idx;
    if (typeof idx !== 'number' || !Number.isInteger(idx) || !expectedIndexes.has(idx)) continue;
    const candidates = candidatesByIndex.get(idx) ?? [];
    candidates.push(candidate);
    candidatesByIndex.set(idx, candidates);
  }

  for (const [idx, candidates] of candidatesByIndex) {
    // Даже один валидный и один испорченный ответ на один idx неоднозначны:
    // не угадываем, какой верный, а запрашиваем компанию повторно.
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    const score = finiteNumber(candidate.score);
    if (score == null) continue;
    answers.set(idx, {
      idx,
      score,
      reason: typeof candidate.reason === 'string' ? candidate.reason : '',
    });
  }

  return answers;
}

export interface StepTAScoreOptions {
  /**
   * Когда true — НЕ фильтровать по порогу 7+, оставить все оценённые строки
   * с проставленными колонками «ЦА Балл» / «ЦА Причина». Полезно когда
   * сотрудник хочет сам решить, кого оставить, или для дебага брифа
   * (видно, что AI ставит большинству низкие баллы).
   */
  keepAllScored?: boolean;
  /**
   * Колбэк для телеметрии: pre_filter_rows / filtered_out / avg_score.
   * Worker сохраняет это в `result_stats`, чтобы UI мог показать «AI оценил
   * N компаний, средний балл X.X, ниже порога — отфильтровано M». Без этого
   * пустой результат выглядел как «инструмент сломался».
   */
  onStats?: (stats: {
    pre_filter_rows: number;
    filtered_out_count: number;
    pre_filter_avg_score: number;
    /** Строк с заглушкой «Ошибка оценки» — ИИ по ним не ответил. */
    failed_rows: number;
    /** Сколько исходных пачек после всех повторов осталось хотя бы частично без оценки. */
    failed_batches: number;
    /** Сколько HTTP 200 ответов Requesty завершились по лимиту токенов. */
    length_responses: number;
    /** Причины провалов с частотой — то, чего раньше немой catch не оставлял. */
    errors: Array<{ reason: string; count: number }>;
  }) => void;
  /**
   * Mid-step checkpoint for long ta_scoring runs. Receives rows with current
   * score/reason columns filled for completed companies, before final filtering.
   */
  onCheckpoint?: CheckpointFn;
}

const TA_SCORE_COL = 'ЦА Балл';
const TA_REASON_COL = 'ЦА Причина';

function findTAScoreColumnIndexes(header: string[]): { scoreIdx: number; reasonIdx: number } {
  return {
    scoreIdx: findColumnIndex(header, 'ца балл', 'цабалл', 'ta score'),
    reasonIdx: findColumnIndex(header, 'ца причина', 'ta reason'),
  };
}

function scoreColumnStripper(header: string[], scoreIdx: number, reasonIdx: number): {
  header: string[];
  stripRow: (row: string[]) => string[];
} {
  const drop = new Set([scoreIdx, reasonIdx].filter((idx) => idx >= 0));
  if (drop.size === 0) return { header, stripRow: (row) => row };
  const keptIndexes = header.map((_, idx) => idx).filter((idx) => !drop.has(idx));
  return {
    header: keptIndexes.map((idx) => header[idx]),
    stripRow: (row) => keptIndexes.map((idx) => row[idx] || ''),
  };
}

export async function stepTAScore(
  data: string[][],
  brief: string,
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
  options?: StepTAScoreOptions,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const existingScoreColumns = findTAScoreColumnIndexes(header);
  const hasExistingScoreColumns =
    existingScoreColumns.scoreIdx >= 0 && existingScoreColumns.reasonIdx >= 0;
  const newHeader = hasExistingScoreColumns
    ? [...header]
    : [...header, TA_SCORE_COL, TA_REASON_COL];
  const scoreColIdx = hasExistingScoreColumns
    ? existingScoreColumns.scoreIdx
    : newHeader.length - 2;
  const reasonColIdx = hasExistingScoreColumns
    ? existingScoreColumns.reasonIdx
    : newHeader.length - 1;
  const { header: scoringHeader, stripRow } =
    scoreColumnStripper(newHeader, scoreColIdx, reasonColIdx);
  // ── Дедуп по компании перед AI-оценкой ──────────────────────────────
  // `split_emails` идёт ДО этого шага и размножает строки: одна компания с
  // N почтами → N идентичных строк, различие только в колонке email. Балл ЦА
  // зависит от компании (название/сайт/описание), а НЕ от адреса, поэтому
  // раньше мы гоняли AI по каждой почте и переплачивали кратно. Реальный
  // замер 26.06: СБИС-база = 5289 уникальных компаний, раздутых в 35525 строк
  // (6.7×) → 3552 последовательных вызова вместо 529. Теперь оцениваем каждую
  // УНИКАЛЬНУЮ компанию один раз (email в промпт НЕ передаём — балл зависит
  // только от компании) и транслируем балл на все её строки. Контракт выхода
  // (число строк, порядок, колонки, фильтр <7, телеметрия onStats) — прежний;
  // меняется лишь то, что строки одной компании теперь гарантированно получают
  // ОДИН балл (раньше AI оценивал каждую почту отдельно).
  // Ключ группировки «одна компания» — общий модульный хелпер (вынесен из
  // этого шага, та же логика): компания+сайт, fallback — вся строка без email.
  const keyOf = makeCompanyKeyFn(scoringHeader);
  const keyOfRow = (row: string[]): string => keyOf(stripRow(row));
  // emailIdx нужен и дальше — чтобы НЕ класть email в AI-промпт (см. ниже).
  const emailIdx = findColumnIndex(scoringHeader, 'email', 'e-mail', 'почта', 'mail');

  // Уникальные представители в порядке первого появления.
  const repByKey = new Map<string, string[]>();
  for (const row of body) {
    const k = keyOfRow(row);
    if (!repByKey.has(k)) repByKey.set(k, row);
  }
  const uniqueKeys = [...repByKey.keys()];
  const uniqueRows = [...repByKey.values()];

  if (uniqueRows.length < body.length) {
    console.log(
      `[ta_scoring] per-company dedup: ${body.length} rows → ${uniqueRows.length} unique ` +
        `(${(body.length / Math.max(1, uniqueRows.length)).toFixed(1)}× fewer AI calls)`,
    );
  }

  // ── AI-оценка уникальных представителей (тот же батч-протокол) ───────
  const scoreByKey = new Map<string, { score: string; reason: string }>();
  // Учёт провалов: какие компании остались без оценки и по каким причинам.
  // Нужен, чтобы «Ошибка оценки» в результате перестала быть немой — оператор
  // видит сводку в карточке задачи, а воркер пишет её в application_logs.
  const failedKeys = new Set<string>();
  const errorCounts = new Map<string, number>();
  let failedBatches = 0;
  let lengthResponses = 0;
  const materializeCheckpointRows = (): string[][] => [
    newHeader,
    ...body.map((row) => {
      const out = [...row];
      while (out.length < newHeader.length) out.push('');
      const scored = scoreByKey.get(keyOfRow(row));
      if (scored) {
        out[scoreColIdx] = scored.score;
        out[reasonColIdx] = scored.reason;
      }
      return out;
    }),
  ];
  const checkpoint = async () => {
    if (options?.onCheckpoint) await options.onCheckpoint(materializeCheckpointRows());
  };
  const shouldCheckpoint = makeCheckpointGate();
  const markFailedKeys = (keys: string[], reason: string) => {
    if (keys.length === 0) return;
    failedBatches += 1;
    for (const key of keys) {
      failedKeys.add(key);
      scoreByKey.set(key, { score: '5', reason: 'Ошибка оценки' });
    }
    errorCounts.set(reason, (errorCounts.get(reason) ?? 0) + 1);
  };

  for (const row of body) {
    if (!hasExistingScoreColumns) break;
    const score = finiteNumber(row[scoreColIdx]);
    if (score == null) continue;
    const reason = row[reasonColIdx] || '';
    scoreByKey.set(keyOfRow(row), { score: String(score), reason });
  }

  for (let batch = 0; batch < uniqueRows.length; batch += TA_BATCH) {
    const chunkKeys = uniqueKeys.slice(batch, batch + TA_BATCH);
    const chunk = uniqueRows.slice(batch, batch + TA_BATCH);
    let unresolved = chunk
      .map((row, idx) => ({ idx, key: chunkKeys[idx], row }))
      .filter(({ key }) => !scoreByKey.has(key));
    let failureReason: string | null = null;
    let batchSawLength = false;

    if (unresolved.length === 0) {
      await onProgress(Math.round(((batch + chunk.length) / uniqueRows.length) * 100));
      continue;
    }

    // HTTP/сеть уже повторяются внутри callOpenRouter. Этот цикл отвечает за
    // другой класс ошибки: провайдер вернул 200, но забыл часть индексов.
    // Успешные ответы сохраняем, а в следующий запрос отправляем только хвост.
    for (
      let responseAttempt = 0;
      responseAttempt <= TA_RESPONSE_MAX_RETRIES && unresolved.length > 0;
      responseAttempt += 1
    ) {
      if (isCancelled && await isCancelled()) throw new Error('Отменено');

      const companies = unresolved.map(({ idx, row }) => {
        const obj: Record<string, string> = {};
        const promptRow = stripRow(row);
        // email НЕ кладём в промпт: оценка зависит от компании, а не от конкретного
        // адреса — иначе балл представителя зависел бы от того, какая почта
        // оказалась первой в группе, и дедуп переставал бы быть lossless.
        scoringHeader.forEach((h, c) => { obj[h] = c === emailIdx ? '' : (promptRow[c] || ''); });
        return { idx, data: obj };
      });
      const userMsg = `Бриф:\n${brief.slice(0, 4000)}\n\nКомпании:\n${JSON.stringify(companies)}`;

      let completion: OpenRouterCompletion;
      try {
        completion = await callOpenRouterRaw(OPENROUTER_BRIEF_API_KEY, AI_MODEL, [
          { role: 'system', content: TA_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ], { temperature: 0.2, json: true, title: 'Portal - Base Constructor TA Scoring' });
      } catch (err) {
        failureReason = err instanceof Error ? err.message : String(err);
        break;
      }

      if (completion.finishReason === 'length') {
        lengthResponses += 1;
        batchSawLength = true;
      }

      let responseRows: unknown[];
      try {
        responseRows = parseTAScoreResponse(completion.content);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        failureReason = batchSawLength ? `${reason} (finish_reason=length)` : reason;
        if (responseAttempt < TA_RESPONSE_MAX_RETRIES) continue;
        break;
      }

      const expectedIndexes = new Set(unresolved.map(({ idx }) => idx));
      const answers = collectTAScoreAnswers(responseRows, expectedIndexes);
      const unresolvedByIndex = new Map(unresolved.map((company) => [company.idx, company]));
      for (const [idx, answer] of answers) {
        const company = unresolvedByIndex.get(idx);
        if (!company) continue;
        scoreByKey.set(company.key, { score: String(answer.score), reason: answer.reason });
      }

      unresolved = unresolved.filter(({ idx }) => !answers.has(idx));
      if (unresolved.length === 0) {
        failureReason = null;
        break;
      }
      failureReason =
        `Неполный ответ ИИ: отсутствуют или неоднозначны индексы ` +
        unresolved.map(({ idx }) => idx).join(', ') +
        (batchSawLength ? ' (finish_reason=length)' : '');
    }

    if (unresolved.length > 0) {
      // Причину НЕ теряем. Успешно оценённая часть пачки остаётся нетронутой,
      // явная заглушка ставится только компаниям, которые не удалось добрать.
      const reason = failureReason ?? 'ИИ не вернул оценки для части компаний';
      markFailedKeys(unresolved.map(({ key }) => key), reason);
      console.warn(
        `[ta_scoring] пачка ${Math.floor(batch / TA_BATCH) + 1}: ` +
          `${unresolved.length}/${chunk.length} компаний не оценено: ${reason}`,
      );
    }

    const processed = batch + chunk.length;
    await onProgress(Math.round((processed / uniqueRows.length) * 100));
    if (options?.onCheckpoint && shouldCheckpoint(processed, processed === uniqueRows.length)) {
      await checkpoint();
    }
  }

  // Защита инварианта: новый/изменённый код маршрутизации не должен снова
  // превратить потерянную компанию в молчаливый 0 и обойти телеметрию.
  const unassignedKeys = uniqueKeys.filter((key) => !scoreByKey.has(key));
  if (unassignedKeys.length > 0) {
    const reason = 'Внутренняя ошибка сопоставления оценок ЦА';
    markFailedKeys(unassignedKeys, reason);
    console.warn(`[ta_scoring] ${unassignedKeys.length} компаний потеряно при сопоставлении результатов`);
  }

  // Транслируем баллы обратно на ВСЕ строки в ИСХОДНОМ порядке. Строки одной
  // компании получают один и тот же балл/причину (что и требуется).
  const scored: string[][] = body.map((row) => {
    // Защитный fallback тоже явный: даже при будущей ошибке маршрутизации строка
    // никогда снова не превратится в молчаливую «оценку 0».
    const s = scoreByKey.get(keyOfRow(row)) ?? { score: '5', reason: 'Ошибка оценки' };
    const out = [...row];
    while (out.length < newHeader.length) out.push('');
    out[scoreColIdx] = s.score;
    out[reasonColIdx] = s.reason;
    return out;
  });

  const TA_MIN_SCORE = 7;

  // Pre-filter telemetry
  const preFilterRows = scored.length;
  let scoreSum = 0;
  for (const row of scored) {
    const v = parseInt(row[scoreColIdx], 10);
    if (!isNaN(v)) scoreSum += v;
  }
  const preFilterAvg = preFilterRows > 0 ? scoreSum / preFilterRows : 0;

  const filtered = options?.keepAllScored
    ? scored
    : scored.filter((row) => {
        const score = parseInt(row[scoreColIdx], 10);
        return !isNaN(score) && score >= TA_MIN_SCORE;
      });

  // Строки (не компании), оставшиеся без настоящей оценки: у них в результате
  // стоит заглушка «Ошибка оценки», и оператор должен видеть их количество.
  const failedRows = failedKeys.size
    ? body.filter((row) => failedKeys.has(keyOfRow(row))).length
    : 0;
  const errors = [...errorCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  if (failedBatches > 0) {
    console.warn(
      `[ta_scoring] не оценено ${failedRows} строк из ${preFilterRows} ` +
        `(${failedBatches} неудачных пачек после повторов). Причины: ` +
        errors.map((e) => `${e.reason} ×${e.count}`).join('; '),
    );
  }

  if (lengthResponses > 0) {
    console.warn(
      `[ta_scoring] Ответов Requesty с finish_reason=length: ${lengthResponses}; ` +
        `валидные оценки сохранены, недостающие запрошены повторно`,
    );
  }

  options?.onStats?.({
    pre_filter_rows: preFilterRows,
    filtered_out_count: preFilterRows - filtered.length,
    pre_filter_avg_score: preFilterAvg,
    failed_rows: failedRows,
    failed_batches: failedBatches,
    length_responses: lengthResponses,
    errors,
  });

  await onProgress(100);
  return [newHeader, ...filtered];
}

/* ═══════════════════════════════════════════
   STEP: Name cleanup
   ═══════════════════════════════════════════ */

// Промпт и парсеры cleanup-протокола переехали в @/lib/nameCleanupProtocol
// (re-export выше). Здесь остался только сам шаг.

export async function stepNameCleanup(
  data: string[][],
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const nameIdx = findColumnIndex(header, 'компания', 'company', 'name', 'название');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website', 'url', 'domain');
  if (nameIdx < 0) { await onProgress(100); return data; }

  for (let batch = 0; batch < body.length; batch += CLEANUP_BATCH) {
    if (isCancelled && await isCancelled()) throw new Error('Отменено');
    const chunk = body.slice(batch, batch + CLEANUP_BATCH);

    // Input — JSON, idx 0-based (отдаём natively, парсер JSON'а транслирует
    // в 1-based ключи map'а при возврате).
    const userMsg = buildCleanupUserMessage(
      chunk.map((row) => ({
        name: row[nameIdx] || '',
        domain: siteIdx >= 0 ? row[siteIdx] || null : null,
      })),
    );

    let cleanedMap: Map<number, string> | null = null;
    try {
      const content = await callOpenRouter(OPENROUTER_CLEANUP_API_KEY, CLEANUP_MODEL, [
        { role: 'system', content: CLEANUP_JSON_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ], { temperature: 0.1, json: true, title: 'Portal - Base Constructor Cleanup' });

      // Сначала пробуем JSON-парсер (основной путь). Если модель таки
      // вернула текст в нумерованном формате (response_format иногда
      // игнорится упрощёнными моделями) — fallback на legacy text-парсер.
      cleanedMap = parseCleanupResponseJson(content);
      if (!cleanedMap) {
        console.warn(
          `[base-constructor] cleanup JSON parse returned null, falling back to text parser`,
        );
        cleanedMap = parseCleanupResponse(content, chunk.length);
      }
    } catch { /* skip batch on failure */ }

    if (cleanedMap) {
      for (let i = 0; i < chunk.length; i++) {
        const idx = batch + i;
        const cleaned = cleanedMap.get(i + 1);
        if (cleaned) body[idx][nameIdx] = cleaned;
      }
    }

    await onProgress(Math.round(((batch + chunk.length) / body.length) * 100));
  }

  await onProgress(100);
  return [header, ...body];
}

/* ═══════════════════════════════════════════
   STEP: Personalization
   ═══════════════════════════════════════════ */

const PERSONALIZATION_SYSTEM_PROMPT = `Ты — помощник для персонализации холодного email-аутрича в B2B.

ПРАВИЛА:
1. Используй ТОЛЬКО факты из входных данных. Ничего не выдумывай.
2. Не добавляй названия, имена, цифры, кейсы, если их нет в данных.
3. Если данных мало — пиши нейтрально и обобщенно.
4. Не добавляй приветствия, подписи, темы письма.

СТИЛЬ:
- Пиши как живой человек, без канцелярита
- Строго соблюдай русскую грамматику
- Используй только дефис "-", не тире "—"
- 1-3 коротких предложения
- Избегай: "уникальный", "эксклюзивный", "лучший", "инновационный"
- Фокус на выгоде для клиента

Ответ: только текст персонализации.`;

export async function stepPersonalize(
  data: string[][],
  prompt: string,
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const newHeader = [...header, 'Персонализация'];
  const result: string[][] = [];

  for (let batch = 0; batch < body.length; batch += PERSONALIZATION_BATCH) {
    if (isCancelled && await isCancelled()) throw new Error('Отменено');
    const chunk = body.slice(batch, batch + PERSONALIZATION_BATCH);

    const promises = chunk.map(async (row) => {
      const obj: Record<string, string> = {};
      header.forEach((h, c) => { obj[h] = row[c] || ''; });
      const sourceData = Object.entries(obj)
        .filter(([, v]) => v.trim())
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');

      const userMsg = `Данные: "${sourceData.slice(0, 3000)}"\n\nЗадача: ${prompt.slice(0, 2000)}\n\nСгенерируй 1 персонализированное предложение.`;
      try {
        const content = await callOpenRouter(OPENROUTER_PERSONALIZATION_API_KEY, AI_MODEL, [
          { role: 'system', content: PERSONALIZATION_SYSTEM_PROMPT },
          { role: 'user', content: userMsg },
        ], { temperature: 0.7, max_tokens: 1500, title: 'Portal - Base Constructor Personalization' });
        return [...row, content.trim()];
      } catch {
        return [...row, ''];
      }
    });

    const batchResults = await Promise.all(promises);
    result.push(...batchResults);
    await onProgress(Math.round(((batch + chunk.length) / body.length) * 100));
  }

  await onProgress(100);
  return [newHeader, ...result];
}

/* ═══════════════════════════════════════════
   STEP: Email validation (uses external API)
   ═══════════════════════════════════════════ */

const VALIDATION_CONCURRENCY = 10;

export type ValidateEmailsTarget = 'original' | 'found' | 'both';

export interface StepValidateEmailsOptions {
  /**
   * Какие колонки валидировать (имеет смысл когда find_emails работал в target='separate'
   * и создал FOUND_EMAIL_COL рядом с исходной):
   *   - 'original' (default): только исходная email-колонка (alias-based: email/e-mail/...).
   *     Когда юзер доверяет своим email'ам и хочет проверить только их.
   *   - 'found': только колонка FOUND_EMAIL_COL (scrape-результат). Когда юзер
   *     доверяет своим email'ам и хочет проверить только то что нашёл worker
     *     (бывает мусор типа noreply@/info@).
 *   - 'both': обе колонки независимо. В каждой колонке невалидные → удаляются
 *     (заменяются пустой строкой); строка остаётся пока хотя бы в одной
 *     колонке остался валидный email после фильтра.
 *
 * Если запрошенной колонки нет в данных — фильтрация по ней просто скипается
 * (no-op). Это совместимо со сценарием когда find_emails не запускался
 * и FOUND_EMAIL_COL отсутствует — validate в режиме 'both'/'found' тогда
 * деградирует до 'original'/no-op без ошибок.
 */
  validateTarget?: ValidateEmailsTarget;
  /**
   * Что делать со строками, у которых валидируемая email-колонка ПУСТА
   * (нет ни нормального адреса, ни мусора-который-стал-после-extractEmail-пустым):
   *
   *   - true (default): такие строки фильтруются вместе с теми, у которых
   *     email невалидный. Семантика «конструктор баз»: на выходе — только
   *     строки с подтверждённым работающим email'ом. Раньше 74% строк
   *     возвращалось без email'а (см. реальный кейс polza@polza.ru,
   *     job 8b188038-…: 1795 пустых из 2418 на выходе).
   *
   *   - false: legacy-поведение. Строки без email сохраняются как «не
   *     валидировались». Бывает полезно когда валидация — не финальный
   *     шаг, а промежуточный enrich (например, find_emails ещё не
   *     запустился). Не использовать в base-constructor user flow.
   */
  dropRowsWithoutEmail?: boolean;
  /**
   * Что делать со статусом 'unknown' (и 'error') — «не удалось проверить»
   * (greylisting, отказ/таймаут соединения, заблокированный IP SMTP-пробы,
   * неоднозначный ответ, исключение валидатора). Это НЕ «подтверждённо
   * мёртвый» адрес.
   *
   *   - true (default): такие строки СОХРАНЯЮТСЯ с email'ом нетронутым,
   *     статус 'unknown' виден в колонке «… Статус». Раньше 'unknown'
   *     удалялся наравне с 'invalid' и молча выкидывал, скорее всего,
   *     валидные адреса (жалоба клиента: «убрали 20% рабочих почт»). Многие
   *     почтовики дают 'unknown' (Yandex/Workspace при блоке нашего IP,
   *     greylisting, sender-callback), а не настоящий отказ.
   *
   *   - false: агрессивная очистка — 'unknown' удаляется как 'invalid'
   *     (прежнее поведение). Когда нужна максимально «чистая» база ценой
   *     возможной потери валидных адресов.
   *
   * 'invalid' и 'disposable' (подтверждённо плохие) удаляются всегда.
   */
  keepUnverifiable?: boolean;
  /**
   * Callback для checkpoint'а данных каждые N строк. То же зачем что
   * и в stepFindEmails: на redeploy/crash посреди шага следующий worker
   * читает свежий checkpoint вместо стартовых данных и продолжает с
   * проверенной части. Validate медленнее scrape'а (SMTP+DNS), так что
   * без checkpoint'а потеря прогресса на длинных базах особенно болезненна.
   */
  onCheckpoint?: CheckpointFn;
  /**
   * Локаль джобы (job.locale). Влияет только на имя found-колонки, которую
   * ищем при validateTarget='found'/'both': «Found Email» для 'en',
   * «Найденный Email» для 'ru' (default, прежнее поведение).
   */
  locale?: ConstructorLocale;
}

export async function stepValidateEmails(
  data: string[][],
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
  options?: StepValidateEmailsOptions,
): Promise<string[][]> {
  const dropRowsWithoutEmail = options?.dropRowsWithoutEmail ?? true;
  const keepUnverifiable = options?.keepUnverifiable ?? true;
  const header = data[0];
  const body = data.slice(1);
  const originalEmailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const foundEmailIdx = header.findIndex((h) => h.trim() === foundEmailColForLocale(options?.locale));

  const target: ValidateEmailsTarget = options?.validateTarget ?? 'original';

  // Резолвим какие индексы реально валидируем. Если запрошен 'both' но одна
  // из колонок отсутствует — берём только что есть; если обе отсутствуют —
  // ранний return (нечего валидировать).
  const indicesToValidate: number[] = [];
  if ((target === 'original' || target === 'both') && originalEmailIdx >= 0) {
    indicesToValidate.push(originalEmailIdx);
  }
  if ((target === 'found' || target === 'both') && foundEmailIdx >= 0) {
    indicesToValidate.push(foundEmailIdx);
  }
  if (indicesToValidate.length === 0) { await onProgress(100); return data; }

  // Status/provider колонки добавляем по одной паре на каждую валидируемую
  // колонку. Имена префиксуем явно чтобы юзер в финальном экспорте понимал
  // что относится к чему: «Email Статус» для original, «Найденный Email Статус»
  // для found.
  //
  // Идемпотентность: пара «… Статус»/«… Провайдер» могла остаться от прошлого
  // запуска шага (resume после падения воркера или повторная загрузка готового
  // экспорта в конструктор). Тогда переиспользуем существующие колонки и НЕ
  // добавляем вторую одинаковую пару — иначе каждый re-run плодил дубли
  // колонок и гонял полную ре-валидацию.
  const newHeader = [...header];
  const newBody = body.map((row) => [...row]);
  const meta: { srcIdx: number; statusIdx: number; providerIdx: number; label: string }[] = [];
  for (const idx of indicesToValidate) {
    // Имя колонки — от TRIMMED заголовка (грязный « Email » → «Email Статус»):
    // stepCapEmailsPerCompany ищет её как `${header[emailIdx].trim()} Статус`.
    const srcLabel = header[idx].trim();
    const statusName = `${srcLabel} Статус`;
    const providerName = `${srcLabel} Провайдер`;
    let statusIdx = newHeader.findIndex((h) => h.trim() === statusName);
    if (statusIdx < 0) {
      statusIdx = newHeader.length;
      newHeader.push(statusName);
      for (const row of newBody) row.push('');
    }
    let providerIdx = newHeader.findIndex((h) => h.trim() === providerName);
    if (providerIdx < 0) {
      providerIdx = newHeader.length;
      newHeader.push(providerName);
      for (const row of newBody) row.push('');
    }
    meta.push({ srcIdx: idx, statusIdx, providerIdx, label: srcLabel });
  }
  // «Рваные» строки (короче header'а) добиваем пустыми ячейками, чтобы записи
  // по переиспользованным индексам не уходили в «дырки» массива.
  for (const row of newBody) {
    while (row.length < newHeader.length) row.push('');
  }

  // Собираем ячейки для валидации. Мульти-email ячейка («a@x.ru, b@y.ru»)
  // валидируется по КАЖДОМУ адресу через extractEmails; в колонку «… Статус»
  // пишем статус ЛУЧШЕГО адреса. Плоский список уникальных адресов идёт в
  // общий пул с concurrency=10 — это лучше чем валидировать колонки
  // последовательно: на «both» получаем 2x скорость и общий domainCache
  // для catch-all/free лукапов.
  //
  // Идемпотентность (resume после падения / повторная загрузка экспорта):
  // строки, у которых в переиспользованной колонке «… Статус» уже стоит
  // финальный вердикт (ok/invalid/disposable/catch_all), ПРОПУСКАЕМ —
  // повторная SMTP-проба ничего не даст. Перепроверяем только ''/unknown/error.
  const CONCLUSIVE_STATUSES = new Set(['ok', 'invalid', 'disposable', 'catch_all']);
  type CellToValidate = {
    rowIdx: number;
    srcIdx: number;
    statusIdx: number;
    providerIdx: number;
    emails: string[];
  };
  const cells: CellToValidate[] = [];
  const uniqueEmails = new Set<string>();
  for (let r = 0; r < newBody.length; r += 1) {
    for (const m of meta) {
      const emails = extractEmails(newBody[r][m.srcIdx] || '');
      if (emails.length === 0) continue;
      const prevStatus = (newBody[r][m.statusIdx] || '').trim();
      if (CONCLUSIVE_STATUSES.has(prevStatus)) continue;
      cells.push({ rowIdx: r, srcIdx: m.srcIdx, statusIdx: m.statusIdx, providerIdx: m.providerIdx, emails });
      for (const e of emails) uniqueEmails.add(e);
    }
  }

  if (cells.length === 0) { await onProgress(100); return [newHeader, ...newBody]; }

  // Ранг статусов для выбора «лучшего» адреса в ячейке — общий модульный
  // statusRank (ok > catch_all > unknown > error > invalid > disposable,
  // пустой/неизвестный — ниже всех), вынесен наверх т.к. используется и
  // шагом cap_emails_per_company.

  type ProbeResult = { result: string; is_free: boolean; is_catch_all: boolean; errorText: string };
  const results = new Map<string, ProbeResult>();
  const domainCache = new Map<string, DomainInfo>();

  const runProbe = async (email: string): Promise<ProbeResult> => {
    try {
      const r = await validateEmail(email, domainCache);
      return { result: r.result, is_free: r.is_free, is_catch_all: r.is_catch_all, errorText: r.error || '' };
    } catch (err) {
      return {
        result: 'error',
        is_free: false,
        is_catch_all: false,
        errorText: err instanceof Error ? err.message : String(err || ''),
      };
    }
  };

  // Мемоизация на уровне адреса: дубли email'а в базе (в т.ч. летящие
  // одновременно в пуле) дают ОДНУ SMTP-пробу — все ячейки с этим адресом
  // получают общий вердикт.
  const inflight = new Map<string, Promise<ProbeResult>>();
  const probe = (email: string): Promise<ProbeResult> => {
    const existing = inflight.get(email);
    if (existing) return existing;
    const p = runProbe(email);
    inflight.set(email, p);
    return p;
  };

  // Обратный индекс адрес → ячейки: по завершении пробы обновляем статус
  // всех ячеек с этим адресом (нужно для checkpoint'ов и второго прохода).
  const cellByEmail = new Map<string, CellToValidate[]>();
  for (const cell of cells) {
    for (const e of cell.emails) {
      const arr = cellByEmail.get(e);
      if (arr) arr.push(cell);
      else cellByEmail.set(e, [cell]);
    }
  }

  // Пишет в «… Статус»/«… Провайдер» статус лучшего из УЖЕ проверенных
  // адресов ячейки. Пока не проверен ни один — ничего не пишет.
  const applyCellStatus = (cell: CellToValidate) => {
    let bestEmail = '';
    let best: ProbeResult | null = null;
    for (const e of cell.emails) {
      const r = results.get(e);
      if (!r) continue;
      if (!best || statusRank(r.result) > statusRank(best.result)) {
        best = r;
        bestEmail = e;
      }
    }
    if (!best) return;
    newBody[cell.rowIdx][cell.statusIdx] = best.result;
    const domain = bestEmail.split('@')[1] || '';
    newBody[cell.rowIdx][cell.providerIdx] = best.is_free ? 'free' : best.is_catch_all ? 'catch-all' : domain;
  };

  // Round-robin по доменам: группируем адреса по домену и интерливим,
  // чтобы 10 одновременных проб пула не уперлись бурстом в один
  // корпоративный MX (rate-limit → временный блок → лишние unknown).
  const byDomain = new Map<string, string[]>();
  for (const e of uniqueEmails) {
    const d = e.split('@')[1] || '';
    const arr = byDomain.get(d);
    if (arr) arr.push(e);
    else byDomain.set(d, [e]);
  }
  const toValidate: string[] = [];
  while (toValidate.length < uniqueEmails.size) {
    for (const arr of byDomain.values()) {
      const next = arr.shift();
      if (next !== undefined) toValidate.push(next);
    }
  }

  let done = 0;
  // checkpoint каждые 250 валидаций. Validate медленнее scrape'а (SMTP+DNS
  // round-trip может быть 1-3s), так что 250 ≈ 5-10 мин работы — окно
  // потенциальной потери прогресса на redeploy не больше.
  const onCheckpoint = options?.onCheckpoint;
  const shouldCheckpoint = makeCheckpointGate();
  let cancelled = false;
  const mainPassStartedAt = Date.now();

  await processInPool(toValidate, VALIDATION_CONCURRENCY, async (email) => {
    if (isCancelled && await isCancelled()) { cancelled = true; return; }
    const r = await probe(email);
    results.set(email, r);
    const affected = cellByEmail.get(email);
    if (affected) for (const cell of affected) applyCellStatus(cell);
    done++;
    if (done % 5 === 0 || done === toValidate.length) {
      // Кэп 99, НЕ 100: дальше ещё возможен отложенный второй проход и фильтр.
      // progress=100 до реального конца шага даёт stuck-reaper'у
      // (autoCompleteIfStuck: для последнего шага порог 2 мин) завершить джоб
      // с нефильтрованным checkpoint'ом, пока шаг спит/допроверяет unknown.
      // Финальный onProgress(100) — в конце шага после фильтра.
      await onProgress(Math.min(99, Math.round((done / toValidate.length) * 100)));
    }
    if (onCheckpoint && shouldCheckpoint(done, done === toValidate.length)) {
      await onCheckpoint([newHeader, ...newBody]);
    }
  });

  // Отмена посреди шага: НЕ отдаём полу-валидированную матрицу в фильтр —
  // строки со статусом '' (пробы не успели отработать) были бы выкинуты как
  // «без email». Бросаем 'Отменено' как остальные шаги: worker фиксирует
  // cancelled, а resume продолжит с checkpoint'а (идемпотентность выше).
  if (cancelled || (isCancelled && await isCancelled())) {
    throw new Error('Отменено');
  }

  // Отложенный второй проход: адреса, чей ответ выглядит «временным»
  // (greylisting, таймаут, DNS, прокси), перепроверяем один раз после паузы —
  // greylist обычно отпускает повторную пробу через несколько минут.
  // Локальный предикат (worker не импортируем): статус unknown/error И текст
  // ошибки похож на временную проблему.
  const RETRYABLE_ERROR_RE = /временн|greylist|timeout|dns|prox/i;
  const SECOND_PASS_DELAY_MS = 5 * 60 * 1000;
  const retryable = toValidate.filter((e) => {
    const r = results.get(e);
    if (!r || (r.result !== 'unknown' && r.result !== 'error')) return false;
    return RETRYABLE_ERROR_RE.test(r.errorText);
  });
  if (retryable.length > 0 && !(isCancelled && await isCancelled())) {
    // Пауза нужна только если основной проход отработал быстро: на больших
    // базах 5 минут и так набегает за пулом. Ждём только остаток (hard cap
    // 5 мин), чтобы маленькие базы не стопорились надолго.
    const elapsed = Date.now() - mainPassStartedAt;
    const waitMs = Math.min(SECOND_PASS_DELAY_MS, Math.max(0, SECOND_PASS_DELAY_MS - elapsed));
    let waited = 0;
    while (waited < waitMs) {
      const chunk = Math.min(1000, waitMs - waited);
      await sleep(chunk);
      waited += chunk;
      // Heartbeat раз в ~30с: updateJobProgress бампает started_at (джоб жив
      // для stale-detector'а), а прогресс остаётся 99 (см. кэп выше) — иначе
      // пауза до 5 мин после progress=100 давала stuck-reaper'у завершить джоб
      // с нефильтрованными данными.
      if (waited % 30_000 < 1000) await onProgress(99);
      // Проверяем отмену раз в секунду, чтобы задача не висела в паузе.
      if (isCancelled && await isCancelled()) throw new Error('Отменено');
    }
    let retryDone = 0;
    await processInPool(retryable, VALIDATION_CONCURRENCY, async (email) => {
      if (isCancelled && await isCancelled()) { cancelled = true; return; }
      const r = await runProbe(email); // свежая проба, мимо memo
      results.set(email, r);
      const affected = cellByEmail.get(email);
      if (affected) for (const cell of affected) applyCellStatus(cell);
      // Heartbeat и в самом пуле: на больших retry-списках пул идёт минуты,
      // молчание здесь — то же окно для stuck-reaper'а, что и пауза выше.
      retryDone++;
      if (retryDone % 10 === 0) await onProgress(99);
    });
    if (cancelled || (isCancelled && await isCancelled())) {
      throw new Error('Отменено');
    }
    if (onCheckpoint) await onCheckpoint([newHeader, ...newBody]);
  }

  // Фильтрация: строка остаётся ЕСЛИ хотя бы в одной из валидируемых колонок
  // email прошёл (ok/catch_all) ЛИБО его не удалось проверить (unknown/error
  // при keepUnverifiable). Это семантика «строка имеет хотя бы один
  // потенциально рабочий email» — для outreach это и нужно.
  //
  // Дополнительно: для каждой строки в ПОДТВЕРЖДЁННО плохих колонках обнуляем
  // email (status invalid/disposable → пишем '' в src-колонку), чтобы в
  // финальном файле не торчал заведомо мёртвый адрес. «Не удалось проверить»
  // (unknown/error) НЕ обнуляем — он скорее всего валиден, а статус виден в
  // колонке «… Статус». Это касается ТОЛЬКО валидируемых колонок — другие
  // остаются как есть.
  //
  // Мульти-email ячейки этого запуска чистим ПОАДРЕСНО: выкидываем только
  // плохие адреса, живые склеиваем обратно через ', ' (см. ниже).
  const VALID_STATUSES = new Set(['ok', 'catch_all']);
  // «Не удалось проверить»: greylist, отказ/таймаут соединения, блок IP-пробы,
  // неоднозначный SMTP-ответ (validateEmail → 'unknown') или исключение
  // валидатора (→ 'error'). НЕ «подтверждённо мёртвый».
  const UNVERIFIABLE_STATUSES = new Set(['unknown', 'error']);
  // Ячейки, валидировавшиеся в ЭТОМ запуске (по ним есть пер-адресные
  // вердикты в results). Пропущенные по идемпотентности ячейки чистим
  // по-старому целиком — пер-адресных вердиктов по ним у нас нет.
  const cellByRowCol = new Map<string, CellToValidate>();
  for (const cell of cells) cellByRowCol.set(`${cell.rowIdx}:${cell.srcIdx}`, cell);
  const filtered = newBody.filter((row, r) => {
    let anyValid = false;
    let anyUnverifiable = false;
    for (const m of meta) {
      const status = (row[m.statusIdx] || '').trim();
      if (status === '') continue; // пустой email в этой колонке — не учитываем
      const isValid = VALID_STATUSES.has(status);
      const isUnverifiable = keepUnverifiable && UNVERIFIABLE_STATUSES.has(status);
      if (isValid) {
        anyValid = true;
      } else if (isUnverifiable) {
        // Не удалось проверить — статус виден в колонке «… Статус»,
        // плохие адреса из ячейки всё равно выкинем ниже.
        anyUnverifiable = true;
      }
      const cell = cellByRowCol.get(`${r}:${m.srcIdx}`);
      if (cell) {
        // Мульти-email ячейка этого запуска: удаляем ТОЛЬКО плохие адреса
        // (подтверждённо мёртвые — всегда; unknown/error — при
        // keepUnverifiable=false), живых склеиваем через ', '.
        const survivors = cell.emails.filter((e) => {
          const st = results.get(e)?.result ?? 'error';
          const bad = st === 'invalid' || st === 'disposable'
            || (!keepUnverifiable && UNVERIFIABLE_STATUSES.has(st));
          return !bad;
        });
        if (survivors.length === 0) row[m.srcIdx] = '';
        else if (survivors.length < cell.emails.length) row[m.srcIdx] = survivors.join(', ');
      } else if (!isValid && !isUnverifiable) {
        // Подтверждённо плохой (invalid/disposable) — или unknown/error при
        // keepUnverifiable=false — чистим src-ячейку чтобы потомки (export,
        // merge) не видели заведомо плохой email.
        row[m.srcIdx] = '';
      }
    }
    // Строка не имела email ни в одной валидируемой колонке (status='' везде).
    // По умолчанию (dropRowsWithoutEmail=true, base-constructor user flow) —
    // дропаем такую строку: в финальном файле нечего слать на почту.
    // Legacy-режим (dropRowsWithoutEmail=false) — сохраняем строку. Раньше
    // legacy-поведение было хардкодом и давало 74% мусорных строк на выходе
    // (см. job polza@polza.ru 8b188038-…: 1795 пустых строк из 2418).
    const hadAnyEmail = meta.some((m) => (row[m.statusIdx] || '').trim() !== '');
    if (!hadAnyEmail) return !dropRowsWithoutEmail;
    return anyValid || anyUnverifiable;
  });

  await onProgress(100);
  return [newHeader, ...filtered];
}

/* ═══════════════════════════════════════════
   STEP: Cap emails per company
   ═══════════════════════════════════════════ */

export interface StepCapEmailsPerCompanyOptions {
  /**
   * Максимум email-строк на одну компанию (default 5). Приходит из
   * step_config.cap_emails_per_company.max — см. STEP_RUNNERS в worker'е.
   */
  max?: number;
}

/**
 * Оставляет не больше N (default 5) email-строк на одну компанию.
 *
 * Зачем: outreach-автоматизациям нужно «до 5 почт на компанию», а после
 * split_emails одна компания может занимать десяток строк. Лишние строки
 * размывают лимиты отправки и донос; шаг оставляет топ-N адресов компании.
 *
 * Приоритет — качество адреса по колонке «Email Статус» (её создаёт
 * validate_emails, поэтому шаг рекомендован ПОСЛЕ неё): общий statusRank —
 * ok > catch_all > unknown > error > invalid > disposable; пустой или
 * неизвестный статус — ниже всех. При равном ранге (и когда колонки статуса
 * нет вовсе) выживают первые N строк компании в исходном порядке.
 *
 * Группировка по компании — общий makeCompanyKeyFn (компания+сайт, fallback —
 * вся строка без email): «однофамильцы» с разными сайтами не склеиваются.
 * Роли адресов НЕ фильтруем (support@/help@ остаются): это чистое
 * ограничение количества, а не чистка ролей — для неё есть отдельный шаг
 * remove_support_emails. Порядок строк в выходной матрице — исходный.
 */
export async function stepCapEmailsPerCompany(
  data: string[][],
  onProgress: ProgressFn,
  options?: StepCapEmailsPerCompanyOptions,
): Promise<string[][]> {
  if (data.length < 2) { await onProgress(100); return data; }
  const header = data[0];
  const body = data.slice(1);
  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  if (emailIdx < 0) { await onProgress(100); return data; }
  const max = Math.max(1, options?.max ?? 5);

  // Колонка статуса от validate_emails (имя строится от исходной email-
  // колонки: «Email Статус»). Может отсутствовать (cap без validate) — тогда
  // все ранги -1 и выживают просто первые N строк каждой компании.
  const statusIdx = header.findIndex((h) => h.trim() === `${header[emailIdx].trim()} Статус`);

  await onProgress(50);

  // Решаем КАКИЕ строки оставить: внутри группы сортируем по рангу статуса
  // (лучший первым), при равенстве — по исходному индексу (стабильность).
  // Сама выходная матрица остаётся в исходном порядке — фильтруем её по
  // множеству выживших индексов, а не склеиваем отсортированные группы.
  const keyOf = makeCompanyKeyFn(header);
  const groups = new Map<string, number[]>();
  for (let i = 0; i < body.length; i += 1) {
    const k = keyOf(body[i]);
    const arr = groups.get(k);
    if (arr) arr.push(i);
    else groups.set(k, [i]);
  }
  const keep = new Set<number>();
  for (const idxs of groups.values()) {
    const ranked = [...idxs].sort((a, b) => {
      const ra = statusIdx >= 0 ? statusRank((body[a][statusIdx] || '').trim()) : -1;
      const rb = statusIdx >= 0 ? statusRank((body[b][statusIdx] || '').trim()) : -1;
      return rb - ra || a - b;
    });
    for (const i of ranked.slice(0, max)) keep.add(i);
  }
  const out = body.filter((_, i) => keep.has(i));
  const dropped = body.length - out.length;
  if (dropped > 0) {
    console.log(
      `[cap_emails_per_company] dropped ${dropped} rows over cap ` +
        `(max=${max}/company): ${body.length} → ${out.length}`,
    );
  }

  await onProgress(100);
  return [header, ...out];
}

/* ═══════════════════════════════════════════
   STEP REGISTRY
   ═══════════════════════════════════════════ */

export type StepKey =
  | 'remove_empty'
  | 'dedup_full'
  | 'dedup_email'
  | 'clean_names'
  | 'find_emails'
  | 'split_emails'
  | 'remove_support_emails'
  | 'validate_emails'
  | 'cap_emails_per_company'
  | 'check_sites'
  | 'enrich_descriptions'
  | 'ta_scoring'
  | 'personalization';

/**
 * Cost tiers:
 * - free: no external calls, instant (dedup, remove empty)
 * - cheap: HTTP-only (site checks, scraping)
 * - api: external API calls per row (email validation)
 * - ai: LLM calls per batch (name cleanup, TA scoring, personalization)
 */
export type CostTier = 'free' | 'cheap' | 'api' | 'ai';

export interface StepDefinition {
  key: StepKey;
  label: string;
  description: string;
  icon: string;
  needsConfig?: 'brief' | 'prompt';
  category: 'clean' | 'enrich' | 'ai';
  /** Cost tier for display and sorting */
  cost: CostTier;
  /**
   * Optimal execution priority (lower = run first).
   * Free row-reducing steps should be lowest, expensive AI steps highest.
   */
  priority: number;
  /** Column headers that must be present for this step to work (any match within each group). */
  requiresColumns?: string[][];
  /** Column name aliases this step will create if missing. */
  producesColumns?: string[];
  /** Which other steps should ideally run before this one. */
  recommendedAfter?: StepKey[];
}

export const AVAILABLE_STEPS: StepDefinition[] = [
  {
    key: 'remove_empty',
    label: 'Удалить пустые строки',
    description: 'Убирает пустые строки и столбцы без данных',
    icon: 'eraser',
    category: 'clean',
    cost: 'free',
    priority: 10,
  },
  {
    key: 'dedup_full',
    label: 'Удалить дубликаты',
    description: 'Удаляет полностью совпадающие строки',
    icon: 'copy-minus',
    category: 'clean',
    cost: 'free',
    priority: 20,
  },
  {
    key: 'check_sites',
    label: 'Проверка сайтов',
    description: 'Удаляет строки с недоступными сайтами',
    icon: 'globe',
    category: 'enrich',
    cost: 'cheap',
    priority: 30,
    requiresColumns: [['сайт', 'site', 'website', 'url', 'домен', 'domain']],
  },
  {
    key: 'find_emails',
    label: 'Найти Email',
    description: 'Ищет все email-адреса по сайту компании',
    icon: 'mail-search',
    category: 'enrich',
    cost: 'cheap',
    priority: 40,
    requiresColumns: [
      ['сайт', 'site', 'website', 'url', 'домен', 'domain'],
    ],
    producesColumns: ['email'],
    recommendedAfter: ['check_sites'],
  },
  {
    key: 'split_emails',
    label: 'Разделить почты',
    description: 'Каждый email — отдельная строка. Если в ячейке несколько — разбивает.',
    icon: 'split',
    category: 'clean',
    cost: 'free',
    priority: 45,
    requiresColumns: [['email', 'e-mail', 'почта', 'mail']],
    recommendedAfter: ['find_emails'],
  },
  {
    key: 'remove_support_emails',
    label: 'Убрать почты поддержки',
    description: 'Удаляет строки с почтами поддержки (support@, help@, zakaz@, billing@…); info@/sales@ оставляет',
    icon: 'mail-x',
    category: 'clean',
    cost: 'free',
    priority: 47,
    requiresColumns: [['email', 'e-mail', 'почта', 'mail']],
    recommendedAfter: ['split_emails'],
  },
  {
    key: 'dedup_email',
    label: 'Дедупликация по Email',
    description: 'Оставляет одну строку на уникальный email-адрес',
    icon: 'mail-minus',
    category: 'clean',
    cost: 'free',
    priority: 50,
    requiresColumns: [['email', 'e-mail', 'почта', 'mail']],
    recommendedAfter: ['split_emails'],
  },
  {
    key: 'validate_emails',
    label: 'Валидация Email',
    description: 'Проверяет доставляемость и убирает невалидные',
    icon: 'mail-check',
    category: 'enrich',
    cost: 'api',
    priority: 55,
    requiresColumns: [['email', 'e-mail', 'почта', 'mail']],
    recommendedAfter: ['split_emails', 'dedup_email'],
  },
  {
    key: 'cap_emails_per_company',
    label: 'До N почт на компанию',
    description: 'Оставляет не больше N email-адресов на одну компанию, приоритет — подтверждённые (ok), затем catch-all',
    icon: 'mail-minus',
    category: 'clean',
    cost: 'free',
    priority: 57,
    requiresColumns: [['email', 'e-mail', 'почта', 'mail']],
    recommendedAfter: ['validate_emails'],
  },
  {
    key: 'clean_names',
    label: 'Очистить названия',
    description: 'AI очищает названия компаний от мусора (ООО, LLC и т.п.)',
    icon: 'sparkles',
    category: 'clean',
    cost: 'ai',
    priority: 60,
    requiresColumns: [['компания', 'company', 'name', 'название']],
  },
  {
    key: 'enrich_descriptions',
    label: 'Обогатить описаниями',
    description: 'Извлекает описание компании с сайта',
    icon: 'file-text',
    category: 'enrich',
    cost: 'cheap',
    priority: 65,
    requiresColumns: [['сайт', 'site', 'website', 'url', 'домен', 'domain']],
    recommendedAfter: ['check_sites'],
  },
  {
    key: 'ta_scoring',
    label: 'Оценка ЦА',
    description: 'AI оценивает релевантность компаний по брифу (0-10)',
    icon: 'target',
    needsConfig: 'brief',
    category: 'ai',
    cost: 'ai',
    priority: 80,
    recommendedAfter: ['enrich_descriptions'],
  },
  {
    key: 'personalization',
    label: 'Персонализация',
    description: 'AI генерирует персонализированное предложение',
    icon: 'pen-line',
    needsConfig: 'prompt',
    category: 'ai',
    cost: 'ai',
    priority: 90,
    recommendedAfter: ['enrich_descriptions', 'clean_names'],
  },
];

const STEP_PRIORITY_MAP = new Map(AVAILABLE_STEPS.map((s) => [s.key, s.priority]));

/**
 * Sort selected steps by optimal execution order.
 * Lower priority = run first (free/cheap before expensive AI).
 */
export function sortStepsByOptimalOrder(steps: StepKey[]): StepKey[] {
  return [...steps].sort((a, b) =>
    (STEP_PRIORITY_MAP.get(a) ?? 999) - (STEP_PRIORITY_MAP.get(b) ?? 999),
  );
}

const STEP_DEF_MAP = new Map(AVAILABLE_STEPS.map((s) => [s.key, s]));

/**
 * Check which columns are present in the header (case-insensitive).
 * Accounts for columns produced by earlier steps in the pipeline.
 * Returns warnings only for genuinely missing columns.
 */
export function getStepWarnings(
  steps: StepKey[],
  header: string[],
): Map<StepKey, string> {
  const availableCols = new Set(header.map((h) => h.trim().toLowerCase()));
  const warnings = new Map<StepKey, string>();

  for (const key of steps) {
    const def = STEP_DEF_MAP.get(key);
    if (def?.requiresColumns) {
      for (const colGroup of def.requiresColumns) {
        const found = colGroup.some((name) => availableCols.has(name.toLowerCase()));
        if (!found) {
          warnings.set(key, `Нужна колонка «${colGroup[0]}»`);
          break;
        }
      }
    }
    if (def?.producesColumns) {
      for (const col of def.producesColumns) {
        availableCols.add(col.toLowerCase());
      }
    }
  }

  return warnings;
}
