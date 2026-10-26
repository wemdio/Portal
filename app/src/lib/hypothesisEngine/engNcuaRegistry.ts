import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, heEngRegistryCsvRows, openHeEngRegistryZipEntry,
  ownHeEngRegistryText, readHeEngRegistryBulkFile, type HeEngRegistryBuildOptions } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';
import { heEngListedWebsite, heEngUsdAmount } from './engSecAdviserRegistry';

/**
 * US credit unions from the NCUA's quarterly call report data (keyless, 8 MB
 * zip of CSV): every federally insured credit union with its address,
 * website (account 891), full- and part-time employees (564A, 564B), assets
 * (010) and members (083). The newest quarter's file is found on the NCUA's
 * page and read once a week; a slice reads the credit unions largest first.
 * The main table cuts names at 35 characters and towns at 15; the main
 * office's row of the branch table has the address whole and, for most cut
 * names, the name. The file also names officers; their names are not kept.
 */
const LISTING = 'https://ncua.gov/analysis/credit-union-corporate-call-report-data/quarterly-data';
const QUARTERS = /href="(\/files\/publications\/analysis\/call-report-data-(\d{4})-(\d{2})\.zip)"/g;
const MAX_ZIP_BYTES = 256 * 1024 * 1024;
const MAX_TABLE_BYTES = 512 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PAGE_SIZE = 25;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface CreditUnion { charter: string; name: string; address: string; addressKind: 'business' | 'registered'; website: string; employees: number | null;
  assets: number | null; members: number | null; quarter: string }
type Cell = (name: string, max?: number) => string;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function amount(raw: string): number | null {
  const value = Number(raw);
  return raw !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}
/** Rows of one table of the archive, as cell readers by column name (the files differ in case: «Acct_891», «ACCT_564A»). */
async function* table(file: string, name: string, required: readonly string[]): AsyncGenerator<Cell> {
  let column: Record<string, number> | null = null;
  const stream = await openHeEngRegistryZipEntry(file, MAX_TABLE_BYTES, new RegExp(`^${name}$`, 'i'));
  for await (const row of heEngRegistryCsvRows(stream, ',', { maxBytes: MAX_TABLE_BYTES, encoding: 'windows-1252' })) {
    if (!column) {
      column = Object.fromEntries(row.map((value, i) => [value.trim().toUpperCase(), i]));
      if (required.some(key => column![key] === undefined)) fail('registry_invalid_response');
      continue;
    }
    yield (key, max = 300) => column![key] === undefined ? '' : str(row[column![key]], max);
  }
}

// A name the main table cut: 35 characters, or 34 when the cut fell before a space («… FEDERAL CREDIT »).
const CUT_NAME_LENGTH = 34;
/**
 * The main office's site name when it is the credit union's name: it starts with the cut name's whole words and names a credit
 * union («Ellis County Teachers & Employees Federal Credit Union»), not an office («Main Office», «XYZ FCU – Main Office»). Only
 * for a cut name: a whole one is the better name («Altana» against the site «Altana FCU West End»).
 */
function siteName(site: string, short: string): string {
  const compact = (text: string) => text.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]/g, '');
  const head = compact(short.split(/\s+/).slice(0, -1).join(' '));
  return head.length >= 8 && compact(site).startsWith(head) && /\b(?:credit union|e?fcu|cu)\b/i.test(site) &&
    !/\b(?:main (?:office|branch)|office|branch|headquarters|hq|operations)\b/i.test(site) ? site : '';
}

async function parse(file: string, quarter: string): Promise<CreditUnion[]> {
  const offices = new Map<string, { name: string; street: string; city: string; state: string; zip: string }>();
  for await (const cell of table(file, 'Credit Union Branch Information.txt', ['CU_NUMBER', 'SITENAME', 'MAINOFFICE', 'PHYSICALADDRESSLINE1',
    'PHYSICALADDRESSCITY', 'PHYSICALADDRESSSTATECODE', 'PHYSICALADDRESSPOSTALCODE'])) {
    if (cell('MAINOFFICE', 6) !== 'Yes') continue;
    offices.set(cell('CU_NUMBER', 10), { name: cell('SITENAME', 200), street: [cell('PHYSICALADDRESSLINE1', 150), cell('PHYSICALADDRESSLINE2', 150)]
      .filter(Boolean).join(', '), city: cell('PHYSICALADDRESSCITY', 80), state: cell('PHYSICALADDRESSSTATECODE', 4), zip: cell('PHYSICALADDRESSPOSTALCODE', 12) });
  }
  const unions = new Map<string, CreditUnion>();
  for await (const cell of table(file, 'FOICU.txt', ['CU_NUMBER', 'CU_TYPE', 'CU_NAME', 'STREET', 'CITY', 'STATE', 'ZIP_CODE'])) {
    const charter = cell('CU_NUMBER', 10); const short = cell('CU_NAME');
    const office = offices.get(charter);
    // The main office's physical address, whole; the main table's when there is none.
    const located = !!office && !!office.street && !!office.city && US_STATES.has(office.state);
    const street = located ? office!.street : cell('STREET', 150); const city = located ? office!.city : cell('CITY', 80);
    const state = located ? office!.state : cell('STATE', 4); const zip = located ? office!.zip : cell('ZIP_CODE', 12);
    if (!/^\d{1,8}$/.test(charter) || !short || !US_STATES.has(state) || !street || !city) continue;
    // The main table shortens names («WOODMEN»: Woodmen Federal Credit Union, type 1) and cuts them at 35 characters;
    // a cut name the main office does not name whole is kept as it is rather than given a suffix it may already have had.
    const full = short.length >= CUT_NAME_LENGTH ? (office && siteName(office.name, short)) || short
      : /\bcredit union\b/i.test(short) ? short : `${short} ${cell('CU_TYPE', 4) === '1' ? 'Federal Credit Union' : 'Credit Union'}`;
    unions.set(charter, { charter: ownHeEngRegistryText(charter), name: ownHeEngRegistryText(full),
      address: ownHeEngRegistryText(`${street}, ${city}, ${state} ${zip}, United States`),
      addressKind: /^(?:p\.?\s*o\.?\s*box|box)\b/i.test(street) ? 'registered' : 'business', website: '', employees: null, assets: null, members: null,
      quarter });
  }
  // A truncated or reshaped file is not the call report (4 299 credit unions in 2026 Q2).
  if (unions.size < 3_000) fail('registry_invalid_response');
  for await (const cell of table(file, 'FS220.txt', ['CU_NUMBER', 'ACCT_010', 'ACCT_083'])) {
    const union = unions.get(cell('CU_NUMBER', 10));
    if (union) { union.assets = amount(cell('ACCT_010', 20)); union.members = amount(cell('ACCT_083', 20)); }
  }
  for await (const cell of table(file, 'FS220A.txt', ['CU_NUMBER', 'ACCT_564A', 'ACCT_564B'])) {
    const union = unions.get(cell('CU_NUMBER', 10));
    const full = amount(cell('ACCT_564A', 12)); const part = amount(cell('ACCT_564B', 12));
    if (union && (full !== null || part !== null)) union.employees = Math.round((full ?? 0) + (part ?? 0));
  }
  for await (const cell of table(file, 'FS220D.txt', ['CU_NUMBER', 'ACCT_891'])) {
    const union = unions.get(cell('CU_NUMBER', 10));
    if (union) union.website = ownHeEngRegistryText(heEngListedWebsite(cell('ACCT_891', 2048), { home: true }));
  }
  return [...unions.values()].sort((a, b) => (b.employees ?? -1) - (a.employees ?? -1) || (b.assets ?? -1) - (a.assets ?? -1) || Number(a.charter) - Number(b.charter));
}

const creditUnions = heEngRegistryBackgroundList(async (options: HeEngRegistryBuildOptions) => {
  const page = await readHeEngRegistryText(LISTING, { fetch: options.fetch, accept: 'text/html', maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000 });
  const newest = [...page.matchAll(QUARTERS)].sort((a, b) => `${b[2]}${b[3]}`.localeCompare(`${a[2]}${a[3]}`))[0] ?? fail('registry_invalid_response');
  const file = await readHeEngRegistryBulkFile(`https://ncua.gov${newest[1]}`, heEngRegistryCacheFile('ncua-call-report.zip'), { fetch: options.fetch,
    now: options.now, maxBytes: MAX_ZIP_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: 10 * 60_000 });
  try { return await parse(file, `${newest[2]}-${newest[3]}`); }
  catch (error) { await discardHeEngRegistryBulkFile(file); throw error; }
});

function candidate(union: CreditUnion): HeEngRegistryCandidate {
  const year = Number(union.quarter.slice(0, 4));
  return { provider: 'ncua', recordId: union.charter, company: union.name, country: 'united states', address: union.address, addressKind: union.addressKind,
    category: 'NCUA federally insured credit union', ...(union.employees !== null ? { employees: String(union.employees), employeeYear: year } : {}),
    website: union.website, emails: [],
    description: str(`A federally insured US credit union (charter ${union.charter})${union.assets !== null ? `: assets ${heEngUsdAmount(union.assets)}` : ''}${union.members !== null ? `, ${Math.round(union.members).toLocaleString('en-US')} members` : ''}${union.employees !== null ? `, ${union.employees} employees` : ''} by its call report for ${union.quarter}. Address${union.website ? ' and website' : ''} from the NCUA call report; services require verification.`, 1500),
    sourceUrl: `https://mapping.ncua.gov/CreditUnionDetails/${union.charter}` };
}

/** One 25-credit-union page of an NCUA slice; the caller validates the task and the position. */
export async function readHeEngNcuaRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'ncua' || task.country !== 'united states' || task.category !== 'credit_unions') fail('registry_invalid_task');
  const list = (await creditUnions(options)).filter(union => union.employees === null
    ? (task.minEmployees ?? 0) < 10
    : union.employees >= (task.minEmployees ?? 0) && (task.maxEmployees === undefined || union.employees <= task.maxEmployees));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length,
    excluded: {}, recordsRead: page.length };
}
