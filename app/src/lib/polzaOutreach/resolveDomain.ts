/**
 * S2 — восстановление домена компании.
 *
 * Нормализация домена — спека §8: без протокола/www/пути/параметров, нижний
 * регистр. LinkedIn и job board вместо сайта компании не подставляются никогда.
 *
 * Домен — самая дорогая потеря конвейера: на замере 22.09.2026 он не находился
 * у 61 компании из 100, и до писем доходили единицы. Причины были две, обе
 * лечатся без новых источников данных:
 *
 * 1. Сайт компании нередко лежит прямо в кэше вакансий (company_site_url) —
 *    его просто не смотрели. Это самый точный источник: его отдал ATS самой
 *    компании. Показательный случай — lisinski-law-firm, у которого сайт
 *    lisinskifirm.com: ни по названию, ни угадыванием домена его не получить.
 * 2. Единственным источником был каталог PDL, причём запрос шёл префиксом
 *    `name ilike 'Имя%' limit 40` без сортировки: для короткого названия
 *    («Box», «Momentum») сорок строк набираются задолго до нужной, и точное
 *    совпадение просто не попадало в выборку. Clearbit, который общий резолвер
 *    умеет спрашивать вторым заходом, этот конвейер не звал вовсе.
 *
 * Отсюда порядок попыток: сайт из кэша → точное имя в каталоге → префикс в
 * каталоге (склеивает «Acme Inc» и «Acme») → Clearbit. Каждая следующая
 * дороже предыдущей, поэтому и идут они в таком порядке.
 *
 * Вариантов названия пробуем несколько: в кэше компания зовётся слагом ATS —
 * «lisinski-law-firm», «redcare-pharmacy». Дефисы у таких имён означают
 * пробелы, и без замены точное совпадение не найдётся никогда.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SupabaseClient } from '@supabase/supabase-js';
import { resolveCompanyDomainViaPdl } from '@/lib/parsers/companyDomainResolver';

const execFileP = promisify(execFile);
const CLEARBIT_SUGGEST = 'https://autocomplete.clearbit.com/v1/companies/suggest';

export interface PolzaDomainResolution {
  /** Нормализованный домен ('acme.com') или null, если не разрешился. */
  normalizedDomain: string | null;
  companyWebsite: string | null;
  /** Корзина размера из pdl_companies ('1-10', '11-50', ...), если нашлась. */
  companySize: string | null;
  /** Откуда взяли домен — видно в логе, когда доля доменов вдруг просядет. */
  source: 'cache_site' | 'pdl_exact' | 'pdl_prefix' | 'clearbit' | null;
}

/** Страны кэша (us/gb/...) → полное имя страны, как оно лежит в pdl_companies. */
const PDL_COUNTRY_BY_CODE: Record<string, string> = {
  us: 'united states', gb: 'united kingdom', ca: 'canada', de: 'germany', fr: 'france',
  nl: 'netherlands', ie: 'ireland', es: 'spain', se: 'sweden', ch: 'switzerland',
  be: 'belgium', dk: 'denmark', no: 'norway', fi: 'finland', at: 'austria',
  it: 'italy', pl: 'poland', pt: 'portugal', cz: 'czechia',
};

/** Хостинги вакансий и соцсети: это не сайт компании, даже если ATS отдал их. */
const NOT_A_COMPANY_SITE = [
  'linkedin.com', 'facebook.com', 'twitter.com', 'x.com', 'instagram.com',
  'greenhouse.io', 'lever.co', 'ashbyhq.com', 'workable.com', 'bamboohr.com',
  'recruitee.com', 'smartrecruiters.com', 'teamtailor.com', 'breezy.hr',
  'workday.com', 'myworkdayjobs.com', 'rippling.com', 'jobs.eu', 'europa.eu',
  'indeed.com', 'glassdoor.com', 'notion.site', 'google.com', 'sites.google.com',
];

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/\?.*$/, '')
    .replace(/#.*$/, '')
    .replace(/\/+$/, '')
    .replace(/:\d+$/, '');
}

function isCompanyDomain(domain: string): boolean {
  if (!domain || !domain.includes('.')) return false;
  return !NOT_A_COMPANY_SITE.some((bad) => domain === bad || domain.endsWith(`.${bad}`));
}

function cleanPdlWebsite(value: unknown): string {
  return normalizeDomain(String(value ?? ''));
}

/**
 * Название компании как шаблон LIKE для PostgREST.
 *
 * В значении фильтра запятая, скобки и кавычки — служебные символы, и «Acme,
 * Inc.» уехало бы в базу сломанным запросом. Меняем их на `_`: в LIKE это
 * «любой один символ», то есть шаблон продолжает совпадать с исходным
 * названием, а разбор фильтра не ломается. Заодно обезвреживаем `%`, иначе
 * точное сравнение незаметно превратилось бы в префиксное.
 */
function pdlPattern(name: string): string {
  return name.replace(/[%_,.():"'`\\*]/g, '_');
}

/**
 * Варианты написания названия для точного поиска в каталоге.
 * Слаг ATS — «lisinski-law-firm» — это то же «Lisinski Law Firm» с дефисами
 * вместо пробелов, а название с запятой («Acme, Inc») в каталоге может лежать
 * и без неё.
 */
export function companyNameVariants(companyName: string): string[] {
  const raw = companyName.trim();
  const variants = [
    raw,
    raw.replace(/[-_]+/g, ' '),
    raw.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim(),
    raw.replace(/,/g, ' ').replace(/\s+/g, ' ').trim(),
  ];
  return [...new Set(variants.map((v) => v.trim()).filter((v) => v.length >= 2))];
}

/**
 * Точное совпадение имени в pdl_companies.
 *
 * Страховка от чужого домена та же, что была: если у одноимённых компаний
 * разные сайты, домен не угадываем — сначала пробуем развести их по стране,
 * и только единственный оставшийся сайт считается ответом.
 */
async function lookupPdlExact(
  db: SupabaseClient,
  name: string,
  countryCode: string | null,
): Promise<{ domain: string; size: string | null } | null> {
  // ilike без % — это сравнение без учёта регистра, а не префикс.
  const { data, error } = await db
    .from('pdl_companies')
    .select('name,website,country,size')
    .ilike('name', pdlPattern(name))
    .limit(50);
  if (error || !Array.isArray(data) || data.length === 0) return null;

  let rows = data.filter((row) => cleanPdlWebsite(row?.website));
  if (rows.length === 0) return null;

  const wanted = countryCode ? PDL_COUNTRY_BY_CODE[countryCode.toLowerCase()] : '';
  if (wanted) {
    const byCountry = rows.filter((row) => String(row?.country ?? '').toLowerCase() === wanted);
    if (byCountry.length) rows = byCountry;
  }

  const sites = new Set(rows.map((row) => cleanPdlWebsite(row.website)).filter(isCompanyDomain));
  if (sites.size !== 1) return null;
  const domain = [...sites][0];
  const sizes = new Set(rows.filter((row) => row.size).map((row) => String(row.size)));
  return { domain, size: sizes.size === 1 ? [...sizes][0] : null };
}

/**
 * Размер компании по уже известному домену.
 *
 * Нужен ровно для одного правила ICP — исключения «11–50». Домен мы к этому
 * моменту знаем, но индекса по website в каталоге нет (19.5M строк), поэтому
 * идём тем же запросом по имени и сверяем сайт клиентски.
 */
async function lookupPdlSize(
  db: SupabaseClient,
  companyName: string,
  domain: string,
): Promise<string | null> {
  for (const variant of companyNameVariants(companyName).slice(0, 1)) {
    const { data, error } = await db
      .from('pdl_companies')
      .select('name,website,size')
      .ilike('name', pdlPattern(variant))
      .limit(50);
    if (error || !Array.isArray(data)) continue;
    const sizes = new Set(
      data.filter((row) => cleanPdlWebsite(row?.website) === domain && row?.size).map((row) => String(row.size)),
    );
    if (sizes.size === 1) return [...sizes][0];
  }
  return null;
}

/**
 * Название без пробелов и знаков: «andurilindustries» и «Anduril Industries» —
 * одна и та же компания, и в кэше вакансий она зовётся первым способом.
 */
function collapsedKey(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Clearbit autocomplete — последняя надежда для слагов ATS.
 *
 * Общий резолвер тоже умеет ходить в Clearbit, но принимает подсказку только
 * при точном совпадении имени со всеми пробелами. Слаг «andurilindustries»
 * так не совпадёт никогда, хотя Clearbit по нему честно находит «Anduril
 * Industries» → anduril.com. Поэтому сверяем имена без пробелов и знаков.
 *
 * Одноимённых подсказок бывает несколько (тот же Anduril — три домена, из них
 * два чужих). Берём первую: Clearbit ранжирует их по узнаваемости, и его
 * порядок — единственное, что тут отличает компанию от однофамильцев.
 *
 * Запрос идёт через curl: WAF Clearbit режет node/undici по TLS-отпечатку, а
 * curl пропускает. Тот же приём, что в общем резолвере.
 */
async function resolveViaClearbit(companyName: string): Promise<string> {
  const key = collapsedKey(companyName);
  if (key.length < 3) return '';
  const query = companyName.replace(/[-_]+/g, ' ').trim();
  try {
    const { stdout } = await execFileP(
      'curl',
      ['-sS', '--max-time', '15', '-H', 'Accept: application/json', `${CLEARBIT_SUGGEST}?query=${encodeURIComponent(query)}`],
      { timeout: 20_000, maxBuffer: 1024 * 1024 },
    );
    const suggestions = JSON.parse(stdout) as Array<{ name?: string; domain?: string }>;
    if (!Array.isArray(suggestions)) return '';
    const hit = suggestions.find((s) => collapsedKey(String(s?.name ?? '')) === key && s?.domain);
    const domain = normalizeDomain(String(hit?.domain ?? ''));
    return isCompanyDomain(domain) ? domain : '';
  } catch {
    // Сеть, таймаут, мусор в ответе — просто нет домена, запуск не валим.
    return '';
  }
}

export async function resolveCompanyDomain(
  db: SupabaseClient,
  companyName: string,
  countryCode: string | null,
  companySiteUrl?: string | null,
): Promise<PolzaDomainResolution> {
  const fromCache = normalizeDomain(String(companySiteUrl ?? ''));
  if (isCompanyDomain(fromCache)) {
    return {
      normalizedDomain: fromCache,
      companyWebsite: `https://${fromCache}`,
      companySize: await lookupPdlSize(db, companyName, fromCache),
      source: 'cache_site',
    };
  }

  for (const variant of companyNameVariants(companyName)) {
    const hit = await lookupPdlExact(db, variant, countryCode);
    if (hit) {
      return {
        normalizedDomain: hit.domain,
        companyWebsite: `https://${hit.domain}`,
        companySize: hit.size,
        source: 'pdl_exact',
      };
    }
  }

  // Общий резолвер каталога: префикс плюс склейка «Acme Inc» ↔ «Acme» —
  // то, чего точное совпадение по имени не умеет.
  for (const variant of companyNameVariants(companyName).slice(0, 2)) {
    const domain = normalizeDomain(await resolveCompanyDomainViaPdl(variant, countryCode));
    if (isCompanyDomain(domain)) {
      return {
        normalizedDomain: domain,
        companyWebsite: `https://${domain}`,
        companySize: await lookupPdlSize(db, companyName, domain),
        source: 'pdl_prefix',
      };
    }
  }

  const viaClearbit = await resolveViaClearbit(companyName);
  if (viaClearbit) {
    return {
      normalizedDomain: viaClearbit,
      companyWebsite: `https://${viaClearbit}`,
      companySize: await lookupPdlSize(db, companyName, viaClearbit),
      source: 'clearbit',
    };
  }

  return { normalizedDomain: null, companyWebsite: null, companySize: null, source: null };
}
