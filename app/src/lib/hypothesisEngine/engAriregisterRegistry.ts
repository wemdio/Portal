import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { HE_ENG_NACE_CLASSES, heEngNaceRev2Classes } from './engNaceRegistryCatalog';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryCacheFile, heEngRegistryCsvRows, openHeEngRegistryZipEntry,
  ownHeEngRegistryText, readHeEngRegistryBulkFile } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';
import { HeEngRegistryRetryError } from './engRegistryRetry';

/**
 * The Estonian e-Business Register's open data (keyless, CC BY 4.0). The
 * activity and the size of a company come from its annual reports: the main
 * EMTAK activity (EMTAK 2025 from 2025 reports, EMTAK 2008 before), the size
 * class (micro, small, medium, large) and the average number of employees in
 * full-time equivalents (a lower bound of the headcount: part-timers count as
 * fractions); name, legal form, status and address come from the
 * basic data. All four are whole files (about 75 MB zipped together), read
 * once a week in the background like the Czech register; a slice pages the
 * live companies of its class, largest first.
 */
const ORIGIN = 'https://avaandmed.ariregister.rik.ee';
const LISTING = `${ORIGIN}/en/downloading-open-data`;
const BASIC = '/sites/default/files/avaandmed/ettevotja_rekvisiidid__lihtandmed.csv.zip';
const REPORTS = /\/sites\/default\/files\/1\.aruannete_yldandmed_kuni_(\d{2})(\d{2})(\d{4})(?:_\d{1,3})?\.zip/g;
const ACTIVITIES = /\/sites\/default\/files\/2\.EMTAK_myygitulu_kuni_(\d{2})(\d{2})(\d{4})(?:_\d{1,3})?\.zip/g;
const INDICATORS = /\/sites\/default\/files\/4\.(\d{4})_aruannete_elemendid_kuni_(\d{2})(\d{2})(\d{4})(?:_\d{1,3})?\.zip/g;
const MAX_ZIP_BYTES = 128 * 1024 * 1024;
const MAX_CSV_BYTES = 1024 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const INDEX_MAX_AGE_MS = 24 * 60 * 60_000;
// After a failed read every slice gets the same error for a while instead of starting another download.
const FAILURE_PAUSE_MS = 15 * 60_000;
const CACHED = ['ee-reports.zip', 'ee-activities.zip', 'ee-indicators.zip', 'ee-basic.zip'];
const PAGE_SIZE = 25;
const EMPLOYEES = 'AverageNumberOfEmployeesInFullTimeEquivalentUnits';
// Legal forms that trade; sole traders (FIE), non-profits and foundations are left out.
const FORMS: Readonly<Record<string, string>> = {
  'Osaühing': 'private limited company', 'Aktsiaselts': 'public limited company', 'Täisühing': 'general partnership',
  'Usaldusühing': 'limited partnership', 'Tulundusühistu': 'commercial association',
  'Välismaa äriühingu filiaal': 'branch of a foreign company', 'Euroopa äriühing': 'European company',
};
// Report size classes as loose employee bounds (two of three thresholds decide the class) and a sort weight.
const CLASS_SIZE: Readonly<Record<string, { label: string; min: number; max: number | null; weight: number }>> = {
  'Mikroettevõtja': { label: 'micro', min: 0, max: 49, weight: 3 },
  'Väikeettevõtja': { label: 'small', min: 0, max: 249, weight: 20 },
  'Keskmise suurusega ettevõtja': { label: 'medium', min: 10, max: 999, weight: 100 },
  'Suurettevõtja': { label: 'large', min: 50, max: null, weight: 300 },
};
const CLASSES = new Set(HE_ENG_NACE_CLASSES);
// An EMTAK 2008 class to the Rev. 2.1 class that replaced it.
const FROM_REV2 = new Map(HE_ENG_NACE_CLASSES.flatMap(code => heEngNaceRev2Classes(code).map(old => [old, code] as const)));

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Company { code: string; name: string; address: string; form: string; emtak: string; employees: number | null; sizeClass: string }

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
/** The newest file of a series by its «until» date (DDMMYYYY); indicators files also by report year first, `year` picking one. */
function latest(html: string, pattern: RegExp, year?: number): string {
  let best: { path: string; key: string } | null = null;
  for (const match of html.matchAll(pattern)) {
    const [path, ...parts] = match;
    const reportYear = pattern === INDICATORS ? parts.shift() ?? '' : '';
    if (year !== undefined && Number(reportYear) !== year) continue;
    const key = `${reportYear}${parts[2]}${parts[1]}${parts[0]}`;
    if (!best || key > best.key) best = { path, key };
  }
  return best ? `${ORIGIN}${best.path}` : fail('registry_invalid_response');
}
function sizeOf(company: Company): number { return company.employees ?? CLASS_SIZE[company.sizeClass]?.weight ?? 0; }

/** Rows of one downloaded file with a reader of their named columns; a file without them is not the register's. */
async function* rowsOf(url: string, name: string, columns: readonly string[], options: Options): AsyncGenerator<(column: string) => string> {
  const file = await readHeEngRegistryBulkFile(url, heEngRegistryCacheFile(name), { fetch: options.fetch, now: options.now,
    maxBytes: MAX_ZIP_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  let at: Map<string, number> | null = null;
  for await (const row of heEngRegistryCsvRows(await openHeEngRegistryZipEntry(file, MAX_CSV_BYTES), ';', { maxBytes: MAX_CSV_BYTES })) {
    if (!at) {
      at = new Map(row.map((cell, i) => [cell.trim(), i]));
      if (columns.some(column => !at!.has(column))) fail('registry_invalid_response');
      continue;
    }
    yield (column: string) => row[at!.get(column)!] ?? '';
  }
}

async function build(options: Options): Promise<Map<string, Company[]>> {
  try { return await parse(options); }
  catch (error) {
    // A bad copy must not be reused for a week; the next read downloads again.
    for (const name of CACHED) await discardHeEngRegistryBulkFile(heEngRegistryCacheFile(name));
    throw error;
  }
}
async function parse(options: Options): Promise<Map<string, Company[]>> {
  const html = await readHeEngRegistryText(LISTING, { fetch: options.fetch, accept: 'text/html', maxBytes: 2 * 1024 * 1024, timeoutMs: 30_000 });
  const reportsUrl = latest(html, REPORTS), activitiesUrl = latest(html, ACTIVITIES);
  // The latest report of each company: its year, id and size class.
  const reports = new Map<string, { year: number; id: string; sizeClass: string }>();
  for await (const cell of rowsOf(reportsUrl, 'ee-reports.zip', ['report_id', 'registrikood', 'aruandeaasta',
    'minimaalne kategooria andmete alusel', 'valitud aruanne kategooria'], options)) {
    const code = str(cell('registrikood'), 10), id = str(cell('report_id'), 12), year = Number(cell('aruandeaasta'));
    if (!/^\d{8}$/.test(code) || !/^\d+$/.test(id) || !Number.isInteger(year)) continue;
    const previous = reports.get(code);
    if (previous && (previous.year > year || (previous.year === year && Number(previous.id) > Number(id)))) continue;
    // The class is stored as the constant key, never as a view of the parsed file text.
    const declared = str(cell('minimaalne kategooria andmete alusel'), 60) || str(cell('valitud aruanne kategooria'), 60);
    reports.set(code, { year, id: ownHeEngRegistryText(id), sizeClass: Object.keys(CLASS_SIZE).find(key => key === declared) ?? '' });
  }
  if (reports.size < 100_000) fail('registry_invalid_response');
  // Headcounts from the year most companies last reported on: a next year's file published early would cover few.
  const years = new Map<number, number>();
  for (const report of reports.values()) years.set(report.year, (years.get(report.year) ?? 0) + 1);
  const usualYear = [...years].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  let indicatorsUrl: string;
  try { indicatorsUrl = latest(html, INDICATORS, usualYear); } catch { indicatorsUrl = latest(html, INDICATORS); }
  const owners = new Map<string, string>();
  for (const [code, report] of reports) owners.set(report.id, code);
  // The main activity of that report, in a catalogue class.
  const matched = new Map<string, { nace: string; emtak: string }>();
  for await (const cell of rowsOf(activitiesUrl, 'ee-activities.zip', ['report_id', 'emtak', 'põhitegevusala', 'emtak_version'], options)) {
    if (cell('põhitegevusala') !== 'jah') continue;
    const code = owners.get(str(cell('report_id'), 12));
    const emtak = str(cell('emtak'), 10);
    if (!code || !/^\d{4,6}$/.test(emtak)) continue;
    const prefix = `${emtak.slice(0, 2)}.${emtak.slice(2, 4)}`;
    const nace = str(cell('emtak_version'), 20) === 'EMTAK 2025' ? (CLASSES.has(prefix) ? prefix : '') : FROM_REV2.get(prefix) ?? '';
    if (nace) matched.set(code, { nace, emtak: ownHeEngRegistryText(emtak) });
  }
  const wanted = new Map<string, string>();
  for (const code of matched.keys()) wanted.set(reports.get(code)!.id, code);
  const employees = new Map<string, number>();
  for await (const cell of rowsOf(indicatorsUrl, 'ee-indicators.zip', ['report_id', 'elemendi_nimetus', 'vaartus'], options)) {
    if (cell('elemendi_nimetus') !== EMPLOYEES) continue;
    const code = wanted.get(str(cell('report_id'), 12));
    const value = Number(cell('vaartus'));
    if (code && Number.isFinite(value) && value >= 0 && value < 1_000_000) employees.set(code, value);
  }
  const byClass = new Map<string, Company[]>();
  let kept = 0;
  for await (const cell of rowsOf(`${ORIGIN}${BASIC}`, 'ee-basic.zip', ['nimi', 'ariregistri_kood', 'ettevotja_oiguslik_vorm',
    'ettevotja_staatus', 'asukoht_ettevotja_aadressis', 'asukoha_ehak_tekstina', 'indeks_ettevotja_aadressis'], options)) {
    const code = str(cell('ariregistri_kood'), 10);
    const activity = matched.get(code);
    const declaredForm = str(cell('ettevotja_oiguslik_vorm'), 80);
    const form = Object.keys(FORMS).find(key => key === declaredForm);
    if (!activity || str(cell('ettevotja_staatus'), 5) !== 'R' || !form) continue;
    const name = str(cell('nimi'));
    // «Pirita linnaosa, Tallinn, Harju maakond» → Tallinn; «Tartu linn, Tartu linn, Tartu maakond» → Tartu.
    const places = str(cell('asukoha_ehak_tekstina'), 200).split(',').map(part => part.trim()).filter(Boolean);
    const city = (places.length >= 2 ? places[places.length - 2] : places[0] ?? '').replace(/\s+(?:linn|vald|alev|alevik|küla)$/i, '');
    const street = str(cell('asukoht_ettevotja_aadressis'), 200);
    const address = [street, [str(cell('indeks_ettevotja_aadressis'), 10), city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (!name || !city || address.length < 5) continue;
    const report = reports.get(code)!;
    const list = byClass.get(activity.nace) ?? [];
    list.push({ code: ownHeEngRegistryText(code), name: ownHeEngRegistryText(name), address: `${address}, Estonia`, form,
      emtak: activity.emtak, employees: employees.has(code) ? Math.round(employees.get(code)!) : null, sizeClass: report.sizeClass });
    byClass.set(activity.nace, list);
    kept += 1;
  }
  if (kept < 1000) fail('registry_invalid_response');
  for (const list of byClass.values()) list.sort((a, b) => sizeOf(b) - sizeOf(a) || (a.code < b.code ? -1 : 1));
  return byClass;
}

let index: { at: number; byClass: Map<string, Company[]> } | null = null;
let building: Promise<void> | null = null;
let failure: { at: number; error: Error } | null = null;
/** The list once read; a day-old list is served while the next one is read. */
async function companies(options: Options): Promise<Map<string, Company[]>> {
  const now = (options.now ?? Date.now)();
  if (index && now - index.at < INDEX_MAX_AGE_MS) return index.byClass;
  if (!index && failure && now - failure.at < FAILURE_PAUSE_MS) throw failure.error;
  building ??= build(options).then(byClass => { index = { at: (options.now ?? Date.now)(), byClass }; failure = null; },
    error => { failure = { at: (options.now ?? Date.now)(), error: error instanceof Error ? error : new Error('registry_unavailable') }; })
    .finally(() => { building = null; });
  if (index) return index.byClass;
  throw new HeEngRegistryRetryError(30_000);
}

/**
 * Full-time equivalents above the slice's maximum are outside it; under its
 * minimum only when even twice the number would not reach it (part-time staff).
 * Without them, the report size class decides loosely.
 */
function withinRange(company: Company, task: HeEngRegistryTask): boolean {
  const min = task.minEmployees ?? 0, max = task.maxEmployees;
  if (company.employees !== null) return company.employees * 2 >= min && (max === undefined || company.employees <= max);
  const bounds = CLASS_SIZE[company.sizeClass];
  // No annual report size at all: a company too new or too small to have filed one.
  if (!bounds) return min < 10;
  return (bounds.max === null || bounds.max >= min) && (max === undefined || bounds.min <= max);
}

function candidate(company: Company): HeEngRegistryCandidate {
  const size = CLASS_SIZE[company.sizeClass]?.label;
  return { provider: 'ariregister', recordId: company.code, company: company.name, country: 'estonia', address: company.address,
    addressKind: 'registered', category: `EMTAK ${company.emtak}`,
    // Full-time equivalents are a lower bound: «45+» never rejects a company of 50 people.
    ...(company.employees !== null ? { employees: `${company.employees}+` } : {}), website: '', emails: [],
    description: str(`An Estonian ${FORMS[company.form]} (EMTAK ${company.emtak})${size ? `, a ${size} company by its last annual report` : ''}${company.employees !== null ? ` with ${company.employees} employees in full-time equivalents` : ''}. From the Estonian e-Business Register open data; registered address. Website requires verification.`, 1500),
    sourceUrl: `https://ariregister.rik.ee/eng/company/${company.code}` };
}

/** One 25-company page of an Estonian slice; the caller validates the task and the position. */
export async function readHeEngAriregisterRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'ariregister' || task.country !== 'estonia' || !CLASSES.has(task.category)) fail('registry_invalid_task');
  const list = ((await companies(options)).get(task.category) ?? []).filter(company => withinRange(company, task));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length,
    excluded: {}, recordsRead: page.length };
}
