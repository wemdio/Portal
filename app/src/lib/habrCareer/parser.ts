/**
 * Habr Career parser – fetches vacancies and company details.
 * Ported from HabrCareerBot (Python) to TypeScript.
 */
import * as cheerio from 'cheerio';
import type { Dispatcher } from 'undici';
import { ProxyAgent } from 'undici';

const CAREER_VACANCIES_TEMPLATE = 'https://career.habr.com/vacancies';
const BASE_URL = 'https://career.habr.com';

const HEADERS: Record<string, string> = {
  accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'ru,en-US;q=0.9,en;q=0.8',
  'cache-control': 'max-age=0',
  'user-agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
};

export type HabrCompanyRow = {
  vacancy_title: string | null;
  vacancy_meta: string | null;
  vacancy_skills: string | null;
  vacancy_url: string | null;
  company_name: string | null;
  company_description: string | null;
  company_addresses: string;
  company_employees: string | null;
  company_site: string | null;
  company_emails: string | null;
  company_contacts: string;
  company_links: string;
  company_url: string;
};

type Vacancy = {
  title: string | null;
  meta: string | null;
  skills: string | null;
  company_url: string | null;
  url: string | null;
};

type Settings = {
  proxy: string;
  pageLimit: number;
  semaphoreCount: number;
};

function parseProxyList(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

let proxyRoundRobin = 0;

/**
 * Берёт прокси по очереди из env:
 * - SEARCH_PROXY_URLS (список)
 * - SEARCH_PROXY_URL (одиночный)
 * - HH_PROXY_URLS (список)
 * - HH_PROXY_URL (одиночный)
 */
function getProxyFromEnv(): string {
  const searchList = parseProxyList((process.env.SEARCH_PROXY_URLS ?? '').trim());
  const hhList = parseProxyList((process.env.HH_PROXY_URLS ?? '').trim());
  const singles = [
    (process.env.SEARCH_PROXY_URL ?? '').trim(),
    (process.env.HH_PROXY_URL ?? '').trim(),
  ].filter(Boolean);

  const proxies = [...searchList, ...hhList, ...singles];
  if (!proxies.length) return '';

  proxyRoundRobin = (proxyRoundRobin + 1) % Number.MAX_SAFE_INTEGER;
  const idx = proxyRoundRobin % proxies.length;
  return proxies[idx] ?? '';
}

function getSettings(): Settings {
  const proxy = getProxyFromEnv();
  const pageLimit = 50;
  const semaphoreCount = 10;
  return { proxy, pageLimit, semaphoreCount };
}

function extractEmails(text: string): string[] {
  const re = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const matches = text.match(re) ?? [];
  return [...new Set(matches)].map((e) => e.trim());
}

function createDispatcher(proxy: string): Dispatcher | undefined {
  if (!proxy.trim()) return undefined;
  const url = proxy.startsWith('http') ? proxy : `http://${proxy}`;
  return new ProxyAgent(url);
}

async function fetchHtml(url: string, dispatcher?: Dispatcher): Promise<string> {
  const init: RequestInit & { dispatcher?: Dispatcher } = {
    headers: HEADERS,
    signal: AbortSignal.timeout(30_000),
  };
  if (dispatcher) init.dispatcher = dispatcher;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`Сервер отклонил запрос с кодом ${res.status}`);
  return res.text();
}

async function getVacancies(
  url: string,
  pageLimit: number,
  dispatcher?: Dispatcher
): Promise<{ status: 'ok'; vacancies: Vacancy[] } | { status: 'error'; error: string }> {
  const vacancies: Vacancy[] = [];
  let page = 1;
  const perPage = 50;

  while (page <= pageLimit) {
    const u = new URL(url);
    u.searchParams.set('page', String(page));
    u.searchParams.set('per_page', String(perPage));

    const html = await fetchHtml(u.toString(), dispatcher);
    const $ = cheerio.load(html);
    const items = $('div.vacancy-card');

    if (items.length === 0 && page === 1) {
      return { status: 'error', error: 'Не удалось найти ни одной вакансии' };
    }

    items.each((_, el) => {
      const $el = $(el);
      const titleEl = $el.find('a.vacancy-card__title-link');
      const title = titleEl.text().trim() || null;
      const metaEl = $el.find('div.vacancy-card__meta');
      const meta = metaEl.text().trim() || null;
      const skillsEl = $el.find('div.vacancy-card__skills');
      const skills = skillsEl.text().trim() || null;
      const companyUrlEl = $el.find('a.link-comp');
      const companyHref = companyUrlEl.attr('href');
      const company_url = companyHref ? BASE_URL + companyHref : null;
      const vacancyHref = titleEl.attr('href');
      const vacancy_url = vacancyHref ? BASE_URL + vacancyHref : null;

      vacancies.push({ title, meta, skills, company_url, url: vacancy_url });
    });

    page += 1;
    if (items.length < perPage) break;
  }

  if (vacancies.length === 0) {
    return { status: 'error', error: 'Не удалось найти ни одной вакансии' };
  }

  return { status: 'ok', vacancies };
}

async function getCompany(
  url: string,
  dispatcher?: Dispatcher
): Promise<{ status: 'ok'; company: Record<string, string | null> } | { status: 'error' }> {
  try {
    const html = await fetchHtml(url, dispatcher);
    const $ = cheerio.load(html);

    const nameEl = $('div.company_name');
    const name = nameEl.text().trim() || null;

    const aboutCompany = $('div.about_company');
    const descriptionEl = aboutCompany.find('div.description');
    let description = descriptionEl.text().trim() || null;
    if (description) description = description.replace(/\n/g, ' ');

    const addressesEl = $('div.addresses');
    const addressEls = addressesEl.find('div.address');
    const addresses = addressEls
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .join('; ');

    const employeesEl = $('div.employees');
    const employees = employeesEl.text().trim() || null;

    const siteEl = $('div.company_site a');
    const site = siteEl.attr('href') ?? null;

    const contactsEl = $('div.contacts');
    const contactEls = contactsEl.find('div.contact');
    const contacts = contactEls
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .join('; ');
    const emails = contacts ? extractEmails(contacts).join(' ') : null;

    const linksEl = $('div.links');
    const linkEls = linksEl.find('div.link');
    const links = linkEls
      .map((_, el) => $(el).text().trim())
      .get()
      .filter(Boolean)
      .join('; ');

    return {
      status: 'ok',
      company: {
        name,
        description,
        addresses,
        employees,
        site,
        emails,
        contacts,
        links,
        url,
      },
    };
  } catch {
    return { status: 'error' };
  }
}

async function runWithSemaphore<T>(
  tasks: (() => Promise<T>)[],
  limit: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

export async function scrapeHabrCareer(
  inputUrl: string
): Promise<{ status: 'ok'; companies: HabrCompanyRow[] } | { status: 'error'; error: string }> {
  const trimmed = inputUrl.trim().split(/\s+/)[0] ?? '';
  if (!trimmed || !trimmed.startsWith(CAREER_VACANCIES_TEMPLATE)) {
    return { status: 'error', error: 'Не удалось найти ссылку на career.habr.com/vacancies' };
  }

  const { proxy, pageLimit, semaphoreCount } = getSettings();
  const dispatcher = createDispatcher(proxy);

  const vacanciesResult = await getVacancies(trimmed, pageLimit, dispatcher);
  if (vacanciesResult.status === 'error') return vacanciesResult;

  const uniqueVacancies = Array.from(
    new Map(vacanciesResult.vacancies.filter((v) => v.company_url).map((v) => [v.company_url!, v])).values()
  );

  const companyUrls = uniqueVacancies.map((v) => v.company_url!);
  const companyResults = await runWithSemaphore(
    companyUrls.map((url) => () => getCompany(url, dispatcher)),
    semaphoreCount
  );

  const detailed: HabrCompanyRow[] = [];
  for (let i = 0; i < uniqueVacancies.length; i++) {
    const vacancy = uniqueVacancies[i];
    const res = companyResults[i];
    if (res?.status !== 'ok' || !vacancy.company_url) continue;

    const c = res.company;
    detailed.push({
      vacancy_title: vacancy.title,
      vacancy_meta: vacancy.meta,
      vacancy_skills: vacancy.skills,
      vacancy_url: vacancy.url,
      company_name: c.name ?? null,
      company_description: c.description ?? null,
      company_addresses: c.addresses ?? '',
      company_employees: c.employees ?? null,
      company_site: c.site ?? null,
      company_emails: c.emails ?? null,
      company_contacts: c.contacts ?? '',
      company_links: c.links ?? '',
      company_url: c.url ?? vacancy.company_url,
    });
  }

  const byUrl = new Map<string, HabrCompanyRow>();
  for (const row of detailed) {
    byUrl.set(row.company_url, row);
  }

  return { status: 'ok', companies: [...byUrl.values()] };
}
