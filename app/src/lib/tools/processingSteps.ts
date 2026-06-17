/**
 * Shared processing step functions for base pipelines.
 * Used by both DFYB worker and Base Constructor worker.
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
} from './dfybUtils';
import { scrapeEmails } from '@/lib/enrich/emailScraper';
import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import { validateEmail, type DomainInfo } from '@/lib/emailValidation/validator';

export type ProgressFn = (progress: number) => Promise<void>;
export type CancelCheckFn = () => Promise<boolean>;
export type CheckpointFn = (data: string[][]) => Promise<void>;

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
const EMAIL_CONCURRENCY = 15;
const ENRICH_CONCURRENCY = 5;
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
// 50, не 100: на батче в 100 компаний модель `policy/cleanup` упиралась в лимит
// выходных токенов и ОБРЫВАЛА JSON на полпути (~55 из 100) → невалидный JSON →
// парсер падал, а text-fallback писал сырой блоб в ячейку. Меньший батч с
// запасом влезает в ответ. parseCleanupResponseJson дополнительно умеет
// доставать элементы из оборванного ответа (truncation salvage).
const CLEANUP_BATCH = 50;
const PERSONALIZATION_BATCH = 5;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callOpenRouter(
  apiKey: string,
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; max_tokens?: number; json?: boolean; title?: string } = {},
): Promise<string> {
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
        return json.choices?.[0]?.message?.content || '';
      }
      if ([502, 503, 504].includes(res.status) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY * 2 ** attempt);
        continue;
      }
      throw new Error(`OpenRouter ${res.status}`);
    } catch (err) {
      clearTimeout(timeout);
      if (attempt >= MAX_RETRIES) throw err;
      await sleep(RETRY_BASE_DELAY * 2 ** attempt);
    }
  }
  throw new Error('OpenRouter max retries exceeded');
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

function hostOf(raw: string): string {
  let v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (!/^https?:\/\//.test(v)) v = `https://${v}`;
  try { return new URL(v).hostname.replace(/^www\./, ''); } catch { return ''; }
}

export function isNonScrapeableHost(raw: string): boolean {
  const host = hostOf(raw);
  if (!host) return false;
  return NON_SCRAPEABLE_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
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

  const existingEmailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const wantsSeparate = options?.target === 'separate';

  // Target column resolution:
  //   - target='separate' + есть существующая email-колонка → пишем в FOUND_EMAIL_COL (новая);
  //   - target='separate' + НЕТ email-колонки → нечего «отделять», fallback к 'same' (создаём «Email»);
  //   - target='same' (или не указан) + есть email-колонка → дополняем её (legacy);
  //   - target='same' + НЕТ email-колонки → создаём «Email».
  let targetIdx: number;
  if (wantsSeparate && existingEmailIdx >= 0) {
    const foundExistingFoundIdx = header.findIndex((h) => h.trim() === FOUND_EMAIL_COL);
    if (foundExistingFoundIdx >= 0) {
      // Re-run / resume: колонка уже создана прошлым проходом. Используем её.
      targetIdx = foundExistingFoundIdx;
    } else {
      targetIdx = header.length;
      header = [...header, FOUND_EMAIL_COL];
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
    .filter((r) => r.url && !extractEmail(r.row[targetIdx] || '') && !isNonScrapeableHost(r.url));

  if (toProcess.length === 0) { await onProgress(100); return [header, ...body]; }

  let done = 0;
  // checkpoint каждые 250 строк — мерж между «свежими данными при resume»
  // и «не флудим DB на каждой строке». На 4297-строчной базе это ~17
  // запросов общим объёмом ~70MB (один update jsonb ~4MB).
  const checkpointEvery = 250;
  const onCheckpoint = options?.onCheckpoint;
  await processInPool(toProcess, EMAIL_CONCURRENCY, async (item) => {
    if (isCancelled && await isCancelled()) return;
    try {
      // stopAtFirstUsableEmail: bail as soon as the homepage / first
      // contact page gives us a usable address. Base-constructor only
      // needs one — the worker doesn't use the extra addresses, and
      // crawling 4 more pages per company is the dominant time sink.
      const { emails } = await scrapeEmails(item.url, {
        timeout: 15_000,
        maxPages: 5,
        stopAtFirstUsableEmail: true,
      });
      if (emails.length > 0) {
        body[item.i][targetIdx] = emails.join(', ');
      }
    } catch { /* skip */ }
    done++;
    if (done % 10 === 0 || done === toProcess.length) {
      await onProgress(Math.round((done / toProcess.length) * 100));
    }
    if (onCheckpoint && (done % checkpointEvery === 0 || done === toProcess.length)) {
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

export async function stepEnrich(
  data: string[][],
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
  onCheckpoint?: CheckpointFn,
): Promise<string[][]> {
  const header = data[0];
  const body = data.slice(1);
  const descIdx = findColumnIndex(header, 'описание', 'description');
  const siteIdx = findColumnIndex(header, 'сайт', 'site', 'website', 'url', 'домен', 'domain');

  if (siteIdx < 0) { await onProgress(100); return data; }

  const needsNewCol = descIdx < 0;
  const targetDescIdx = needsNewCol ? header.length : descIdx;
  const newHeader = needsNewCol ? [...header, 'Описание'] : [...header];

  const newBody = needsNewCol ? body.map((row) => [...row, '']) : body.map((row) => [...row]);

  const toProcess = newBody
    .map((row, i) => ({ row, i, url: (row[siteIdx] || '').trim() }))
    .filter((r) => r.url && !(r.row[targetDescIdx] || '').trim() && !isNonScrapeableHost(r.url));

  if (toProcess.length === 0) { await onProgress(100); return [newHeader, ...newBody]; }

  let done = 0;
  let timedOut = 0;
  const checkpointEvery = 250;
  await processInPool(toProcess, ENRICH_CONCURRENCY, async (item, _i, signal) => {
    if (isCancelled && await isCancelled()) return;
    try {
      // signal comes from the pool's per-task watchdog. Pass it down so a
      // tarpit website's fetch is aborted at ENRICH_PER_SITE_TIMEOUT_MS.
      const text = await fetchAndExtract(item.url, { timeout: 15_000, signal });
      if (text) newBody[item.i][targetDescIdx] = text.slice(0, 2000);
    } catch {
      if (signal?.aborted) {
        timedOut += 1;
        // No log per-site to avoid spamming — aggregate count printed below.
      }
      // Other errors silently skipped: site is unreachable / blocked.
    }
    done++;
    if (done % 10 === 0 || done === toProcess.length) {
      await onProgress(Math.round((done / toProcess.length) * 100));
    }
    if (onCheckpoint && (done % checkpointEvery === 0 || done === toProcess.length)) {
      await onCheckpoint([newHeader, ...newBody]);
    }
  }, {
    taskTimeoutMs: ENRICH_PER_SITE_TIMEOUT_MS,
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

ФОРМАТ ОТВЕТА: Только JSON массив, без пояснений.
[{"idx": 0, "score": 7, "reason": "краткое обоснование на русском"}]`;

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
  }) => void;
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
  const newHeader = [...header, 'ЦА Балл', 'ЦА Причина'];
  const scored: string[][] = [];

  for (let batch = 0; batch < body.length; batch += TA_BATCH) {
    if (isCancelled && await isCancelled()) throw new Error('Отменено');
    const chunk = body.slice(batch, batch + TA_BATCH);
    const companies = chunk.map((row, bIdx) => {
      const obj: Record<string, string> = {};
      header.forEach((h, c) => { obj[h] = row[c] || ''; });
      return { idx: bIdx, data: obj };
    });

    const userMsg = `Бриф:\n${brief.slice(0, 4000)}\n\nКомпании:\n${JSON.stringify(companies)}`;
    try {
      const content = await callOpenRouter(OPENROUTER_BRIEF_API_KEY, AI_MODEL, [
        { role: 'system', content: TA_SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ], { temperature: 0.2, json: true, title: 'Portal - Base Constructor TA Scoring' });

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
        const raw = codeBlock ? codeBlock[1].trim() : content.trim();
        const arrMatch = raw.match(/\[[\s\S]*\]/);
        parsed = arrMatch ? JSON.parse(arrMatch[0]) : JSON.parse(raw);
      }
      const scores = (Array.isArray(parsed) ? parsed : []) as { idx: number; score: number; reason: string }[];
      const scoreMap = new Map(scores.map((s) => [s.idx, s]));

      for (let i = 0; i < chunk.length; i++) {
        const s = scoreMap.get(i);
        scored.push([...chunk[i], String(s?.score ?? 0), s?.reason ?? '']);
      }
    } catch {
      for (const row of chunk) scored.push([...row, '5', 'Ошибка оценки']);
    }

    await onProgress(Math.round(((batch + chunk.length) / body.length) * 100));
  }

  const TA_MIN_SCORE = 7;
  const scoreColIdx = newHeader.length - 2;

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

  options?.onStats?.({
    pre_filter_rows: preFilterRows,
    filtered_out_count: preFilterRows - filtered.length,
    pre_filter_avg_score: preFilterAvg,
  });

  await onProgress(100);
  return [newHeader, ...filtered];
}

/* ═══════════════════════════════════════════
   STEP: Name cleanup
   ═══════════════════════════════════════════ */

const CLEANUP_SYSTEM_PROMPT = `Ты очищаешь названия компаний для использования в персонализированных email-письмах.

Правила очистки:
1. Оставь только само название (2-3 слова максимум)
2. Удали: Inc, Ltd, Corp, LLC, ООО, ИП, АО, ЗАО, GmbH и т.п.
3. Удали текст после: -, |, /, ,, :
4. Удали текст в скобках
5. Удали символы: ®, ™, ©, #, !, ?
6. Если >3 слов — сделай аббревиатуру (если уместно)
7. Если всё КАПСОМ (6+ букв) — преобразуй в Title Case
8. Результат должен красиво звучать в предложении: "Я заметил что КОМПАНИЯ..."

ФОРМАТ ВВОДА: JSON-объект {"companies": [{"idx": 0, "name": "...", "domain": "..."?}, ...]}
ФОРМАТ ОТВЕТА: только JSON-объект {"cleaned": [{"idx": 0, "name": "очищенное"}, ...]}.
Каждому idx из ввода должен соответствовать ровно один элемент в cleaned с тем же idx.
Если не знаешь как очистить — верни оригинальное name. НИКОГДА не пропускай элементы.
Никаких пояснений, никаких markdown-обёрток вокруг JSON.`;

/**
 * Стрипает префиксы вида «N.», «N)» с начала строки, и так до упора.
 *
 * Зачем жадно: AI'а мы просим вернуть строки вида "{N}. Очищенное Название",
 * но модель регулярно глючит:
 *   - повторяет один номер для всех строк подряд (10. A, 10. B, 10. C);
 *   - оборачивает оригинальное «10. ПК ЗВМП» во внешний нумер и возвращает
 *     «1. 10. ПК ЗВМП» — внешний номер мы должны убрать, но внутренний
 *     тоже мусор для финальной базы;
 *   - в positional-fallback'е (когда <80% строк нумерованы) раньше префикс
 *     вообще не стрипался и пролезал в БД (жалоба специалиста: «в рандомных
 *     компаниях цифры в начале»).
 *
 * Trade-off: имя типа «1.5 кг» с точкой превратится в «5 кг», «12. серия»
 * → «серия». В B2B-базе названий компаний такое почти не встречается,
 * принимаем как осознанный риск ради устранения регресса с цифрами.
 *
 * Лимит на 5 итераций — защита от теоретической бесконечности; на практике
 * двух хватает («35. 10. ПК ЗВМП» → «10. ПК ЗВМП» → «ПК ЗВМП»).
 *
 * Применяется и в JSON-режиме (на случай если AI вшил префикс в name),
 * и в legacy text-fallback'е.
 */
const NUMBER_PREFIX_RE = /^(\d+)[.)]\s*/;
function stripNumberPrefix(s: string): string {
  let out = s;
  for (let i = 0; i < 5; i += 1) {
    const next = out.replace(NUMBER_PREFIX_RE, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * Основной парсер (JSON-mode).
 *
 * Зачем: text-парсер исторически разбирался регэкспами по нумерованному
 * списку, и когда AI терялся в нумерации (повторял один номер для всей
 * пачки), парсер скатывался в positional fallback и пропускал «N. » префикс
 * в БД. С JSON-mode (response_format: json_object) модель обязана вернуть
 * валидный JSON со структурой {cleaned: [{idx, name}, ...]} — никаких
 * парсингов строк, никакого fallback'а нужно.
 *
 * Robust: salvage из markdown-блока ```json ...``` если модель проигнорировала
 * response_format и завернула; пропуск элементов без idx/name; финальный
 * stripNumberPrefix на name как safety-net (вдруг AI вшил «1. » внутрь name'а).
 *
 * Возвращает null если JSON вовсе не достали — caller тогда упадёт
 * на text-парсер как fallback.
 */
export function parseCleanupResponseJson(
  content: string,
): Map<number, string> | null {
  let parsed: unknown = null;
  // 1) Прямой JSON.parse.
  try {
    parsed = JSON.parse(content);
  } catch {
    // 2) Salvage: модель завернула в markdown ```json ...```.
    const codeBlock = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlock) {
      try { parsed = JSON.parse(codeBlock[1].trim()); } catch { /* fallthrough */ }
    }
    // 3) Salvage: вырезаем по самым внешним { ... }.
    if (parsed === null) {
      const objMatch = content.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try { parsed = JSON.parse(objMatch[0]); } catch { /* fallthrough */ }
      }
    }
  }

  const cleaned =
    parsed && typeof parsed === 'object'
      ? (parsed as { cleaned?: unknown }).cleaned
      : null;

  if (Array.isArray(cleaned)) {
    // idx в JSON — 0-based (натурально для разработчика), а в map ключи 1-based
    // (так лукапит существующий stepNameCleanup: cleanedMap.get(i + 1)).
    // Транслируем idx → idx+1 при записи.
    const result = new Map<number, string>();
    for (const item of cleaned) {
      if (!item || typeof item !== 'object') continue;
      const { idx, name } = item as { idx?: unknown; name?: unknown };
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0) continue;
      if (typeof name !== 'string') continue;
      const trimmed = name.trim();
      if (!trimmed) continue;
      const stripped = stripNumberPrefix(trimmed);
      if (stripped) result.set(idx + 1, stripped);
    }
    if (result.size > 0) return result;
  }

  // 4) Truncation salvage. Модель часто ОБРЫВАЕТ ответ на полпути (упирается в
  //    лимит выходных токенов на батче), валидного JSON нет вовсе, и шаги 1-3
  //    дают null. Достаём по отдельности все ПОЛНОСТЬЮ закрытые пары
  //    "idx":N,"name":"...", восстанавливая префикс до точки обрыва. Без этого
  //    весь батч терялся, а text-fallback писал сырой JSON-блоб в ячейку
  //    «компания» (баг, видимый в выгрузке клиента 17.06).
  const salvaged = new Map<number, string>();
  const ITEM_RE = /"idx"\s*:\s*(\d+)\s*,\s*"name"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = ITEM_RE.exec(content)) !== null) {
    const idx = Number(m[1]);
    if (!Number.isInteger(idx) || idx < 0) continue;
    let name = m[2];
    try { name = JSON.parse(`"${name}"`) as string; } catch { /* оставляем сырой */ }
    const stripped = stripNumberPrefix(name.trim());
    if (stripped) salvaged.set(idx + 1, stripped);
  }
  return salvaged.size > 0 ? salvaged : null;
}

/**
 * Legacy text-парсер (fallback).
 *
 * Два режима:
 *   1. Strict numbered — если >=80% строк имеют префикс «N.», используем
 *      его как ключ. Робастно к перестановкам, пропускам, лишним строкам
 *      типа «Очищенные названия:».
 *   2. Positional fallback — если префиксов мало (модель забыла нумеровать,
 *      или повторила один номер для всех строк), выстраиваем строки по
 *      позиции i → row i+1. Здесь критично ВСЁ ЖЕ стрипать префиксы — иначе
 *      мусор типа «10. ПК ЗВМП» пролезет в БД как есть (это и был баг).
 *
 * После перехода на JSON-mode (parseCleanupResponseJson выше) этот парсер
 * остался как страховка на случай если модель проигнорировала
 * response_format: json_object и вернула старый текстовый формат.
 *
 * Возвращает null если ответ пустой.
 */
export function parseCleanupResponse(
  content: string,
  expectedCount: number,
): Map<number, string> | null {
  const numbered = new Map<number, string>();
  const cleanLines: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const numMatch = trimmed.match(NUMBER_PREFIX_RE);
    const cleaned = stripNumberPrefix(trimmed);
    if (!cleaned) continue; // строка состояла только из префикса — мусор
    if (numMatch) numbered.set(parseInt(numMatch[1], 10), cleaned);
    cleanLines.push(cleaned);
  }
  if (cleanLines.length === 0) return null;
  if (numbered.size >= expectedCount * 0.8) return numbered;
  // Positional fallback. Логируем, чтобы по jobId можно было искать
  // «cleanup упал в fallback» — индикатор что модель отвечает плохо
  // и стоит дробить батчи или менять prompt.
  console.warn(
    `[base-constructor] cleanup positional fallback: only ${numbered.size}/${expectedCount} lines numbered`,
  );
  const positional = new Map<number, string>();
  for (let j = 0; j < cleanLines.length && j < expectedCount; j += 1) {
    const line = cleanLines[j];
    // Защита от порчи данных: строки, похожие на JSON ({…}/[…]) или аномально
    // длинные (>120) — это почти наверняка сырой ответ модели, а не название
    // компании. Раньше такой блоб целиком писался в ячейку «компания».
    if (line && line.length <= 120 && !/^[[{]/.test(line)) positional.set(j + 1, line);
  }
  return positional;
}

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
    const companies = chunk.map((row, i) => {
      const obj: Record<string, unknown> = { idx: i, name: row[nameIdx] || '' };
      if (siteIdx >= 0 && row[siteIdx]) obj.domain = row[siteIdx];
      return obj;
    });
    const userMsg = JSON.stringify({ companies });

    let cleanedMap: Map<number, string> | null = null;
    try {
      const content = await callOpenRouter(OPENROUTER_CLEANUP_API_KEY, CLEANUP_MODEL, [
        { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
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
   * Callback для checkpoint'а данных каждые N строк. То же зачем что
   * и в stepFindEmails: на redeploy/crash посреди шага следующий worker
   * читает свежий checkpoint вместо стартовых данных и продолжает с
   * проверенной части. Validate медленнее scrape'а (SMTP+DNS), так что
   * без checkpoint'а потеря прогресса на длинных базах особенно болезненна.
   */
  onCheckpoint?: CheckpointFn;
}

export async function stepValidateEmails(
  data: string[][],
  onProgress: ProgressFn,
  isCancelled?: CancelCheckFn,
  options?: StepValidateEmailsOptions,
): Promise<string[][]> {
  const dropRowsWithoutEmail = options?.dropRowsWithoutEmail ?? true;
  const header = data[0];
  const body = data.slice(1);
  const originalEmailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const foundEmailIdx = header.findIndex((h) => h.trim() === FOUND_EMAIL_COL);

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
  const newHeader = [...header];
  const newBody = body.map((row) => [...row]);
  const meta: { srcIdx: number; statusIdx: number; providerIdx: number; label: string }[] = [];
  for (const idx of indicesToValidate) {
    const srcLabel = header[idx];
    const statusName = `${srcLabel} Статус`;
    const providerName = `${srcLabel} Провайдер`;
    const statusIdx = newHeader.length;
    newHeader.push(statusName);
    const providerIdx = newHeader.length;
    newHeader.push(providerName);
    for (const row of newBody) { row.push(''); row.push(''); }
    meta.push({ srcIdx: idx, statusIdx, providerIdx, label: srcLabel });
  }

  // Собираем плоский список (rowIdx, sourceIdx, email) для общего пула с
  // concurrency=10. Это лучше чем валидировать колонки последовательно —
  // на «both» получим 2x скорость и общий domainCache для catch-all/free
  // лукапов.
  type ValidationItem = {
    rowIdx: number;
    srcIdx: number;
    email: string;
    statusIdx: number;
    providerIdx: number;
  };
  const toValidate: ValidationItem[] = [];
  for (let r = 0; r < newBody.length; r += 1) {
    for (const m of meta) {
      const email = extractEmail(newBody[r][m.srcIdx] || '');
      if (email) {
        toValidate.push({
          rowIdx: r,
          srcIdx: m.srcIdx,
          email,
          statusIdx: m.statusIdx,
          providerIdx: m.providerIdx,
        });
      }
    }
  }

  if (toValidate.length === 0) { await onProgress(100); return [newHeader, ...newBody]; }

  const domainCache = new Map<string, DomainInfo>();
  let done = 0;
  // checkpoint каждые 250 валидаций. Validate медленнее scrape'а (SMTP+DNS
  // round-trip может быть 1-3s), так что 250 ≈ 5-10 мин работы — окно
  // потенциальной потери прогресса на redeploy не больше.
  const checkpointEvery = 250;
  const onCheckpoint = options?.onCheckpoint;

  await processInPool(toValidate, VALIDATION_CONCURRENCY, async (item) => {
    if (isCancelled && await isCancelled()) return;
    try {
      const result = await validateEmail(item.email, domainCache);
      newBody[item.rowIdx][item.statusIdx] = result.result;
      const domain = item.email.split('@')[1] || '';
      newBody[item.rowIdx][item.providerIdx] = result.is_free ? 'free' : result.is_catch_all ? 'catch-all' : domain;
    } catch {
      newBody[item.rowIdx][item.statusIdx] = 'error';
    }
    done++;
    if (done % 5 === 0 || done === toValidate.length) {
      await onProgress(Math.round((done / toValidate.length) * 100));
    }
    if (onCheckpoint && (done % checkpointEvery === 0 || done === toValidate.length)) {
      await onCheckpoint([newHeader, ...newBody]);
    }
  });

  // Фильтрация: строка остаётся ЕСЛИ хотя бы в одной из валидируемых колонок
  // email прошёл (ok/catch_all). Это семантика «строка имеет хотя бы один
  // рабочий email» — для outreach это и нужно.
  //
  // Дополнительно: для каждой строки в провалившихся колонках обнуляем email
  // (status != ok/catch_all → пишем '' в src-колонку), чтобы в финальном файле
  // не торчал заведомо плохой email. Это касается ТОЛЬКО валидируемых колонок —
  // другие колонки остаются как есть.
  const VALID_STATUSES = new Set(['ok', 'catch_all']);
  const filtered = newBody.filter((row) => {
    let anyValid = false;
    for (const m of meta) {
      const status = row[m.statusIdx];
      if (status === '') continue; // пустой email в этой колонке — не учитываем
      if (VALID_STATUSES.has(status)) {
        anyValid = true;
      } else {
        // Невалидный — чистим src-ячейку чтобы потомки (export, merge) не видели.
        row[m.srcIdx] = '';
      }
    }
    // Строка не имела email ни в одной валидируемой колонке (status='' везде).
    // По умолчанию (dropRowsWithoutEmail=true, base-constructor user flow) —
    // дропаем такую строку: в финальном файле нечего слать на почту.
    // Legacy-режим (dropRowsWithoutEmail=false) — сохраняем строку. Раньше
    // legacy-поведение было хардкодом и давало 74% мусорных строк на выходе
    // (см. job polza@polza.ru 8b188038-…: 1795 пустых строк из 2418).
    const hadAnyEmail = meta.some((m) => row[m.statusIdx] !== '');
    if (!hadAnyEmail) return !dropRowsWithoutEmail;
    return anyValid;
  });

  await onProgress(100);
  return [newHeader, ...filtered];
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
  | 'validate_emails'
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
