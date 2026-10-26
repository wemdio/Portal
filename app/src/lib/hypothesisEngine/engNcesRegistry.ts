import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, heEngRegistryCsvRows,
  openHeEngRegistryZipEntry, ownHeEngRegistryText, probeHeEngRegistryFile, readHeEngRegistryBulkFile } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';
import { heEngListedWebsite } from './engSecAdviserRegistry';

/**
 * US education institutions from the National Center for Education
 * Statistics (keyless, yearly files):
 * - colleges: degree-granting colleges and universities of IPEDS (about
 *   4 000) with address and website, and all staff from its human resources
 *   survey (a year older than the directory);
 * - school_districts: public school districts, charter districts and
 *   service agencies of the Common Core of Data (about 18 000) with address,
 *   website and staff (full-time equivalent);
 * - private_schools: the Private School Survey (about 22 500 schools, every
 *   two years) with address and teachers (full-time equivalent), no website.
 * Each list is read once a month from the newest year the NCES publishes and
 * paged largest first.
 */
const IPEDS = 'https://nces.ed.gov/ipeds/datacenter/data/';
const CCD_FILES = 'https://nces.ed.gov/ccd/datatables/api/File/2/5/0/0/0/0';
const CCD_FILE = /^https:\/\/nces\.ed\.gov\/ccd\/data\/zip\/[\w.-]{4,80}\.zip$/i;
const PSS_PAGE = 'https://nces.ed.gov/surveys/pss/pssdata.asp';
const PSS_FILE = /href="zip\/(pss(\d{2})(\d{2})_pu_csv\.zip)"/;
const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_CSV_BYTES = 512 * 1024 * 1024;
const MAX_LISTING_BYTES = 8 * 1024 * 1024;
const FILE_MAX_AGE_MS = 30 * 24 * 60 * 60_000;
const PAGE_SIZE = 25;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
export const HE_ENG_NCES_CATEGORIES: readonly string[] = ['colleges', 'school_districts', 'private_schools'];

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Institution { id: string; name: string; address: string; addressKind: 'business' | 'registered'; website: string;
  /** All staff (colleges), staff FTE (districts) or teachers FTE (private schools); null when not reported. */
  staff: number | null; year: number; detail: string }
type Row = (name: string, max?: number) => string;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
// The institution's own home page; a social page, or a page below another site (a campus under its
// university, a district page on its state agency's site) leaves the website to the usual search.
function website(raw: string): string { return heEngListedWebsite(raw, { home: true }); }
function number(raw: string): number | null {
  const value = Number(raw);
  return raw !== '' && Number.isFinite(value) && value >= 0 ? value : null;
}
/**
 * Rows of the one CSV table of a downloaded archive (the revised one when
 * there are two), as cell readers by column name; a column not in `columns`
 * may be missing and reads empty.
 */
async function* table(file: string, columns: readonly string[]): AsyncGenerator<Row> {
  let column: Record<string, number> | null = null;
  const stream = await openHeEngRegistryZipEntry(file, MAX_CSV_BYTES, /\.csv$/i, /_rv\.csv$/i);
  for await (const row of heEngRegistryCsvRows(stream, ',', { maxBytes: MAX_CSV_BYTES })) {
    if (!column) {
      column = Object.fromEntries(row.map((name, i) => [name.trim().toUpperCase(), i]));
      if (columns.some(name => column![name] === undefined)) fail('registry_invalid_response');
      continue;
    }
    yield (name, max = 300) => column![name] === undefined ? '' : str(row[column![name]], max);
  }
}
async function download(url: string, name: string, options: Options): Promise<string> {
  return readHeEngRegistryBulkFile(url, heEngRegistryCacheFile(`nces-${name.toLowerCase()}`), { fetch: options.fetch, now: options.now,
    maxBytes: MAX_ZIP_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: 10 * 60_000 });
}
/** Lists are kept as read; a file that fails the checks is downloaded again next time. */
async function parsed<T>(files: readonly string[], parse: () => Promise<T>): Promise<T> {
  try { return await parse(); }
  catch (error) { for (const file of files) await discardHeEngRegistryBulkFile(file); throw error; }
}
function bySize(a: Institution, b: Institution): number { return (b.staff ?? -1) - (a.staff ?? -1) || (a.id < b.id ? -1 : 1); }

/** The newest year (of the last four) with an IPEDS file of this survey. */
async function ipedsYear(survey: 'HD' | 'EAP', options: Options): Promise<number> {
  const now = new Date((options.now ?? Date.now)()).getUTCFullYear();
  for (let year = now; year > now - 4; year -= 1) {
    if (await probeHeEngRegistryFile(`${IPEDS}${survey}${year}.zip`, { fetch: options.fetch, timeoutMs: 30_000 })) return year;
  }
  return fail('registry_invalid_response');
}
const IPEDS_SECTORS: Readonly<Record<string, string>> = {
  1: 'public, 4-year or above', 2: 'private not-for-profit, 4-year or above', 3: 'private for-profit, 4-year or above',
  4: 'public, 2-year', 5: 'private not-for-profit, 2-year', 6: 'private for-profit, 2-year',
  7: 'public, less than 2-year', 8: 'private not-for-profit, less than 2-year', 9: 'private for-profit, less than 2-year',
};
const colleges = heEngRegistryBackgroundList(async (options: Options) => {
  const hdYear = await ipedsYear('HD', options); const eapYear = await ipedsYear('EAP', options);
  const files = [await download(`${IPEDS}HD${hdYear}.zip`, `hd${hdYear}.zip`, options), await download(`${IPEDS}EAP${eapYear}.zip`, `eap${eapYear}.zip`, options)];
  return parsed(files, async () => {
    // EAPCAT 10000: all staff of the institution.
    const staff = new Map<string, number>();
    for await (const cell of table(files[1], ['UNITID', 'EAPCAT', 'EAPTOT'])) {
      const total = number(cell('EAPTOT', 12));
      if (cell('EAPCAT', 8) === '10000' && total !== null) staff.set(ownHeEngRegistryText(cell('UNITID', 10)), total);
    }
    const list: Institution[] = [];
    for await (const cell of table(files[0], ['UNITID', 'INSTNM', 'ADDR', 'CITY', 'STABBR', 'ZIP', 'WEBADDR', 'SECTOR', 'CYACTIVE', 'DEGGRANT'])) {
      const id = cell('UNITID', 10); const name = cell('INSTNM'); const state = cell('STABBR', 4); const street = cell('ADDR', 200); const city = cell('CITY', 100);
      const sector = IPEDS_SECTORS[cell('SECTOR', 4)];
      // Active this year and degree-granting: universities and colleges, not short vocational programmes.
      if (!/^\d{6}$/.test(id) || !name || cell('CYACTIVE', 4) !== '1' || cell('DEGGRANT', 4) !== '1' || !sector || !US_STATES.has(state) || !street || !city) continue;
      list.push({ id: ownHeEngRegistryText(id), name: ownHeEngRegistryText(name), addressKind: 'business',
        address: ownHeEngRegistryText(`${street}, ${city}, ${state} ${cell('ZIP', 12)}, United States`), website: ownHeEngRegistryText(website(cell('WEBADDR', 2048))),
        staff: staff.get(id) ?? null, year: eapYear, detail: ownHeEngRegistryText(sector) });
    }
    // A truncated or reshaped file is not IPEDS (3 989 active degree-granting institutions in HD2024).
    if (list.length < 2_500 || staff.size < 3_000) fail('registry_invalid_response');
    return list.sort(bySize);
  });
});

interface CcdTitle { schoolYear?: unknown; titleGroups?: Array<{ title?: unknown; elementGroups?: Array<{ componentGroups?: Array<{
  files?: Array<{ component?: unknown; fileURL?: unknown }> }> }> }> }
/** The newest school year with both the district directory and the staff file. */
async function ccdFiles(options: Options): Promise<{ year: number; directory: string; staff: string }> {
  let body: { selectionGroupModels?: CcdTitle[] };
  try { body = JSON.parse(await readHeEngRegistryText(CCD_FILES, { ...options, accept: 'application/json', maxBytes: MAX_LISTING_BYTES, timeoutMs: 60_000 })); }
  catch (error) { if (error instanceof SyntaxError) fail('registry_invalid_response'); throw error; }
  const years: Array<{ year: number; directory: string; staff: string }> = [];
  for (const group of Array.isArray(body?.selectionGroupModels) ? body.selectionGroupModels : []) {
    const year = Number(/^(\d{4})\s*-\s*\d{4}$/.exec(str(group?.schoolYear))?.[1]);
    const found: Record<string, string> = {};
    for (const title of group?.titleGroups ?? []) {
      // The universe survey itself, not its dropout, graduate or geography files.
      if (!/^Local Education Agency \(School District\) Universe Survey Data(?:, \(?v\.\d\w*\)?)?$/.test(str(title?.title))) continue;
      for (const element of title.elementGroups ?? []) for (const component of element.componentGroups ?? []) for (const file of component.files ?? []) {
        const url = str(file?.fileURL, 300); const kind = str(file?.component);
        if ((kind === 'Directory' || kind === 'Staff') && CCD_FILE.test(url)) found[kind] ??= url;
      }
    }
    if (year > 2000 && found.Directory && found.Staff) years.push({ year: year + 1, directory: found.Directory, staff: found.Staff });
  }
  const newest = years.sort((a, b) => b.year - a.year)[0];
  return newest ?? fail('registry_invalid_response');
}
// Districts that run schools or serve them: regular districts and their supervisory unions, service agencies
// (BOCES, education service centres), independent charter districts, specialised districts.
const LEA_KINDS: Readonly<Record<string, string>> = {
  1: 'regular school district', 2: 'regular school district in a supervisory union', 3: 'supervisory union', 4: 'education service agency',
  7: 'independent charter district', 9: 'specialised school district',
};
// Open, new, added, changed boundary, reopened.
const LEA_OPEN = new Set(['1', '3', '4', '5', '8']);
const districts = heEngRegistryBackgroundList(async (options: Options) => {
  const found = await ccdFiles(options);
  const files = [await download(found.directory, found.directory.split('/').pop()!, options), await download(found.staff, found.staff.split('/').pop()!, options)];
  return parsed(files, async () => {
    const staff = new Map<string, number>();
    for await (const cell of table(files[1], ['LEAID', 'STAFF_COUNT', 'TOTAL_INDICATOR'])) {
      const total = number(cell('STAFF_COUNT', 12));
      if (cell('TOTAL_INDICATOR', 40) === 'Education Unit Total' && total !== null) staff.set(ownHeEngRegistryText(cell('LEAID', 10)), total);
    }
    const list: Institution[] = [];
    for await (const cell of table(files[0], ['LEAID', 'LEA_NAME', 'LSTREET1', 'LCITY', 'LSTATE', 'LZIP', 'WEBSITE', 'SY_STATUS', 'LEA_TYPE'])) {
      const id = cell('LEAID', 10); const name = cell('LEA_NAME'); const state = cell('LSTATE', 4); const street = cell('LSTREET1', 200); const city = cell('LCITY', 100);
      if (!/^\d{7}$/.test(id) || !name || !LEA_OPEN.has(cell('SY_STATUS', 4)) || !LEA_KINDS[cell('LEA_TYPE', 4)] || !US_STATES.has(state) || !street || !city) continue;
      const schools = Number(cell('OPERATIONAL_SCHOOLS', 8));
      list.push({ id: ownHeEngRegistryText(id), name: ownHeEngRegistryText(name), addressKind: 'business',
        address: ownHeEngRegistryText(`${street}, ${city}, ${state} ${cell('LZIP', 12)}, United States`), website: ownHeEngRegistryText(website(cell('WEBSITE', 2048))),
        staff: staff.get(id) ?? null, year: found.year,
        detail: ownHeEngRegistryText([LEA_KINDS[cell('LEA_TYPE', 4)], schools > 0 ? `${schools} schools` : ''].filter(Boolean).join(', ')) });
    }
    // A truncated or reshaped file is not the CCD (19 630 agencies, 18 300 with staff in 2024-25).
    if (list.length < 12_000 || staff.size < 12_000) fail('registry_invalid_response');
    return list.sort(bySize);
  });
});

const PSS_LEVELS: Readonly<Record<string, string>> = { 1: 'elementary', 2: 'secondary', 3: 'combined elementary and secondary' };
const PSS_RELIGION: Readonly<Record<string, string>> = { 1: 'Catholic', 2: 'other religious', 3: 'nonsectarian' };
const privateSchools = heEngRegistryBackgroundList(async (options: Options) => {
  const page = await readHeEngRegistryText(PSS_PAGE, { ...options, accept: 'text/html', maxBytes: MAX_LISTING_BYTES, timeoutMs: 60_000 });
  // Newest first: «pss2324_pu_csv.zip» is the 2023–24 survey.
  const link = PSS_FILE.exec(page) ?? fail('registry_invalid_response');
  const year = 2000 + Number(link[3]);
  const files = [await download(`https://nces.ed.gov/surveys/pss/zip/${link[1]}`, link[1], options)];
  return parsed(files, async () => {
    const list: Institution[] = [];
    for await (const cell of table(files[0], ['PPIN', 'PINST', 'PADDRS', 'PCITY', 'PSTABB', 'PZIP', 'PL_ADD', 'PL_CIT', 'PL_STABB', 'PL_ZIP', 'NUMTEACH'])) {
      const id = cell('PPIN', 10).toUpperCase(); const name = cell('PINST');
      // The location address when the survey has one apart from the mailing address.
      const located = !!cell('PL_ADD', 200);
      const street = located ? cell('PL_ADD', 200) : cell('PADDRS', 200); const city = located ? cell('PL_CIT', 100) : cell('PCITY', 100);
      const state = located ? cell('PL_STABB', 4) : cell('PSTABB', 4); const zip = located ? cell('PL_ZIP', 12) : cell('PZIP', 12);
      if (!/^[A-Z0-9]{8}$/.test(id) || !name || !US_STATES.has(state) || !street || !city) continue;
      const teachers = number(cell('NUMTEACH', 12)); const students = number(cell('NUMSTUDS', 12));
      list.push({ id: ownHeEngRegistryText(id), name: ownHeEngRegistryText(name), address: ownHeEngRegistryText(`${street}, ${city}, ${state} ${zip}, United States`),
        addressKind: /^(?:p\.?\s*o\.?\s*box|box)\b/i.test(street) ? 'registered' : 'business', website: '', staff: teachers, year,
        detail: ownHeEngRegistryText([PSS_LEVELS[cell('LEVEL', 4)], PSS_RELIGION[cell('RELIG', 4)], students !== null ? `${Math.round(students)} students` : '']
          .filter(Boolean).join(', ')) });
    }
    // A truncated or reshaped file is not the survey (22 510 schools in 2023–24).
    if (list.length < 15_000) fail('registry_invalid_response');
    return list.sort(bySize);
  });
});

/**
 * Staff outside the slice's range are skipped. District staff and private
 * school teachers are full-time equivalents, fewer than the people employed:
 * a district counts from 80% of the range's minimum, a school's teachers from half.
 */
function withinRange(institution: Institution, category: string, task: HeEngRegistryTask): boolean {
  if (institution.staff === null) return (task.minEmployees ?? 0) < 10;
  const factor = category === 'private_schools' ? 2 : category === 'school_districts' ? 1.25 : 1;
  return institution.staff * factor >= (task.minEmployees ?? 0) && (task.maxEmployees === undefined || institution.staff <= task.maxEmployees);
}

function candidate(institution: Institution, category: string): HeEngRegistryCandidate {
  const staff = institution.staff === null ? null : Math.max(1, Math.round(institution.staff));
  const base = { provider: 'nces' as const, recordId: institution.id, company: institution.name, country: 'united states', address: institution.address,
    addressKind: institution.addressKind, website: institution.website, emails: [], employeeYear: institution.year };
  if (category === 'colleges') {
    return { ...base, category: `IPEDS ${institution.detail} institution`, ...(staff !== null ? { employees: String(staff) } : {}),
      description: str(`A degree-granting ${institution.detail} college or university in the US${staff !== null ? ` with ${staff} staff (IPEDS human resources survey, ${institution.year})` : ''}. Address and website from IPEDS; services and buyers require verification.`, 1500),
      sourceUrl: `https://nces.ed.gov/collegenavigator/?id=${institution.id}` };
  }
  if (category === 'school_districts') {
    return { ...base, category: 'NCES public school district', ...(staff !== null ? { employees: `${staff}+` } : {}),
      description: str(`A US public school district (${institution.detail})${staff !== null ? ` with ${staff} staff, full-time equivalent,` : ''} by the NCES Common Core of Data ${institution.year - 1}–${String(institution.year).slice(2)}. Address and website from its directory; services and buyers require verification.`, 1500),
      sourceUrl: `https://nces.ed.gov/ccd/districtsearch/district_detail.asp?ID2=${institution.id}` };
  }
  return { ...base, category: 'NCES private school', ...(staff !== null ? { employees: `${staff}+` } : {}),
    description: str(`A US private school (${institution.detail})${staff !== null ? ` with ${staff} teachers, full-time equivalent,` : ''} by the NCES Private School Survey ${institution.year - 1}–${String(institution.year).slice(2)}. Address from the survey; website and employee count require verification.`, 1500),
    sourceUrl: `https://nces.ed.gov/surveys/pss/privateschoolsearch/school_detail.asp?ID=${institution.id}` };
}

const LISTS: Readonly<Record<string, (options: Options) => Promise<Institution[]>>> = {
  colleges, school_districts: districts, private_schools: privateSchools,
};

/** One 25-institution page of an NCES slice; the caller validates the task and the position. */
export async function readHeEngNcesRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'nces' || task.country !== 'united states' || !Object.hasOwn(LISTS, task.category)) fail('registry_invalid_task');
  const list = (await LISTS[task.category](options)).filter(institution => withinRange(institution, task.category, task));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(institution => candidate(institution, task.category)), nextPosition: position + PAGE_SIZE,
    exhausted: position + page.length >= list.length, excluded: {}, recordsRead: page.length };
}
