import { createReadStream } from 'node:fs';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, heEngRegistryCsvRows, ownHeEngRegistryText,
  readHeEngRegistryBulkFile, readHeEngRegistryRemoteZipDirectory, readHeEngRegistryRemoteZipFile,
  type HeEngRegistryBuildOptions, type HeEngRegistryRemoteZipDirectory } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';
import { HeEngRegistryRetryError } from './engRegistryRetry';
import { heEngListedWebsite, heEngUsdAmount, heEngWebsiteOfParentFederation } from './engSecAdviserRegistry';

/**
 * US tax-exempt organisations from the IRS Exempt Organizations Business
 * Master File (keyless, monthly): every recognised charity, foundation,
 * hospital, school, university and trade association with its mailing
 * address, NTEE activity code and the revenue and assets of its latest
 * return. Three regional files (about 340 MB together; the fourth holds
 * territories and addresses abroad) are read every two weeks. A slice reads
 * its organisations largest by revenue first, within a revenue window loosely
 * matching the slice's employee range.
 *
 * The master file has no website or headcount; the organisation's latest
 * Form 990 return has both (its website, and on the full form the number of
 * employees). The IRS publishes the e-filed returns as monthly zip archives
 * of XML with a yearly index (EIN → return): the index of the last two years
 * is read with the list, and a page reads its 25 organisations' returns out
 * of the archives by byte ranges (about 30 KB each). A website from the
 * return goes the trusted way, like Wikidata's, when it is a home page: a
 * chapter that names a page on its national body's site («habitat.org/us-ca/…»)
 * owns that page, not the site; one that names the bare site of its
 * federation («YMCA OF GREATER SEATTLE» with ymca.net) is searched for its
 * own. A hospital that names its health system's site (northwell.edu) is
 * reached at that domain; the largest organisation comes first and the others
 * of a domain are dropped as duplicates. Without a website the site is
 * searched and proven as usual (its EIN on a giving page).
 */
const SOURCES = ['eo1', 'eo2', 'eo3'];
const MAX_BYTES = 1024 * 1024 * 1024;
const FILE_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const PAGE_SIZE = 25;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const DOWNLOADS = 'https://www.irs.gov/charities-non-profits/form-990-series-downloads';
const RETURN_ARCHIVE = /https:\/\/apps\.irs\.gov\/pub\/epostcard\/990\/xml\/(\d{4})\/(\1_TEOS_XML_\d{2}[A-Z])\.zip/g;
const RETURN_INDEX = /https:\/\/apps\.irs\.gov\/pub\/epostcard\/990\/xml\/(\d{4})\/index_\1\.csv/g;
// Two full years of returns; a third while the newest year has only begun.
const RETURN_INDEX_YEARS = 2;
const RETURN_INDEX_MAX_YEARS = 3;
const RETURN_INDEX_FULL_ROWS = 100_000;
// After a failed read of the indexes, pages go without returns for a while.
const RETURNS_RETRY_MS = 15 * 60_000;
const RETURN_TYPES = new Set(['990', '990EZ', '990PF']);
const MAX_RETURN_BYTES = 32 * 1024 * 1024;
// Returns read at once for one page; a page takes a few seconds.
const RETURN_READS = 5;
const MAX_CACHED_RETURNS = 20_000;

interface Filing { object: string; batch: string }
interface Organisation { ein: string; name: string; address: string; revenue: number; assets: number | null; period: string; ntee: string;
  /** Private foundations file no revenue in the master file: their income stands for it. */
  income?: true; filing?: Filing }
interface ReturnFacts { website: string; employees: number | null; year: number | null }
interface Returns {
  archives: readonly string[]; wanted: ReadonlySet<string>;
  /** Per archive, its wanted returns by file name. */
  directories: Map<string, Promise<HeEngRegistryRemoteZipDirectory>>;
  /** EIN → what its latest return says; null when it was read and says neither. */
  facts: Map<string, ReturnFacts | null>;
}
interface ReturnsState { value: Returns | null; building: Promise<void> | null; failedAt: number }
interface Category { label: string; keep: number; test(subsection: string, foundation: string, ntee: string): boolean }
// Private foundations (non-operating and operating); churches (10) are not charities here.
const PRIVATE_FOUNDATION = new Set(['02', '03', '04']);
/** IRS sections and NTEE codes per category; the largest organisations of a broad category are kept. */
export const HE_ENG_IRS_CATEGORIES: Readonly<Record<string, Category>> = {
  charities: { label: 'public charity', keep: 60_000,
    test: (subsection, foundation) => subsection === '03' && !PRIVATE_FOUNDATION.has(foundation) && foundation !== '10' },
  foundations: { label: 'private foundation', keep: 30_000, test: (subsection, foundation) => subsection === '03' && PRIVATE_FOUNDATION.has(foundation) },
  // NTEE E20–E24 hospitals, E30–E32 clinics and community health centres, B40–B43 and B50 colleges and
  // universities, B2x schools without preschools (B21).
  hospitals: { label: 'nonprofit hospital', keep: 60_000, test: (_s, _f, ntee) => /^E2[0-4]/.test(ntee) },
  clinics: { label: 'nonprofit clinic', keep: 60_000, test: (_s, _f, ntee) => /^E3[0-2]/.test(ntee) },
  higher_education: { label: 'nonprofit college or university', keep: 60_000, test: (_s, _f, ntee) => /^B(?:4[0-3]|50)/.test(ntee) },
  schools: { label: 'nonprofit school', keep: 60_000, test: (_s, _f, ntee) => /^B2[02-9]/.test(ntee) },
  // Section 501(c)(6): business leagues, chambers of commerce, trade and professional associations.
  trade_associations: { label: 'business league or trade association', keep: 30_000, test: subsection => subsection === '06' },
};
// The revenue of a US nonprofit is roughly $100 000 per employee, a factor of three either way.
const REVENUE_PER_EMPLOYEE = 100_000;
const REVENUE_TOLERANCE = 3;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function amount(raw: string): number | null { return /^\d{1,15}$/.test(raw) ? Number(raw) : null; }

async function parse(files: readonly string[]): Promise<Map<string, Organisation[]>> {
  const lists = new Map(Object.keys(HE_ENG_IRS_CATEGORIES).map(key => [key, { organisations: [] as Organisation[], floor: 0 }]));
  const prune = (key: string) => {
    const list = lists.get(key)!; const keep = HE_ENG_IRS_CATEGORIES[key].keep;
    list.organisations.sort((a, b) => b.revenue - a.revenue || (a.ein < b.ein ? -1 : 1));
    list.organisations.length = Math.min(list.organisations.length, keep);
    if (list.organisations.length === keep) list.floor = list.organisations[keep - 1].revenue;
  };
  let seen = 0;
  for (const file of files) {
    let column: Record<string, number> | null = null;
    for await (const row of heEngRegistryCsvRows(createReadStream(file), ',', { maxBytes: MAX_BYTES })) {
      if (!column) {
        column = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
        if (['EIN', 'NAME', 'STREET', 'CITY', 'STATE', 'ZIP', 'SUBSECTION', 'FOUNDATION', 'STATUS', 'REVENUE_AMT', 'NTEE_CD']
          .some(name => column![name] === undefined)) fail('registry_invalid_response');
        continue;
      }
      seen += 1;
      const cell = (name: string, max = 300) => column![name] === undefined ? '' : str(row[column![name]], max);
      const filed = amount(cell('REVENUE_AMT', 20));
      const revenue = filed || amount(cell('INCOME_AMT', 20));
      // Unconditional or conditional exemption; organisations without a filed revenue are the smallest.
      if (!revenue || !['01', '02', '25'].includes(cell('STATUS', 4))) continue;
      const subsection = cell('SUBSECTION', 4); const foundation = cell('FOUNDATION', 4); const ntee = cell('NTEE_CD', 6).toUpperCase();
      const keys = Object.keys(HE_ENG_IRS_CATEGORIES).filter(key => HE_ENG_IRS_CATEGORIES[key].test(subsection, foundation, ntee) && revenue > lists.get(key)!.floor);
      if (!keys.length) continue;
      const ein = cell('EIN', 12); const name = cell('NAME'); const state = cell('STATE', 4);
      const street = cell('STREET', 200); const city = cell('CITY', 100); const zip = cell('ZIP', 12);
      if (!/^\d{9}$/.test(ein) || !name || !US_STATES.has(state) || !street || !city) continue;
      // Copies: the lists must not keep the parsed file text alive. The «in care of» name is a person's; it is not kept.
      const organisation: Organisation = { ein: ownHeEngRegistryText(ein), name: ownHeEngRegistryText(name),
        address: ownHeEngRegistryText(`${street}, ${city}, ${state} ${zip}, United States`), revenue, assets: amount(cell('ASSET_AMT', 20)),
        period: ownHeEngRegistryText(cell('TAX_PERIOD', 8)), ntee: ownHeEngRegistryText(ntee), ...(filed ? {} : { income: true as const }) };
      for (const key of keys) {
        const list = lists.get(key)!;
        list.organisations.push(organisation);
        if (list.organisations.length >= HE_ENG_IRS_CATEGORIES[key].keep * 2) prune(key);
      }
    }
  }
  // Truncated or reshaped files are not the IRS's (1.97 million organisations in October 2026).
  if (seen < 1_000_000) fail('registry_invalid_response');
  for (const key of lists.keys()) prune(key);
  if ((lists.get('charities')?.organisations.length ?? 0) < 10_000) fail('registry_invalid_response');
  return new Map([...lists].map(([key, list]) => [key, list.organisations]));
}

/** One year's index: the latest return of each kept organisation; the number of rows. */
async function indexYear(year: string, byEin: ReadonlyMap<string, Organisation>, latest: Map<string, { period: string; filing: Filing }>,
  options: HeEngRegistryBuildOptions): Promise<number> {
  const file = await readHeEngRegistryBulkFile(`https://apps.irs.gov/pub/epostcard/990/xml/${year}/index_${year}.csv`,
    heEngRegistryCacheFile(`irs-990-index-${year}.csv`), { fetch: options.fetch, now: options.now, maxBytes: 512 * 1024 * 1024, maxAgeMs: FILE_MAX_AGE_MS,
      timeoutMs: 15 * 60_000 });
  let column: Record<string, number> | null = null;
  let rows = 0;
  const found = new Map<string, { period: string; filing: Filing }>();
  try {
    for await (const row of heEngRegistryCsvRows(createReadStream(file), ',', { maxBytes: 512 * 1024 * 1024 })) {
      if (!column) {
        column = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
        if (['EIN', 'TAX_PERIOD', 'RETURN_TYPE', 'OBJECT_ID', 'XML_BATCH_ID'].some(name => column![name] === undefined)) fail('registry_invalid_response');
        continue;
      }
      rows += 1;
      const ein = str(row[column.EIN], 12);
      if (!byEin.has(ein) || !RETURN_TYPES.has(str(row[column.RETURN_TYPE], 10))) continue;
      const period = str(row[column.TAX_PERIOD], 8); const object = str(row[column.OBJECT_ID], 24); const batch = str(row[column.XML_BATCH_ID], 30);
      if (!/^\d{6}$/.test(period) || !/^\d{18}$/.test(object) || !/^\d{4}_TEOS_XML_\d{2}[A-Z]$/.test(batch)) continue;
      const known = found.get(ein);
      if (known && (known.period > period || (known.period === period && known.filing.object >= object))) continue;
      found.set(ein, { period, filing: { object: ownHeEngRegistryText(object), batch: ownHeEngRegistryText(batch) } });
    }
    // A header and nothing else is not an index (749 000 returns were indexed in 2025; a new year starts small).
    if (!column || rows < 100) fail('registry_invalid_response');
  } catch (error) { await discardHeEngRegistryBulkFile(file); throw error; }
  for (const [ein, item] of found) {
    const known = latest.get(ein);
    if (!known || known.period < item.period || (known.period === item.period && known.filing.object < item.filing.object)) latest.set(ein, item);
  }
  return rows;
}
/**
 * Each kept organisation's latest e-filed return (990, 990-EZ, 990-PF) from
 * the yearly indexes, newest first; a year that fails is skipped. The archives
 * that hold the returns come from the IRS downloads page.
 */
async function filings(lists: ReadonlyMap<string, Organisation[]>, options: HeEngRegistryBuildOptions): Promise<Returns> {
  const page = await readHeEngRegistryText(DOWNLOADS, { fetch: options.fetch, accept: 'text/html', maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000 });
  const archives = [...new Set([...page.matchAll(RETURN_ARCHIVE)].map(match => match[2]))].sort();
  const years = [...new Set([...page.matchAll(RETURN_INDEX)].map(match => match[1]))].sort().reverse().slice(0, RETURN_INDEX_MAX_YEARS);
  if (!archives.length || !years.length) fail('registry_invalid_response');
  const byEin = new Map<string, Organisation>();
  for (const list of lists.values()) for (const organisation of list) byEin.set(organisation.ein, organisation);
  const latest = new Map<string, { period: string; filing: Filing }>();
  let full = 0; let read = 0;
  for (const year of years) {
    if (full >= RETURN_INDEX_YEARS) break;
    const rows = await indexYear(year, byEin, latest, options).catch(() => 0);
    if (rows) read += 1;
    if (rows >= RETURN_INDEX_FULL_ROWS) full += 1;
  }
  if (!read) fail('registry_invalid_response');
  for (const [ein, { filing }] of latest) byEin.get(ein)!.filing = filing;
  return { archives, wanted: new Set([...latest.values()].map(item => item.filing.object)), directories: new Map(), facts: new Map() };
}

const organisations = heEngRegistryBackgroundList(async (options: Options) => {
  const files: string[] = [];
  for (const name of SOURCES) {
    files.push(await readHeEngRegistryBulkFile(`https://www.irs.gov/pub/irs-soi/${name}.csv`, heEngRegistryCacheFile(`irs-${name}.csv`),
      { fetch: options.fetch, now: options.now, maxBytes: MAX_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: 20 * 60_000 }));
  }
  let lists: Map<string, Organisation[]>;
  try { lists = await parse(files); }
  catch (error) { for (const file of files) await discardHeEngRegistryBulkFile(file); throw error; }
  // Without the returns the list still works: websites are then searched for, and the indexes are read again later.
  const returns: ReturnsState = { value: null, building: null, failedAt: 0 };
  await filings(lists, options).then(value => { returns.value = value; }, () => { returns.failedAt = (options.now ?? Date.now)(); });
  return { lists, returns };
});
/** The returns of the current lists; while their indexes are read again the page waits, after a failure it goes without. */
function returnsOf(lists: ReadonlyMap<string, Organisation[]>, state: ReturnsState, options: Options): Returns | null {
  if (state.value) return state.value;
  if (!state.building && (options.now ?? Date.now)() - state.failedAt >= RETURNS_RETRY_MS) {
    state.building = filings(lists, { fetch: options.fetch, now: options.now })
      .then(value => { state.value = value; }, () => { state.failedAt = (options.now ?? Date.now)(); })
      .finally(() => { state.building = null; });
  }
  if (state.building) throw new HeEngRegistryRetryError(30_000);
  return null;
}

function fileName(path: string): string { return path.slice(path.lastIndexOf('/') + 1); }
/** The directory of one archive, with only the returns the lists need, by file name; a failed read is asked again next time. */
function directory(returns: Returns, archive: string): Promise<HeEngRegistryRemoteZipDirectory> {
  let pending = returns.directories.get(archive);
  if (!pending) {
    pending = readHeEngRegistryRemoteZipDirectory(`https://apps.irs.gov/pub/epostcard/990/xml/${archive.slice(0, 4)}/${archive}.zip`, { timeoutMs: 120_000 },
      name => fileName(name).endsWith('_public.xml') && returns.wanted.has(fileName(name).slice(0, -'_public.xml'.length)))
      .then(found => ({ entries: new Map([...found.entries].map(([name, entry]) => [fileName(name), entry])), end: found.end }));
    returns.directories.set(archive, pending);
    pending.catch(() => returns.directories.delete(archive));
  }
  return pending;
}
function xmlValue(xml: string, tag: string): string {
  const raw = new RegExp(`<${tag}>([^<]{1,500})</${tag}>`).exec(xml)?.[1] ?? '';
  return str(raw.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'), 500);
}
/**
 * The website and employees an organisation's latest return states. The index
 * names its monthly batch; a big month is split into several archives
 * («05A», «05B»), so the return may be in a sibling.
 */
async function returnFacts(returns: Returns, organisation: Organisation, options: Options): Promise<ReturnFacts | null> {
  const known = returns.facts.get(organisation.ein);
  if (known !== undefined) return known;
  const filing = organisation.filing;
  if (!filing) return null;
  const name = `${filing.object}_public.xml`;
  const siblings = returns.archives.filter(archive => archive !== filing.batch && archive.slice(0, -1) === filing.batch.slice(0, -1));
  for (const archive of [filing.batch, ...siblings].filter(item => returns.archives.includes(item))) {
    const found = await directory(returns, archive);
    const entry = found.entries.get(name);
    if (!entry) continue;
    const xml = (await readHeEngRegistryRemoteZipFile(`https://apps.irs.gov/pub/epostcard/990/xml/${archive.slice(0, 4)}/${archive}.zip`, entry, found.end,
      { signal: options.signal, timeoutMs: 60_000, maxBytes: MAX_RETURN_BYTES })).toString('utf8');
    // Zero employees is usually staff paid by a related organisation: it says nothing about size.
    const employees = amount(xmlValue(xml, 'TotalEmployeeCnt'));
    const year = Number(xmlValue(xml, 'TaxYr') || xmlValue(xml, 'TaxPeriodEndDt').slice(0, 4));
    const site = heEngListedWebsite(xmlValue(xml, 'WebsiteAddressTxt'), { home: true });
    const facts = { website: site && !heEngWebsiteOfParentFederation(site, organisation.name) ? site : '',
      employees: employees && employees <= 5_000_000 ? employees : null, year: year >= 2000 && year <= 2100 ? year : null };
    const result = facts.website || facts.employees !== null ? facts : null;
    if (returns.facts.size >= MAX_CACHED_RETURNS) returns.facts.clear();
    returns.facts.set(organisation.ein, result);
    return result;
  }
  returns.facts.set(organisation.ein, null);
  return null;
}
/** Facts for a page's organisations; a failed read leaves that organisation as the master file has it, and is asked again later. */
async function pageFacts(returns: Returns | null, page: readonly Organisation[], options: Options): Promise<Map<string, ReturnFacts>> {
  const found = new Map<string, ReturnFacts>();
  if (!returns) return found;
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(RETURN_READS, page.length) }, async () => {
    while (next < page.length) {
      const organisation = page[next++];
      try {
        const facts = await returnFacts(returns, organisation, options);
        if (facts) found.set(organisation.ein, facts);
      } catch (error) { if (options.signal?.aborted) throw error; }
    }
  }));
  return found;
}

/**
 * The revenue window keeps organisations of roughly the slice's size. An open
 * range reads the largest first; a closed one those nearest its middle first
 * (10–50 employees: about $2.2 million), not the ones at its upper edge.
 */
function slice(list: readonly Organisation[], task: HeEngRegistryTask): Organisation[] {
  const min = (task.minEmployees ?? 0) * REVENUE_PER_EMPLOYEE / REVENUE_TOLERANCE;
  const max = task.maxEmployees === undefined ? Infinity : task.maxEmployees * REVENUE_PER_EMPLOYEE * REVENUE_TOLERANCE;
  const kept = list.filter(organisation => organisation.revenue >= min && organisation.revenue <= max);
  if (task.maxEmployees === undefined) return kept;
  const middle = Math.log(Math.sqrt(Math.max(1, task.minEmployees ?? 1) * Math.max(1, task.maxEmployees)) * REVENUE_PER_EMPLOYEE);
  return kept.map(organisation => ({ organisation, distance: Math.abs(Math.log(organisation.revenue) - middle) }))
    .sort((a, b) => a.distance - b.distance || (a.organisation.ein < b.organisation.ein ? -1 : 1)).map(item => item.organisation);
}
// The last ordered slice: its pages are read one after another.
let ordered: { list: readonly Organisation[]; key: string; organisations: Organisation[] } | null = null;

function candidate(organisation: Organisation, category: string, facts: ReturnFacts | undefined): HeEngRegistryCandidate {
  const period = /^(\d{4})(\d{2})$/.exec(organisation.period);
  const label = HE_ENG_IRS_CATEGORIES[category].label;
  const employees = facts?.employees ?? null;
  const fromReturn = [facts?.website ? 'website' : '', employees !== null ? 'employee count' : ''].filter(Boolean).join(' and ');
  return { provider: 'irs', recordId: organisation.ein, company: organisation.name, country: 'united states', address: organisation.address,
    addressKind: 'registered', category: `IRS ${label}${organisation.ntee ? `, NTEE ${organisation.ntee}` : ''}`,
    ...(employees !== null ? { employees: String(employees) } : {}), ...(employees !== null && facts?.year ? { employeeYear: facts.year } : {}),
    website: facts?.website ?? '', emails: [],
    description: str(`A US tax-exempt ${label} (EIN ${organisation.ein.slice(0, 2)}-${organisation.ein.slice(2)})${organisation.ntee ? `, NTEE ${organisation.ntee}` : ''}: ${organisation.income ? 'income' : 'revenue'} ${heEngUsdAmount(organisation.revenue)}${organisation.assets ? `, assets ${heEngUsdAmount(organisation.assets)}` : ''}${employees !== null ? `, ${employees} employees` : ''} by its latest return${period ? ` (tax period ${period[1]}-${period[2]})` : ''}. From the IRS Exempt Organizations Business Master File (mailing address)${fromReturn ? `; ${fromReturn} from its Form 990${facts?.year ? ` for ${facts.year}` : ''}` : ''}. ${facts?.website ? 'Activities' : 'Website and activities'} require verification.`, 1500),
    sourceUrl: `https://projects.propublica.org/nonprofits/organizations/${organisation.ein}` };
}

/** One 25-organisation page of an IRS slice; the caller validates the task and the position. */
export async function readHeEngIrsRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'irs' || task.country !== 'united states' || !Object.hasOwn(HE_ENG_IRS_CATEGORIES, task.category)) fail('registry_invalid_task');
  const { lists, returns: state } = await organisations(options);
  const returns = returnsOf(lists, state, options);
  const all = lists.get(task.category) ?? [];
  const key = `${task.category}:${task.minEmployees ?? ''}:${task.maxEmployees ?? ''}`;
  if (ordered?.list !== all || ordered.key !== key) ordered = { list: all, key, organisations: slice(all, task) };
  const list = ordered.organisations;
  const page = list.slice(position, position + PAGE_SIZE);
  const facts = await pageFacts(returns, page, options);
  const excluded: Record<string, number> = {};
  const candidates: HeEngRegistryCandidate[] = [];
  for (const organisation of page) {
    const employees = facts.get(organisation.ein)?.employees ?? null;
    // A headcount from the return outside the slice's range: the revenue window only guessed.
    if (employees !== null && (employees < (task.minEmployees ?? 0) || (task.maxEmployees !== undefined && employees > task.maxEmployees))) {
      excluded.employee_range = (excluded.employee_range ?? 0) + 1; continue;
    }
    candidates.push(candidate(organisation, task.category, facts.get(organisation.ein)));
  }
  return { candidates, nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length, excluded, recordsRead: page.length };
}
