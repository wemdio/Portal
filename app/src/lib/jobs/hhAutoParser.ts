/**
 * HH.ru parser for the client auto-pipeline.
 *
 * Каждое утро cron-задача спрашивает у HH «какие компании опубликовали
 * вакансии за последние 24 часа?» — это база для авто-пайплайна одного
 * клиента (см. /docs/auto-pipeline — TODO). Парсер унаследовал логику из
 * app/scripts/hh-fleet-base.mjs, но переписан под TypeScript и под
 * «любые компании» (без обязательного индустриального фильтра).
 *
 * Ключевые особенности:
 *
 *   1. HH /vacancies принимает date_from в формате YYYY-MM-DDTHH:MM:SS. Так
 *      что «новые за 24 часа» — это date_from = (now − 24h), без явного
 *      фильтра по индустрии/ключевикам, который можно опционально добавить.
 *
 *   2. HH ограничивает выдачу 2000 элементов (20 страниц × 100). Для нашего
 *      объёма 20k/мес ≈ 700/день — 2000 вакансий гарантированно содержат
 *      больше 700 уникальных работодателей. Если очень понадобится больше —
 *      придётся итерировать по регионам или индустриям; пока не нужно.
 *
 *   3. Детали работодателя (site_url, employee_count) запрашиваются вторым
 *      запросом /employers/{id}, потому что /vacancies возвращает только
 *      employer.id+name+alternate_url. На каждый детальный запрос — sleep
 *      ~250 мс, чтобы не упереться в rate-limit HH (1 rps для анонима).
 *
 *   4. Фильтрация:
 *        — excludePatterns: regex против имени работодателя (федеральные
 *          бренды-исключения, чтобы не слать им холодное письмо).
 *        — maxEmployees: отсекаем огромные компании (наш ICP — small/mid).
 *        — limit: общий cap, остановка пагинации.
 */

const HH_API_BASE = 'https://api.hh.ru';
const USER_AGENT = 'PortalBot/1.0 (sergey@wemd.io)';
const REQUEST_GAP_MS = 250;
const MAX_PAGES = 20;
const PAGE_SIZE = 100;

// До 2026-04 HH банил по IP — приходилось ходить через proxy (undici.ProxyAgent).
// С обязательным OAuth идентификация per-token, не per-IP, и партнёрский токен
// HH_ACCESS_TOKEN даёт лимит ~10 RPS напрямую с любого IP. Поэтому undici/proxy
// инфраструктура удалена — простой глобальный fetch (Node 18+) + Bearer header.
// Проверка реальными запросами с моей машины (вне РФ) → 200 OK, 0 ошибок.

export interface HhAutoParserConfig {
  /** Only include vacancies published at or after this moment. */
  since: Date;
  /** HH area id. Default 113 (Russia). */
  area?: string;
  /** Optional industry ids — when set, parser iterates one search per industry. */
  industries?: string[];
  /** Optional keywords — when set, parser iterates one search per keyword × industry. */
  keywords?: string[];
  /** Regex patterns matched against employer name; matches are excluded. */
  excludePatterns?: RegExp[];
  /** Max employees count (parsed from "100-500" → 100). Larger employers are skipped. */
  maxEmployees?: number;
  /** Hard cap on returned employers, applied after filtering. */
  limit?: number;
  /** Optional logger for observability. */
  log?: (msg: string) => void;
}

export interface HhEmployer {
  /** HH employer id. */
  id: string;
  /** Public-facing employer name. */
  name: string;
  /** Company website extracted from /employers/{id}. */
  siteUrl: string | null;
  /** HH employer page (e.g. https://hh.ru/employer/12345). */
  hhUrl: string | null;
  /** Primary region name (e.g. "Москва"). */
  area: string | null;
  /** Industry names this employer is tagged with (joined from HH industries). */
  industries: string[];
  /** First parsed number from employee_count, e.g. "100-500" → 100. */
  employeeCount: number | null;
  /** Title of a recent vacancy that surfaced this employer (debug context). */
  vacancyTitle?: string;
}

/** Domain extracted from siteUrl if any — useful for the scoring endpoint. */
export function deriveDomain(siteUrl: string | null): string | null {
  if (!siteUrl) return null;
  try {
    const u = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`);
    return u.hostname.replace(/^www\./, '').toLowerCase() || null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HH API с 2026-04-15 требует OAuth Bearer для /vacancies и /employers.
 * Без токена возвращает 403 «forbidden» даже с правильным User-Agent и из
 * российского IP. Токен лежит в HH_ACCESS_TOKEN, обновляется отдельным
 * процессом (token-refresh worker, см. hhParser.ts).
 */
function buildHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
  const token = process.env.HH_ACCESS_TOKEN?.trim();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: buildHeaders(),
    });
    if (!res.ok) {
      // Полезный сигнал для отладки — HH 403 (geo-блок) или 429 (rate-limit)
      // должны быть видны в логе, а не теряться молча.
      if (res.status === 403 || res.status === 429) {
        console.warn(`[hhAutoParser] HH returned ${res.status} for ${url} — proxy issue?`);
      }
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[hhAutoParser] fetch error for ${url}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

interface HhVacancyResponse {
  found?: number;
  items?: Array<{
    name?: string;
    employer?: { id?: string; name?: string; alternate_url?: string };
  }>;
}

interface HhEmployerResponse {
  id?: string;
  name?: string;
  site_url?: string;
  alternate_url?: string;
  area?: { name?: string };
  industries?: Array<{ name?: string }>;
  employee_count?: string;
  description?: string;
}

interface CandidateEmployer {
  id: string;
  name: string;
  hhUrl: string | null;
  vacancyTitle: string;
}

/** Format Date as the YYYY-MM-DDTHH:MM:SS HH wants in date_from. */
function formatDateFrom(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
  );
}

/**
 * One pagination loop over /vacancies for a given query.
 *
 * Возвращает уникальных работодателей (Map by employer.id), отсечённых HH'ом
 * как published since `since`. Дальнейшая фильтрация (имя, размер) — отдельным
 * шагом, потому что для размера нужен второй запрос /employers/{id}.
 */
async function searchVacancyPages(
  params: URLSearchParams,
  log: (m: string) => void,
): Promise<Map<string, CandidateEmployer>> {
  const employers = new Map<string, CandidateEmployer>();
  let page = 0;

  while (page < MAX_PAGES) {
    params.set('per_page', String(PAGE_SIZE));
    params.set('page', String(page));

    const url = `${HH_API_BASE}/vacancies?${params.toString()}`;
    const data = await fetchJson<HhVacancyResponse>(url);
    if (!data || !data.items || data.items.length === 0) break;

    for (const vac of data.items) {
      const emp = vac.employer;
      if (!emp?.id || !emp.name) continue;
      if (!employers.has(emp.id)) {
        employers.set(emp.id, {
          id: emp.id,
          name: emp.name,
          hhUrl: emp.alternate_url ?? null,
          vacancyTitle: vac.name ?? '',
        });
      }
    }

    log(`  page ${page}: ${data.items.length} vacancies, ${employers.size} unique employers so far`);

    const totalPages = data.found ? Math.ceil(data.found / PAGE_SIZE) : 0;
    if (data.items.length < PAGE_SIZE || page >= totalPages - 1) break;
    page++;
    await sleep(REQUEST_GAP_MS);
  }

  return employers;
}

/** Pull /employers/{id} details for one candidate. Returns null on HH error. */
async function fetchEmployerDetails(empId: string): Promise<HhEmployerResponse | null> {
  return fetchJson<HhEmployerResponse>(`${HH_API_BASE}/employers/${empId}`);
}

function parseEmployeeCount(raw: string | undefined | null): number | null {
  if (!raw) return null;
  const m = raw.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Main entry point.
 *
 * Логика:
 *   1. Собираем кандидатов (employer.id, name) через /vacancies. Если в
 *      config'е заданы keywords/industries — итерируем; иначе один общий
 *      запрос с date_from + area.
 *   2. Применяем excludePatterns (по имени) — дешёвый шаг, до обогащения.
 *   3. Для оставшихся тянем /employers/{id} — это даёт site_url + размер.
 *   4. Отсекаем по maxEmployees.
 *   5. Сортируем стабильно (по id), режем по limit.
 */
export async function findNewHhEmployers(
  config: HhAutoParserConfig,
): Promise<HhEmployer[]> {
  const log = config.log ?? (() => undefined);
  const area = config.area ?? '113';
  const since = formatDateFrom(config.since);

  log(`HH: collecting vacancies since ${since}, area=${area}`);

  // 1) Гипотезы для поиска. Без keywords/industries — один общий проход.
  const queries: URLSearchParams[] = [];
  const keywords = config.keywords && config.keywords.length > 0 ? config.keywords : [null];
  const industries = config.industries && config.industries.length > 0 ? config.industries : [null];

  for (const kw of keywords) {
    for (const ind of industries) {
      const params = new URLSearchParams();
      params.set('date_from', since);
      params.set('area', area);
      if (kw) params.set('text', kw);
      if (ind) params.set('industry', ind);
      queries.push(params);
    }
  }

  // 2) Собираем кандидатов из всех queries в один Map.
  const candidates = new Map<string, CandidateEmployer>();
  for (let i = 0; i < queries.length; i++) {
    log(`HH: query ${i + 1}/${queries.length}: ${queries[i].toString()}`);
    const part = await searchVacancyPages(queries[i], log);
    for (const [id, emp] of part) {
      if (!candidates.has(id)) candidates.set(id, emp);
    }
    if (i < queries.length - 1) await sleep(REQUEST_GAP_MS);
  }

  log(`HH: ${candidates.size} unique candidate employers before filtering`);

  // 3) Фильтрация по имени — до обогащения, дёшево.
  const excludePatterns = config.excludePatterns ?? [];
  const afterNameFilter: CandidateEmployer[] = [];
  for (const c of candidates.values()) {
    if (excludePatterns.some((p) => p.test(c.name))) continue;
    afterNameFilter.push(c);
  }

  log(`HH: ${afterNameFilter.length} employers after name-exclude filter`);

  // 4) Жёсткий лимит «обогащать максимум N» — чтобы не дёргать /employers
  //    по 2000 раз, если клиенту хватит 700. Берём limit × 2 как буфер
  //    (часть отвалится из-за maxEmployees, отсутствия site_url и т.д.).
  const limit = config.limit ?? 1000;
  const enrichmentBudget = Math.min(afterNameFilter.length, Math.max(limit * 2, 100));
  const toEnrich = afterNameFilter.slice(0, enrichmentBudget);

  log(`HH: enriching ${toEnrich.length} employers (budget=${enrichmentBudget})`);

  // 5) Подгружаем детали по каждому.
  const results: HhEmployer[] = [];
  let skippedLarge = 0;
  let skippedNoSite = 0;

  for (const c of toEnrich) {
    const details = await fetchEmployerDetails(c.id);
    await sleep(REQUEST_GAP_MS);

    if (!details) continue;

    const employeeCount = parseEmployeeCount(details.employee_count);
    if (
      typeof config.maxEmployees === 'number' &&
      employeeCount !== null &&
      employeeCount > config.maxEmployees
    ) {
      skippedLarge++;
      continue;
    }

    const siteUrl = details.site_url?.trim() || null;
    if (!siteUrl) {
      // Без сайта нечего отдавать в endpoint клиента (он принимает домен).
      // Также для stepFindEmails нужен URL.
      skippedNoSite++;
      continue;
    }

    results.push({
      id: c.id,
      name: c.name,
      siteUrl,
      hhUrl: c.hhUrl,
      area: details.area?.name ?? null,
      industries: (details.industries ?? []).map((i) => i.name ?? '').filter(Boolean),
      employeeCount,
      vacancyTitle: c.vacancyTitle,
    });

    if (results.length >= limit) break;
  }

  log(
    `HH: produced ${results.length} employers ` +
      `(skipped: large=${skippedLarge}, no-site=${skippedNoSite})`,
  );

  return results;
}
