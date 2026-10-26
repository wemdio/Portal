import { isIP } from 'node:net';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { readHeEngRegistryText } from './engRegistryHttp';

/**
 * The Finnish Trade Register through PRH's open YTJ API (keyless, CC BY 4.0):
 * companies by main line of business. Since 1 January 2026 the register files
 * TOL 2025 (NACE Rev. 2.1) codes; the API matches a code prefix in every code
 * set, so the reader keeps TOL 2025 lines only. A record has the name, company
 * form, visiting and postal addresses, the registers it is on (the employer
 * register tells a company with staff from a one-person one) and sometimes a
 * website, never a headcount.
 *
 * The API returns 100 records a page in its own fixed order, ceased companies
 * included; a slice position counts those records, 25 a page.
 */
const ENDPOINT = 'https://avoindata.prh.fi/opendata-ytj-api/v3/companies';
const API_PAGE = 100;
const PAGE_SIZE = 25;
const MAX_BYTES = 4 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const CACHE_MS = 6 * 60 * 60_000;
const MAX_CACHED_PAGES = 32;
// Business forms (PRH code table YRMU): limited and public limited companies,
// co-operatives and co-operative banks, partnerships, insurers, savings banks,
// state-owned companies, foreign traders' branches, European companies.
// Housing and property companies, associations and foundations are not buyers.
const FORMS: Readonly<Record<string, string>> = {
  5: 'partnership', 9: 'mortgage society', 11: 'public mutual insurance company', 12: 'mutual insurance company',
  13: 'limited partnership', 14: 'co-operative', 15: 'co-operative bank', 16: 'limited company', 17: 'public limited company',
  19: 'branch of a foreign trader', 20: 'savings bank', 22: 'state-owned company', 23: 'public limited insurance company',
  24: 'limited insurance company', 25: 'insurance association', 80: 'European company', 83: 'European co-operative society',
  84: 'European co-operative bank',
};
const TRADE_REGISTER_ACTIVE = '1';
const EMPLOYER_REGISTER = '7';

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
type Row = Record<string, unknown>;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 500): string {
  return typeof raw === 'string' || typeof raw === 'number'
    ? sliceWholeChars(stripUnstorableJsonChars(String(raw)).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function rows(raw: unknown): Row[] { return Array.isArray(raw) ? raw.filter((item): item is Row => !!item && typeof item === 'object') : []; }
function current(raw: unknown): Row[] { return rows(raw).filter(item => !item.endDate); }
function website(raw: unknown): string {
  const value = str(raw, 2048);
  if (!value) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !host.includes('.') || isIP(host)) return '';
    return url.origin;
  } catch { return ''; }
}
function english(item: Row | undefined): string {
  return str(rows(item?.descriptions).find(description => description.languageCode === '3')?.description, 200);
}

const cache = new Map<string, { at: number; total: number; companies: Row[] }>();
async function apiPage(code: string, page: number, options: Options): Promise<{ total: number; companies: Row[] }> {
  const key = `${code}:${page}`;
  const now = (options.now ?? Date.now)();
  for (const [cached, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(cached);
  const hit = cache.get(key);
  if (hit) return hit;
  const url = new URL(ENDPOINT);
  url.searchParams.set('mainBusinessLine', code);
  url.searchParams.set('page', String(page));
  let body: Row;
  try { body = JSON.parse(await readHeEngRegistryText(url.href, { ...options, accept: 'application/json', maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS })) as Row; }
  catch (error) { if (error instanceof SyntaxError) fail('registry_invalid_response'); throw error; }
  const total = body?.totalResults;
  if (!Number.isSafeInteger(total) || (total as number) < 0 || !Array.isArray(body.companies) || body.companies.length > API_PAGE) fail('registry_invalid_response');
  const entry = { at: now, total: total as number, companies: rows(body.companies) };
  if (cache.size >= MAX_CACHED_PAGES) cache.delete(cache.keys().next().value as string);
  cache.set(key, entry);
  return entry;
}

function address(company: Row): { text: string; kind: 'business' | 'registered' } | null {
  const all = rows(company.addresses);
  for (const [type, kind] of [[1, 'business'], [2, 'registered']] as const) {
    const item = all.find(entry => Number(entry.type) === type && !entry.endDate);
    if (!item) continue;
    const offices = rows(item.postOffices);
    const city = str((offices.find(office => office.languageCode === '1') ?? offices[0])?.city, 100);
    // Street and number only: sites rarely print the staircase or flat, and every address word must appear there.
    const street = str(item.postOfficeBox) ? `PL ${str(item.postOfficeBox, 20)}`
      : [item.street, item.buildingNumber].map(part => str(part, 100)).filter(Boolean).join(' ');
    const text = [street, [str(item.postCode, 10), city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (text.length >= 5 && city) return { text: `${text}, Finland`, kind };
  }
  return null;
}

function candidate(company: Row, task: HeEngRegistryTask, code: string, excluded: Record<string, number>): HeEngRegistryCandidate | null {
  const exclude = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; return null; };
  const line = company.mainBusinessLine as Row | undefined;
  if (line?.typeCodeSet !== 'TOIMI4' || !str(line.type).startsWith(code)) return exclude('category_mismatch');
  if (str(company.tradeRegisterStatus) !== TRADE_REGISTER_ACTIVE || company.endDate) return exclude('inactive');
  const form = str(current(company.companyForms)[0]?.type);
  if (!FORMS[form]) return exclude('not_company');
  const employer = current(company.registeredEntries).some(entry => str(entry.register) === EMPLOYER_REGISTER);
  // A company that is not a registered employer has no staff to count.
  if ((task.minEmployees ?? 0) > 0 && !employer) return exclude('employee_range');
  const businessId = str((company.businessId as Row | undefined)?.value, 20);
  const names = rows(company.names).filter(name => str(name.type) === '1');
  const name = str((names.find(item => !item.endDate) ?? names[0])?.name, 300);
  if (!/^\d{7}-\d$/.test(businessId) || !name) return exclude('missing_identity');
  const place = address(company);
  if (!place) return exclude('country_unconfirmed');
  const registered = str(company.registrationDate, 10).slice(0, 4);
  const activity = `TOL ${str(line.type, 10)} ${english(line)}`.trim();
  return { provider: 'prh', recordId: businessId, company: name, country: 'finland', address: place.text, addressKind: place.kind,
    category: activity, website: website((company.website as Row | undefined)?.url), emails: [],
    description: str(`A Finnish ${FORMS[form]} (${activity})${/^\d{4}$/.test(registered) ? `, registered ${registered}` : ''}; ${employer ? 'on the employer register' : 'not on the employer register'}. From the Finnish Trade Register (PRH open data); employee count requires verification.`, 1500),
    sourceUrl: `https://tietopalvelu.ytj.fi/yritys/${businessId}` };
}

/** One 25-record page of a Finnish slice; the caller validates the task and the position. */
export async function readHeEngPrhRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  const code = task.category.replace('.', '');
  if (task.provider !== 'prh' || task.country !== 'finland' || !/^\d{4}$/.test(code)) fail('registry_invalid_task');
  const { total, companies } = await apiPage(code, Math.floor(position / API_PAGE) + 1, options);
  const records = companies.slice(position % API_PAGE, position % API_PAGE + PAGE_SIZE);
  const excluded: Record<string, number> = {};
  const candidates = records.map(company => candidate(company, task, code, excluded)).filter((item): item is HeEngRegistryCandidate => item !== null);
  return { candidates, nextPosition: position + PAGE_SIZE, exhausted: !records.length || position + records.length >= total,
    excluded, recordsRead: records.length };
}
