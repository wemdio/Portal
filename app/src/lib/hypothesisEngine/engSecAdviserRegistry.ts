import { isIP } from 'node:net';
import { parse as parseDomain } from 'tldts';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { heCompanySiteIdentity } from './collectionIdentity';
import { normalizeEngCountry } from './engCountries';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, heEngRegistryCsvRows,
  openHeEngRegistryZipEntry, ownHeEngRegistryText, readHeEngRegistryBulkFile } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';

/**
 * Investment advisers registered with the US SEC (keyless, monthly): the
 * SEC's own extract of every registered adviser's Form ADV — about 17 000
 * firms, mostly American, some in London, Toronto, Zurich or Hong Kong — with
 * the main office address, the number of employees (item 5A), regulatory
 * assets under management (5F) and one website the firm lists. Advisers whose
 * main office is a private residence have no address in the file and are left
 * out. The file (6 MB zipped) is read once a week from the newest link on the
 * SEC's page; a slice reads its countries largest first, 25 a page. The file
 * keeps only the first website of the form, which may be a fund's or a
 * division's (Edward Jones lists its funds' site): it is kept when its domain
 * carries the firm's name words or initials; otherwise, or with only a social
 * page, the firm goes to the usual site search.
 */
const LISTING = 'https://www.sec.gov/data-research/sec-markets-data/information-about-registered-investment-advisers-exempt-reporting-advisers';
const FILES = /href="(\/files\/investment\/data\/other\/information-about-registered-investment-advisers-exempt-reporting-advisers\/(ia[\w.-]{4,40})\.zip)"/g;
const FILE = 'sec-advisers.zip';
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const MAX_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_CSV_BYTES = 512 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PAGE_SIZE = 25;
// An organisation's own website is the one to check; these are profiles, filings, link pages and donation platforms.
const NOT_OWN_SITE = /(?:^|\.)(?:facebook|linkedin|twitter|x|instagram|youtube|vimeo|tiktok|pinterest|yelp|google|medium|bit|tinyurl)\.(?:com|ly)$|(?:^|\.)(?:sec\.gov|finra\.org|irs\.gov|linktr\.ee|guidestar\.org|candid\.org|propublica\.org|charitynavigator\.org|causeiq\.com|givebutter\.com|gofundme\.com|paypal\.com|eventbrite\.com|networkforgood\.org|classy\.org|donorbox\.org)$/;
// A home page; anything deeper is a page on someone's site («habitat.org/us-ca/…» for a chapter, a campus under its university).
const HOME_PATH = /^\/(?:(?:index|default|home)(?:\.[a-z]{2,5})?|en(?:-us)?)?\/?$/i;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Adviser { crd: string; name: string; legal: string; country: string; address: string; website: string; employees: number;
  assets: number | null; filed: string }

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function amount(raw: string): number | null {
  const value = raw.replace(/[$,\s]/g, '');
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}
/**
 * A site a US list names for an organisation: its origin, or '' for a social
 * page, a filing, a non-address («N/A») or a host without a real top-level
 * domain (a typed «WWW.GWU. EDU» is read as gwu.edu first). With `home`, also
 * '' for a page below a home page: the organisation then owns a page, not the site.
 */
export function heEngListedWebsite(raw: string, options: { home?: boolean } = {}): string {
  const value = raw.replace(/\s*\.\s*/g, '.').split(/[\s;,]+/).find(Boolean) ?? '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !host.includes('.') || isIP(host) ||
      parseDomain(host).isIcann !== true || NOT_OWN_SITE.test(host) || (options.home && (!HOME_PATH.test(url.pathname) || url.search))) return '';
    return `${url.protocol}//${host}`;
  } catch { return ''; }
}
const LEGAL_WORDS = new Set(['the', 'and', 'of', 'llc', 'inc', 'incorporated', 'ltd', 'limited', 'llp', 'lp', 'plc', 'corp', 'corporation', 'co', 'company', 'sa', 'ag', 'gmbh']);
const COMMON_WORDS = new Set([...LEGAL_WORDS, 'group', 'capital', 'management', 'advisors', 'advisers', 'advisory', 'investment', 'investments',
  'asset', 'assets', 'wealth', 'partners', 'financial', 'fund', 'funds', 'global', 'international', 'securities', 'associates', 'services',
  'holdings', 'trust', 'america', 'american', 'national', 'usa', 'uk']);
/**
 * The domain carries one of the firm's own name words (3+ letters), is the
 * start of one («citi.com» for Citigroup), or starts with its initials
 * («gsam.com» for Goldman Sachs Asset Management, «kkr.com» for Kohlberg
 * Kravis Roberts & Co. L.P.). Dotted letters are one word: «H.I.G.» is «hig».
 */
export function heEngWebsiteNamesOrganisation(site: string, names: readonly string[]): boolean {
  const label = (heCompanySiteIdentity(site)?.registrable ?? '').split('.')[0].replace(/[^a-z0-9]/g, '');
  if (!label) return false;
  return names.some(name => {
    const words = name.toLowerCase().normalize('NFKD').replace(/\b([a-z])\.(?=[a-z]\b)/g, '$1').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/)
      .filter(Boolean);
    const own = words.filter(word => word.length >= 3 && !COMMON_WORDS.has(word));
    const initials = words.filter(word => !LEGAL_WORDS.has(word)).map(word => word[0]).join('');
    return own.some(word => label.includes(word) || (label.length >= 4 && !COMMON_WORDS.has(label) && word.startsWith(label))) ||
      (initials.length >= 3 && label.startsWith(initials));
  });
}
const NAME_STOP_WORDS = new Set([...LEGAL_WORDS, 'for', 'in', 'at', 'to', 'a', 'an']);
/**
 * A chapter of a federation naming its parent's site: «YMCA OF GREATER
 * SEATTLE» with ymca.net, «UNITED WAY OF CENTRAL OHIO INC» with
 * unitedway.org. The name splits at «of» into the federation and the place;
 * the domain carries the federation's words and none of the place's.
 */
export function heEngWebsiteOfParentFederation(site: string, name: string): boolean {
  const label = (heCompanySiteIdentity(site)?.registrable ?? '').split('.')[0].replace(/[^a-z0-9]/g, '');
  const words = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
  const split = words.indexOf('of', 1);
  if (!label || split < 1) return false;
  const own = (part: string[]) => part.filter(word => word.length >= 3 && !NAME_STOP_WORDS.has(word));
  const federation = own(words.slice(0, split)); const place = own(words.slice(split + 1));
  return place.length > 0 && federation.some(word => label.includes(word)) && !place.some(word => label.includes(word));
}
/** «$1.2 billion», for descriptions. */
export function heEngUsdAmount(value: number): string {
  if (value >= 1e9) return `$${(value / 1e9).toFixed(value >= 1e10 ? 0 : 1)} billion`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(value >= 1e7 ? 0 : 1)} million`;
  return `$${Math.round(value).toLocaleString('en-US')}`;
}

async function download(options: Options): Promise<string> {
  const page = await readHeEngRegistryText(LISTING, { ...options, accept: 'text/html', maxBytes: MAX_LISTING_BYTES, timeoutMs: 60_000 });
  // Newest first; each month also has an «exempt reporting advisers» file, a different list.
  const link = [...page.matchAll(FILES)].find(match => !/exempt/i.test(match[2]));
  if (!link) fail('registry_invalid_response');
  return readHeEngRegistryBulkFile(`https://www.sec.gov${link[1]}`, heEngRegistryCacheFile(FILE), { fetch: options.fetch, now: options.now,
    maxBytes: MAX_ZIP_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: 10 * 60_000 });
}

async function parse(file: string): Promise<Adviser[]> {
  const advisers: Adviser[] = [];
  let column: Record<string, number> | null = null;
  let seen = 0;
  const rows = heEngRegistryCsvRows(await openHeEngRegistryZipEntry(file, MAX_CSV_BYTES, /\.csv$/i), ',',
    { maxBytes: MAX_CSV_BYTES, encoding: 'windows-1252' });
  for await (const row of rows) {
    if (!column) {
      column = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
      // Assets under management, the filing date and the second address line may move in a new form version.
      if (['Organization CRD#', 'Primary Business Name', 'Legal Name', 'Main Office Street Address 1', 'Main Office City', 'Main Office State',
        'Main Office Country', 'Main Office Postal Code', 'Main Office Private Residence Flag', 'SEC Current Status', 'Website Address', '5A']
        .some(name => column![name] === undefined)) fail('registry_invalid_response');
      continue;
    }
    seen += 1;
    const cell = (name: string, max = 300) => column![name] === undefined ? '' : str(row[column![name]], max);
    const crd = cell('Organization CRD#', 20);
    const legal = cell('Legal Name');
    const name = cell('Primary Business Name') || legal;
    const country = normalizeEngCountry(cell('Main Office Country', 100));
    const city = cell('Main Office City', 100);
    const street = [cell('Main Office Street Address 1', 200), cell('Main Office Street Address 2', 200)].filter(Boolean).join(', ');
    const employees = amount(cell('5A', 20));
    const site = heEngListedWebsite(cell('Website Address', 2048));
    // «Approved» or «120-Day Approval»; a private residence has no public address in the file.
    if (!/^\d{1,8}$/.test(crd) || !name || !/approv/i.test(cell('SEC Current Status', 40)) || cell('Main Office Private Residence Flag', 5) === 'Y' ||
      !country || !city || !street || employees === null) continue;
    const region = [cell('Main Office State', 60), cell('Main Office Postal Code', 20)].filter(Boolean).join(' ');
    const address = [street, [city, region].filter(Boolean).join(', '), cell('Main Office Country', 100)].join(', ');
    // Copies: the list must not keep the parsed file text alive.
    advisers.push({ crd: ownHeEngRegistryText(crd), name: ownHeEngRegistryText(name), legal: legal === name ? '' : ownHeEngRegistryText(legal), country,
      address: ownHeEngRegistryText(address), website: site && heEngWebsiteNamesOrganisation(site, [name, legal]) ? ownHeEngRegistryText(site) : '', employees,
      assets: amount(cell('5F(2)(c)', 30)), filed: ownHeEngRegistryText(cell('Latest ADV Filing Date', 20)) });
  }
  // A truncated or reshaped file is not the SEC's list (17 210 registered advisers in October 2026).
  if (seen < 10_000 || advisers.length < 8_000) fail('registry_invalid_response');
  advisers.sort((a, b) => b.employees - a.employees || (b.assets ?? -1) - (a.assets ?? -1) || Number(a.crd) - Number(b.crd));
  return advisers;
}

const advisers = heEngRegistryBackgroundList(async (options: Options) => {
  const file = await download(options);
  try { return await parse(file); }
  catch (error) { await discardHeEngRegistryBulkFile(file); throw error; }
});

function candidate(adviser: Adviser): HeEngRegistryCandidate {
  const year = Number(/(\d{4})$/.exec(adviser.filed)?.[1]);
  return { provider: 'sec_advisers', recordId: adviser.crd, company: adviser.name, country: adviser.country, address: adviser.address,
    addressKind: 'business', category: 'SEC registered investment adviser', employees: String(adviser.employees),
    ...(year >= 1990 && year <= 2100 ? { employeeYear: year } : {}), website: adviser.website, emails: [],
    description: str(`An investment adviser registered with the US SEC${adviser.legal ? ` (legal name ${adviser.legal})` : ''}: ${adviser.employees} employees${adviser.assets ? ` and ${heEngUsdAmount(adviser.assets)} of regulatory assets under management` : ''} by its Form ADV${adviser.filed ? ` (filed ${adviser.filed})` : ''}. Main office address${adviser.website ? ' and website' : ''} from Form ADV; services and clients require verification.`, 1500),
    sourceUrl: `https://adviserinfo.sec.gov/firm/summary/${adviser.crd}` };
}

/** One 25-firm page of an SEC adviser slice; the caller validates the task and the position. */
export async function readHeEngSecAdviserRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'sec_advisers' || task.country !== 'global' || task.category !== 'investment_advisers') fail('registry_invalid_task');
  const countries = task.countries ?? [];
  const list = (await advisers(options)).filter(adviser => countries.includes(adviser.country) && adviser.employees >= (task.minEmployees ?? 0) &&
    (task.maxEmployees === undefined || adviser.employees <= task.maxEmployees));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length,
    excluded: {}, recordsRead: page.length };
}
