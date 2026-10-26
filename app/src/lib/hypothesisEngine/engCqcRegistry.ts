import type { Readable } from 'node:stream';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { TextDecoder } from 'node:util';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { readHeEngCorporateCharities, type HeEngCorporateCharities } from './engCharityCommissionRegistry';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, openHeEngRegistryZipEntry, ownHeEngRegistryText,
  readHeEngRegistryBulkFile, type HeEngRegistryBuildOptions } from './engRegistryBulkFile';
import { readHeEngRegistryText } from './engRegistryHttp';
import { heEngListedWebsite } from './engSecAdviserRegistry';

/**
 * Health and social care providers in England registered with the Care
 * Quality Commission (keyless, Open Government Licence): the monthly «care
 * directory with filters» spreadsheet (an OpenDocument file of 24 MB whose
 * sheet is 445 MB of XML, read as a stream) lists every active location with
 * its provider: the provider's address, website, Companies House number and
 * ownership, the location's services and care home beds. Locations are joined
 * into providers, the organisations that buy. Partnerships and individuals —
 * many GP and dental practices — are left out: UK e-mail marketing law (PECR)
 * lets them be e-mailed only with consent; so is an «organisation» without a
 * company number unless it is a public body, names itself a company or is a
 * corporate charity of the Charity Commission's register (some are trusts).
 * Names of managers and nominated individuals are not kept.
 */
const LISTING = 'https://www.cqc.org.uk/about-us/transparency/using-cqc-data';
const DIRECTORY = /https:\/\/www\.cqc\.org\.uk\/system\/files\/\d{4}-\d{2}\/\d{1,2}_[A-Za-z]+_\d{4}_HSCA_Active_Locations\.ods/;
const SHEET = 'HSCA_Active_Locations';
const MAX_FILE_BYTES = 256 * 1024 * 1024;
const MAX_SHEET_BYTES = 4 * 1024 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const PAGE_SIZE = 25;
// Empty cells at a row's end come as one cell repeated thousands of times.
const MAX_REPEAT = 512;
export const HE_ENG_CQC_CATEGORIES: readonly string[] = ['care_homes', 'home_care', 'dental', 'gp_practices', 'clinics', 'hospitals'];
// Rough staff per bed or per location, to keep a slice near its size; the real count is checked later.
const STAFF_TOLERANCE = 3;
// An «organisation» without a company number that is still a legal person: a council («South Tyneside MBC») or other public body,
// a named company, a CIO. «County» or «metropolitan» alone is in an unincorporated association's name too.
const PUBLIC_OR_CORPORATE = /\b(?:council|mbc|mdc|nhs|authority|university|college|cic|c\.i\.c|community interest company|cio|ltd|limited|plc|llp|incorporated|corporation)\b|\b(?:london|royal) borough of\b/i;
// Jersey, Guernsey and the Isle of Man are not in the United Kingdom.
const CROWN_DEPENDENCY = /^(?:JE|GY|IM)\d/i;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Provider { id: string; name: string; ownership: string; company: string; website: string; locationSite: string; address: string;
  locations: number; beds: number; kinds: Set<string> }
type Cell = (name: string, max?: number) => string;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}

/** Rows of one sheet of an OpenDocument spreadsheet's content.xml, as cell texts, read as a stream. */
async function* sheetRows(stream: Readable, sheet: string): AsyncGenerator<string[]> {
  const parser = new SaxesParser();
  const decoder = new TextDecoder('utf-8');
  const ready: string[][] = [];
  let inSheet = false; let row: string[] | null = null; let cell: string[] | null = null; let repeat = 1; let bytes = 0; let error: Error | null = null;
  parser.on('opentag', (tag: SaxesTagPlain) => {
    if (tag.name === 'table:table') inSheet = tag.attributes['table:name'] === sheet;
    else if (tag.name === 'table:table-row' && inSheet) row = [];
    else if ((tag.name === 'table:table-cell' || tag.name === 'table:covered-table-cell') && row) {
      cell = []; repeat = Math.min(MAX_REPEAT, Math.max(1, Number(tag.attributes['table:number-columns-repeated'] ?? 1) || 1));
    } else if (cell && (tag.name === 'text:p' ? cell.length > 0 : ['text:s', 'text:tab', 'text:line-break'].includes(tag.name))) cell.push(' ');
  });
  parser.on('text', text => { if (cell) cell.push(text); });
  parser.on('closetag', (tag: SaxesTagPlain) => {
    if ((tag.name === 'table:table-cell' || tag.name === 'table:covered-table-cell') && row && cell) {
      const value = cell.join('').trim();
      for (let i = 0; i < repeat; i += 1) row.push(value);
      cell = null;
    } else if (tag.name === 'table:table-row' && row) { ready.push(row); row = null; }
    else if (tag.name === 'table:table') inSheet = false;
  });
  parser.on('error', failure => { error = failure; });
  let chunks = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytes += chunk.byteLength;
    if (bytes > MAX_SHEET_BYTES) fail('registry_response_too_large');
    parser.write(decoder.decode(chunk, { stream: true }));
    if (error) fail('registry_invalid_response');
    yield* ready.splice(0);
    if (++chunks % 64 === 0) await yieldLoop();
  }
  parser.write(decoder.decode()).close();
  if (error) fail('registry_invalid_response');
  yield* ready.splice(0);
}

/** The kinds of care a location gives, by the directory's service flags. */
function kinds(cell: Cell): string[] {
  const yes = (name: string) => cell(name, 4) === 'Y';
  const category = cell('Location Primary Inspection Category', 80); const sector = cell('Location Type/Sector', 80);
  const found: string[] = [];
  if (yes('Care home?')) found.push('care_homes');
  if (yes('Service type - Domiciliary care service') || yes('Service type - Supported living service') || yes('Service type - Extra Care housing services')) {
    found.push('home_care');
  }
  if (yes('Service type - Dental service') || sector === 'Primary Dental Care') found.push('dental');
  if (category === 'GP Practices') found.push('gp_practices');
  else if (sector !== 'Primary Dental Care' && (yes('Service type - Doctors consultation service') || yes('Service type - Doctors treatment service') ||
    yes('Service type - Diagnostic and/or screening service') || yes('Service type - Community healthcare service') || yes('Service type - Urgent care services'))) {
    found.push('clinics');
  }
  if (yes('Service type - Acute services with overnight beds') || yes('Service type - Hospice services') ||
    yes('Service type - Hospital services for people with mental health needs, learning disabilities and problems with substance misuse')) found.push('hospitals');
  return found;
}

async function parse(file: string, charities: HeEngCorporateCharities | null): Promise<Provider[]> {
  const providers = new Map<string, Provider>();
  let column: Record<string, number> | null = null;
  let seen = 0;
  for await (const cells of sheetRows(await openHeEngRegistryZipEntry(file, MAX_SHEET_BYTES, /^content\.xml$/), SHEET)) {
    if (!column) {
      if (cells.includes('Location ID')) {
        column = Object.fromEntries(cells.map((name, i) => [name, i]).filter(([name]) => name));
        if (['Location ID', 'Dormant (Y/N)', 'Care home?', 'Location Web Address', 'Care homes beds', 'Location Type/Sector',
          'Location Primary Inspection Category', 'Provider ID', 'Provider Name', 'Provider Ownership Type', 'Provider Companies House Number',
          'Provider Web Address', 'Provider Street Address', 'Provider City', 'Provider Postal Code', 'Provider Charity Number']
          .some(name => column![name] === undefined)) fail('registry_invalid_response');
      }
      continue;
    }
    const cell: Cell = (name, max = 300) => column![name] === undefined ? '' : str(cells[column![name]] ?? '', max);
    if (!cell('Location ID', 20)) continue;
    seen += 1;
    const ownership = cell('Provider Ownership Type', 30);
    const id = cell('Provider ID', 20); const name = cell('Provider Name');
    // Partnerships and individuals may be e-mailed only with consent (PECR); dormant locations give no care.
    if (!['Organisation', 'NHS Body'].includes(ownership) || cell('Dormant (Y/N)', 4) === 'Y' || !/^1-\d{6,12}$/.test(id) || !name) continue;
    let provider = providers.get(id);
    if (!provider) {
      const address = ['Provider Street Address', 'Provider Address Line 2', 'Provider City', 'Provider County', 'Provider Postal Code']
        .map(part => cell(part, 120)).filter(Boolean).join(', ');
      if (!cell('Provider City', 80) || !cell('Provider Postal Code', 12) || CROWN_DEPENDENCY.test(cell('Provider Postal Code', 12))) continue;
      const typed = cell('Provider Companies House Number', 12).toUpperCase(); const named = PUBLIC_OR_CORPORATE.test(name);
      // The directory drops a company number's leading zero now and then («4231521» for a «… Limited»); without a company word in
      // the name, seven digits may be a charity number typed into the field.
      const company = /^\d{7}$/.test(typed) && named ? `0${typed}` : typed;
      const corporate = ownership === 'NHS Body' || /^[A-Z0-9]{8}$/.test(company) || named || !!charities?.numbers.has(cell('Provider Charity Number', 12));
      if (!corporate) continue;
      // Copies: the list must not keep the parsed file text alive.
      provider = { id: ownHeEngRegistryText(id), name: ownHeEngRegistryText(name), ownership: ownHeEngRegistryText(ownership),
        company: /^[A-Z0-9]{8}$/.test(company) ? ownHeEngRegistryText(company) : '',
        website: ownHeEngRegistryText(heEngListedWebsite(cell('Provider Web Address', 2048), { home: true })), locationSite: '',
        address: ownHeEngRegistryText(`${address}, United Kingdom`), locations: 0, beds: 0, kinds: new Set() };
      providers.set(id, provider);
    }
    provider.locations += 1;
    const beds = Number(cell('Care homes beds', 10));
    if (Number.isFinite(beds) && beds > 0 && beds < 10_000) provider.beds += beds;
    for (const kind of kinds(cell)) provider.kinds.add(kind);
    // A provider without its own website, with one location that has one.
    if (provider.locations === 1) provider.locationSite = ownHeEngRegistryText(heEngListedWebsite(cell('Location Web Address', 2048), { home: true }));
  }
  // A truncated or reshaped file is not the directory (57 097 active locations of 37 089 providers in October 2026).
  if (!column || seen < 30_000 || providers.size < 15_000) fail('registry_invalid_response');
  return [...providers.values()];
}

const providers = heEngRegistryBackgroundList(async (options: HeEngRegistryBuildOptions) => {
  const page = await readHeEngRegistryText(LISTING, { fetch: options.fetch, accept: 'text/html', maxBytes: 4 * 1024 * 1024, timeoutMs: 60_000 });
  const link = DIRECTORY.exec(page)?.[0] ?? fail('registry_invalid_response');
  const file = await readHeEngRegistryBulkFile(link, heEngRegistryCacheFile('cqc-directory.ods'), { fetch: options.fetch, now: options.now,
    maxBytes: MAX_FILE_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: 10 * 60_000 });
  // Charity-run providers are told from trusts by the Charity Commission's register; without it they need a company number.
  const charities = await readHeEngCorporateCharities(options);
  try { return await parse(file, charities); }
  catch (error) { await discardHeEngRegistryBulkFile(file); throw error; }
});

/** Staff a provider of this kind roughly has: about 1.2 per care home bed, a branch of home care 40, a dental practice 10. */
function staff(provider: Provider, category: string): number {
  if (category === 'care_homes') return provider.beds * 1.2 + provider.locations * 5;
  if (category === 'home_care') return provider.locations * 40;
  if (category === 'dental') return provider.locations * 10;
  if (category === 'hospitals') return provider.ownership === 'NHS Body' ? 3000 : provider.locations * 150;
  return provider.locations * 15;
}
function slice(list: readonly Provider[], task: HeEngRegistryTask): Provider[] {
  const min = task.minEmployees ?? 0; const max = task.maxEmployees;
  const kept = list.filter(provider => provider.kinds.has(task.category)).map(provider => ({ provider, staff: staff(provider, task.category) }))
    .filter(item => item.staff * STAFF_TOLERANCE >= min && (max === undefined || item.staff / STAFF_TOLERANCE <= max));
  const middle = max === undefined ? null : Math.log(Math.sqrt(Math.max(1, min) * Math.max(1, max)));
  return kept.sort((a, b) => (middle === null ? b.staff - a.staff : Math.abs(Math.log(Math.max(1, a.staff)) - middle) - Math.abs(Math.log(Math.max(1, b.staff)) - middle)) ||
    (a.provider.id < b.provider.id ? -1 : 1)).map(item => item.provider);
}
let ordered: { list: readonly Provider[]; key: string; providers: Provider[] } | null = null;

const KIND_LABELS: Readonly<Record<string, string>> = {
  care_homes: 'care homes', home_care: 'home care', dental: 'dental care', gp_practices: 'GP services', clinics: 'clinics and community health',
  hospitals: 'hospital care',
};
function candidate(provider: Provider, category: string): HeEngRegistryCandidate {
  const services = HE_ENG_CQC_CATEGORIES.filter(kind => provider.kinds.has(kind)).map(kind => KIND_LABELS[kind]).join(', ');
  // A location's site stands for the provider only when it is the provider's one location.
  const website = provider.website || (provider.locations === 1 ? provider.locationSite : '');
  return { provider: 'cqc', recordId: provider.id, company: provider.name, country: 'united kingdom', address: provider.address, addressKind: 'business',
    category: `CQC registered provider, ${KIND_LABELS[category]}`, ...(provider.company ? { localRegistryId: provider.company } : {}), website, emails: [],
    description: str(`A provider registered with the Care Quality Commission in England${provider.ownership === 'NHS Body' ? ' (NHS body)' : ''}: ${services}; ${provider.locations} location${provider.locations === 1 ? '' : 's'}${provider.beds ? `, ${provider.beds} care home beds` : ''}${provider.company ? `; company ${provider.company}` : ''}. From the CQC care directory (registered address${website ? ', website' : ''}); staff count and buyers require verification.`, 1500),
    sourceUrl: `https://www.cqc.org.uk/provider/${provider.id}` };
}

/** One 25-provider page of a CQC slice; the caller validates the task and the position. */
export async function readHeEngCqcRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'cqc' || task.country !== 'united kingdom' || !HE_ENG_CQC_CATEGORIES.includes(task.category)) fail('registry_invalid_task');
  const all = await providers(options);
  const key = `${task.category}:${task.minEmployees ?? ''}:${task.maxEmployees ?? ''}`;
  if (ordered?.list !== all || ordered.key !== key) ordered = { list: all, key, providers: slice(all, task) };
  const page = ordered.providers.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(provider => candidate(provider, task.category)), nextPosition: position + PAGE_SIZE,
    exhausted: position + page.length >= ordered.providers.length, excluded: {}, recordsRead: page.length };
}
