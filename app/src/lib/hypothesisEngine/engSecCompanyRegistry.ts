import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { ENG_COUNTRIES } from './engCountries';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { heEngRegistryBackgroundList, ownHeEngRegistryText, readHeEngRegistryRemoteZipEntry } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';

/**
 * Companies filing financial statements with the US SEC (keyless): the list
 * of filers (sub.txt) in the SEC's quarterly Financial Statement Data Sets —
 * about 6 000 companies a quarter, public and other SEC-reporting companies,
 * American and foreign — with the industry code (SIC), the business address
 * and the filer status, which tells the size of the public float. The last
 * four quarters are read, so that companies filing only an annual report
 * (20-F, 40-F) are in; only the list is read out of each 65 MB archive, by
 * byte ranges. A sector is a closed list of SIC codes; a slice reads its
 * countries' companies, large accelerated filers first. The records have no
 * website: it is found and proven like any registry company's.
 */
const LISTING = 'https://www.sec.gov/data-research/sec-markets-data/financial-statement-data-sets';
const QUARTERS = /href="\/files\/dera\/data\/financial-statement-data-sets\/(\d{4}q[1-4])\.zip"/g;
const QUARTERS_READ = 4;
const MAX_LISTING_BYTES = 4 * 1024 * 1024;
const MAX_LIST_BYTES = 64 * 1024 * 1024;
const PAGE_SIZE = 25;

/** SIC codes per sector (the SEC's list of codes); a pair is a range of codes. */
export const HE_ENG_SEC_SIC_SECTORS: Readonly<Record<string, ReadonlyArray<number | readonly [number, number]>>> = {
  software: [7370, 7371, 7372, 7373, 7374],
  banks: [6021, 6022, 6029, 6035, 6036],
  insurance: [6311, 6321, 6324, 6331, 6351, 6361, 6399],
  insurance_brokers: [6411],
  asset_management: [6282],
  hospitals: [8060, 8062],
  clinics: [8011, 8093],
  laboratories: [8071],
  trucking: [4210, 4213],
  construction: [1520, 1531, 1540, 1600, 1623, 1700, 1731],
  hotels: [7011],
  // Industrial machinery; computers and office equipment (3570–3579) are not.
  machinery: [[3510, 3569], [3580, 3599]],
  real_estate_agencies: [6531],
  engineering: [8711],
  recruitment: [7361, 7363],
  marketing_agencies: [7310, 7311],
  pharmacies: [5912],
  restaurants: [5810, 5812],
  car_dealers: [5500],
  // Every operating company of the list.
  public_companies: [[100, 8879]],
};
// Not operating companies: asset-backed issuers, commodity pools, investment
// trusts, royalty trusts, blank-check companies (SPACs).
const NOT_OPERATING = new Set([6189, 6221, 6726, 6792, 6795, 6770]);
const FILER_STATUS: Readonly<Record<string, string>> = {
  '1-LAF': 'a large accelerated filer (public float of $700 million or more)', '2-ACC': 'an accelerated filer (public float of $75–700 million)',
  '4-NON': 'a non-accelerated filer', '5-SML': 'a smaller reporting company',
};

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Filer { cik: string; name: string; sic: number; country: string; address: string; status: string; form: string; filed: string; accepted: string }

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
export function heEngSecSicInSector(sector: string, sic: number): boolean {
  return !NOT_OPERATING.has(sic) && (HE_ENG_SEC_SIC_SECTORS[sector] ?? []).some(code => typeof code === 'number' ? code === sic : sic >= code[0] && sic <= code[1]);
}

/** One quarter's filers by CIK. */
function quarter(text: string, filers: Map<string, Filer>): void {
  const lines = text.split('\n');
  const head = lines[0].replace(/^﻿/, '').replace(/\r$/, '').split('\t');
  const column = Object.fromEntries(head.map((name, i) => [name.trim(), i]));
  if (['cik', 'name', 'sic', 'countryba', 'stprba', 'cityba', 'zipba', 'bas1', 'bas2', 'afs', 'form', 'filed', 'accepted']
    .some(name => column[name] === undefined)) fail('registry_invalid_response');
  // A truncated or reshaped list is not the SEC's (6 516 filings of 6 008 companies in 2026 Q3).
  if (lines.length < 2_000) fail('registry_invalid_response');
  for (const line of lines.slice(1)) {
    const row = line.replace(/\r$/, '').split('\t');
    if (row.length < head.length) continue;
    const cell = (name: string, max = 300) => str(row[column[name]], max);
    const cik = cell('cik', 12).replace(/^0+/, '');
    const name = cell('name');
    const sic = Number(cell('sic', 6));
    const iso = cell('countryba', 4).toLowerCase();
    const country = ENG_COUNTRIES.find(item => item.iso2 === iso);
    const city = cell('cityba', 100);
    const street = [cell('bas1', 200), cell('bas2', 200)].filter(Boolean).join(', ');
    if (!/^\d{1,10}$/.test(cik) || !name || !Number.isInteger(sic) || sic < 100 || !country || !city || !street) continue;
    const accepted = cell('accepted', 30);
    const known = filers.get(cik);
    // The latest filing of the four quarters names the company and its address now.
    if (known && known.accepted >= accepted) continue;
    filers.set(cik, { cik: ownHeEngRegistryText(cik), name: ownHeEngRegistryText(name), sic, country: country.value,
      address: ownHeEngRegistryText([street, [city, [cell('stprba', 10), cell('zipba', 20)].filter(Boolean).join(' ')].join(', '), country.label].join(', ')),
      status: ownHeEngRegistryText(cell('afs', 10)), form: ownHeEngRegistryText(cell('form', 20)), filed: ownHeEngRegistryText(cell('filed', 10)),
      accepted: ownHeEngRegistryText(accepted) });
  }
}

const filers = heEngRegistryBackgroundList(async (options: Options) => {
  const page = await readHeEngRegistryText(LISTING, { ...options, accept: 'text/html', maxBytes: MAX_LISTING_BYTES, timeoutMs: 60_000 });
  const quarters = [...new Set([...page.matchAll(QUARTERS)].map(match => match[1]))].sort().reverse().slice(0, QUARTERS_READ);
  if (quarters.length < QUARTERS_READ) fail('registry_invalid_response');
  const byCik = new Map<string, Filer>();
  for (const name of quarters) {
    const list = await readHeEngRegistryRemoteZipEntry(`https://www.sec.gov/files/dera/data/financial-statement-data-sets/${name}.zip`, 'sub.txt',
      { fetch: options.fetch, maxBytes: MAX_LIST_BYTES, timeoutMs: 120_000 });
    quarter(list.toString('utf8'), byCik);
  }
  return [...byCik.values()];
});

const STATUS_RANK: Readonly<Record<string, number>> = { '1-LAF': 3, '2-ACC': 2 };
// A slice of companies up to this size reads the smaller filers first.
const SMALL_SCOPE_MAX_EMPLOYEES = 1000;

function candidate(filer: Filer): HeEngRegistryCandidate {
  const filed = /^(\d{4})(\d{2})(\d{2})$/.exec(filer.filed);
  return { provider: 'sec_companies', recordId: filer.cik, company: filer.name, country: filer.country, address: filer.address,
    addressKind: 'business', category: `SEC filer, SIC ${filer.sic}`, website: '', emails: [],
    description: str(`A company filing financial statements with the US SEC${FILER_STATUS[filer.status] ? `, ${FILER_STATUS[filer.status]}` : ''}; SIC ${filer.sic}. Business address from its latest filing (form ${filer.form || 'unknown'}${filed ? `, ${filed[1]}-${filed[2]}-${filed[3]}` : ''}). Website, employee count and services require verification.`, 1500),
    sourceUrl: `https://www.sec.gov/edgar/browse/?CIK=${filer.cik}` };
}

/** One 25-company page of an SEC filer slice; the caller validates the task and the position. */
export async function readHeEngSecCompanyRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'sec_companies' || task.country !== 'global' || !Object.hasOwn(HE_ENG_SEC_SIC_SECTORS, task.category)) fail('registry_invalid_task');
  const countries = task.countries ?? [];
  // No headcount in the list: the filer status orders the slice, the company's size is checked later.
  const small = task.maxEmployees !== undefined && task.maxEmployees < SMALL_SCOPE_MAX_EMPLOYEES;
  const list = (await filers(options)).filter(filer => countries.includes(filer.country) && heEngSecSicInSector(task.category, filer.sic))
    .sort((a, b) => ((STATUS_RANK[b.status] ?? 1) - (STATUS_RANK[a.status] ?? 1)) * (small ? -1 : 1) || Number(a.cik) - Number(b.cik));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length,
    excluded: {}, recordsRead: page.length };
}
