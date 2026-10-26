import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { setImmediate as yieldLoop } from 'node:timers/promises';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { HE_ENG_NACE_CLASSES } from './engNaceRegistryCatalog';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryBackgroundList, heEngRegistryCacheFile, heEngRegistryCsvRows, openHeEngRegistryZipEntry,
  ownHeEngRegistryText, readHeEngRegistryBulkFile, type HeEngRegistryBuildOptions } from './engRegistryBulkFile';

/**
 * Swedish companies from the two registers' free high-value bulk files
 * (keyless, weekly). Statistics Sweden's (SCB) business register gives every
 * entity's legal form, status, SNI 2025 activity codes, postal address and
 * marketing block (reklamspärr); the Swedish Companies Registration Office's
 * (Bolagsverket) gives the registered name as written, the business
 * description and any deregistration, liquidation, bankruptcy or merger under
 * way. Kept: active legal persons of the catalogue's classes that Bolagsverket
 * registers — no sole traders, whom Swedish marketing law treats as
 * individuals, and no foreign companies known only to the Tax Agency — without
 * a marketing block, a liquidation, a bankruptcy or a merger into another
 * company, oldest first: neither file has a headcount. The two archives
 * (320 MB) are read once a week.
 */
const SCB_SOURCE = 'https://vardefulla-datamangder.bolagsverket.se/scb/scb_bulkfil.zip';
const BOLAGSVERKET_SOURCE = 'https://vardefulla-datamangder.bolagsverket.se/bolagsverket/bolagsverket_bulkfil.zip';
const MAX_ZIP_BYTES = 512 * 1024 * 1024;
const MAX_TABLE_BYTES = 2048 * 1024 * 1024;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const PAGE_SIZE = 25;
// Legal forms that trade (SCB code list Juridisk form) and Bolagsverket's form on its company page: trading and limited
// partnerships, bank and insurance companies, European and other limited companies, economic associations, mutual
// insurers, savings banks, Swedish branches of foreign companies.
const FORMS: Readonly<Record<string, [string, string]>> = {
  31: ['HB', 'trading or limited partnership'], 41: ['BAB', 'bank'], 42: ['FAB', 'insurance company'], 43: ['SE', 'European company'],
  49: ['AB', 'limited company'], 51: ['EK', 'economic association'], 92: ['OFB', 'mutual insurer'], 93: ['SB', 'savings bank'],
  96: ['FL', 'branch of a foreign company'],
};
const CLASSES = new Set(HE_ENG_NACE_CLASSES);
// SCB: registered with the Tax Agency as a legal person (2 is a sole trader), active by VAT, F-tax or employer registration.
const LEGAL_PERSON = '1';
const ACTIVE = '1';
const MARKETING_BLOCK = '2';
// Bolagsverket's procedures that end the company: liquidation, bankruptcy, a merger or demerger into another company, a move
// abroad. The acquiring side of a merger, a reconstruction and a composition with creditors leave it trading.
const ENDING_PROCEDURES = new Set(['LI', 'KK', 'FUOL', 'DEOL', 'GROM']);

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
// [organisation number, name, street, postcode, city, SCB form, SNI code, registered (YYYYMMDD), Bolagsverket form, description]
type Entity = [string, string, string, string, string, string, string, string, string, string];
type Cell = (name: string, max?: number) => string;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
/** Rows of SCB's tab-separated Latin-1 table (no quoting), as cell readers by column name. */
async function* table(stream: Readable, required: readonly string[]): AsyncGenerator<Cell> {
  stream.setEncoding('latin1');
  let column: Record<string, number> | null = null;
  let count = 0;
  for await (const line of createInterface({ input: stream, crlfDelay: Infinity })) {
    const cells: string[] = line.split('\t');
    if (!column) {
      column = Object.fromEntries(cells.map((name, i) => [name.trim(), i]));
      if (required.some(name => column![name] === undefined)) fail('registry_invalid_response');
      continue;
    }
    yield (name, max = 300) => column![name] === undefined ? '' : str(cells[column![name]], max);
    if (++count % 5000 === 0) await yieldLoop();
  }
}
async function download(url: string, name: string, options: HeEngRegistryBuildOptions): Promise<string> {
  return readHeEngRegistryBulkFile(url, heEngRegistryCacheFile(name), { fetch: options.fetch, now: options.now, maxBytes: MAX_ZIP_BYTES,
    maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: DOWNLOAD_TIMEOUT_MS });
}

async function parse(scbFile: string, bolagsverketFile: string): Promise<Map<string, Entity[]>> {
  const kept = new Map<string, Entity>();
  let seen = 0;
  for await (const cell of table(await openHeEngRegistryZipEntry(scbFile, MAX_TABLE_BYTES, /^scb_bulkfil.*\.txt$/i), ['PeOrgNr', 'Namn', 'JEStat',
    'FtgStat', 'JurForm', 'Reklamsparrtyp', 'Ng1', 'Gatuadress', 'PostNr', 'PostOrt', 'RegDatKtid'])) {
    seen += 1;
    const form = cell('JurForm', 4); const sni = cell('Ng1', 10);
    const code = /^\d{5}$/.test(sni) ? `${sni.slice(0, 2)}.${sni.slice(2, 4)}` : '';
    if (cell('JEStat', 4) !== LEGAL_PERSON || cell('FtgStat', 4) !== ACTIVE || cell('Reklamsparrtyp', 4) === MARKETING_BLOCK || !FORMS[form] ||
      !CLASSES.has(code)) continue;
    // A legal person's number carries the century prefix «16».
    const number = /^16(\d{10})$/.exec(cell('PeOrgNr', 14))?.[1];
    // A c/o line names a person: it is left out, and so is a company whose only street line it is.
    const name = cell('Namn'); const street = cell('Gatuadress', 150).replace(/^c\/o\b[^,]*,\s*/i, ''); const city = cell('PostOrt', 80);
    // Swedish sites write the postcode «111 22»; «000 00 UTLANDET» is an address abroad.
    const postcode = cell('PostNr', 10).replace(/^(\d{3})(\d{2})$/, '$1 $2');
    if (!number || !name || !street || /^c\/o\b/i.test(street) || !city || !/^\d{3} \d{2}$/.test(postcode) || postcode === '000 00' ||
      /^utlandet$/i.test(city)) continue;
    // Copies: the index must not keep the parsed file text alive. The c/o field often names a person and is left out.
    kept.set(number, [ownHeEngRegistryText(number), ownHeEngRegistryText(name), ownHeEngRegistryText(street), ownHeEngRegistryText(postcode),
      ownHeEngRegistryText(city), ownHeEngRegistryText(form), ownHeEngRegistryText(sni), ownHeEngRegistryText(cell('RegDatKtid', 8)), '', '']);
  }
  // A truncated or reshaped file is not the register (1 825 351 entities, 181 745 kept in October 2026).
  if (seen < 1_000_000 || kept.size < 50_000) fail('registry_invalid_response');
  let column: Record<string, number> | null = null;
  let rows = 0;
  const named = new Set<string>();
  const stream = await openHeEngRegistryZipEntry(bolagsverketFile, MAX_TABLE_BYTES, /^bolagsverket_bulkfil.*\.txt$/i);
  for await (const row of heEngRegistryCsvRows(stream, ';', { maxBytes: MAX_TABLE_BYTES })) {
    if (!column) {
      column = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
      if (['organisationsidentitet', 'organisationsnamn', 'organisationsform', 'avregistreringsdatum',
        'pagandeAvvecklingsEllerOmstruktureringsforfarande', 'verksamhetsbeskrivning'].some(name => column![name] === undefined)) fail('registry_invalid_response');
      continue;
    }
    rows += 1;
    const cell = (name: string, max = 300) => str(row[column![name]], max);
    const entity = kept.get(/^(\d{10})\$ORGNR-IDORG$/.exec(cell('organisationsidentitet', 40))?.[1] ?? '');
    if (!entity || named.has(entity[0])) continue;
    named.add(entity[0]);
    // «|LI-AVOMFO$2024-06-04|FUOT-AVOMFO$…»: deregistered, or ending, the company is not a buyer for long.
    const procedures = [...cell('pagandeAvvecklingsEllerOmstruktureringsforfarande', 400).matchAll(/([A-Z]+)-AVOMFO/g)].map(match => match[1]);
    if (cell('avregistreringsdatum', 20) || procedures.some(code => ENDING_PROCEDURES.has(code))) { kept.delete(entity[0]); continue; }
    // «Name$FORETAGSNAMN-ORGNAM$date|second name$SARS_FORNAMN-ORGNAM$…»: the first is the registered name, as written. The file
    // writes a quote inside a field as «\"», which the CSV reading cannot undo: such a name stays SCB's.
    const name = str(row[column.organisationsnamn]?.split('|').find(part => part.split('$')[1] === 'FORETAGSNAMN-ORGNAM')?.split('$')[0]);
    if (name && !/["\\]/.test(name)) entity[1] = ownHeEngRegistryText(name);
    entity[8] = ownHeEngRegistryText(/^([A-Z]{1,5})-ORGFO$/.exec(cell('organisationsform', 20))?.[1] ?? '');
    entity[9] = ownHeEngRegistryText(cell('verksamhetsbeskrivning', 200));
  }
  // 2 984 101 registered names, 177 752 of the kept companies among them in October 2026.
  if (rows < 1_500_000 || named.size < kept.size * 0.8) fail('registry_invalid_response');
  // Not registered with Bolagsverket: foreign companies known only to the Tax Agency, whose record page would be guessed.
  for (const number of kept.keys()) if (!named.has(number)) kept.delete(number);
  const byClass = new Map<string, Entity[]>();
  for (const entity of kept.values()) {
    const key = `${entity[6].slice(0, 2)}.${entity[6].slice(2, 4)}`;
    const list = byClass.get(key);
    if (list) list.push(entity); else byClass.set(key, [entity]);
  }
  for (const list of byClass.values()) list.sort((a, b) => (a[7] || '99999999').localeCompare(b[7] || '99999999') || (a[0] < b[0] ? -1 : 1));
  return byClass;
}

const entities = heEngRegistryBackgroundList(async (options: HeEngRegistryBuildOptions) => {
  const scb = await download(SCB_SOURCE, 'se-scb.zip', options);
  const bolagsverket = await download(BOLAGSVERKET_SOURCE, 'se-bolagsverket.zip', options);
  try { return await parse(scb, bolagsverket); }
  catch (error) { await discardHeEngRegistryBulkFile(scb); await discardHeEngRegistryBulkFile(bolagsverket); throw error; }
});

function candidate(entity: Entity): HeEngRegistryCandidate {
  const [number, name, street, postcode, city, form, sni, registered, bolagsverketForm, activities] = entity;
  const [urlForm, kind] = FORMS[form];
  const year = /^(\d{4})\d{4}$/.exec(registered)?.[1];
  return { provider: 'scb', recordId: number, company: name, country: 'sweden', address: `${street}, ${postcode} ${city}, Sweden`,
    addressKind: 'registered', category: `SNI 2025 ${sni}`, website: '', emails: [],
    description: str(`A Swedish ${kind} (SNI 2025 ${sni})${year ? `, registered in ${year}` : ''}.${activities ? ` ${activities}` : ''} From the Swedish business register (Statistics Sweden and Bolagsverket); postal address. Website, size and buyers require verification.`, 1500),
    sourceUrl: `https://foretagsinfo.bolagsverket.se/sok-foretagsinformation-web/foretag/${number}/foretagsform/${bolagsverketForm || urlForm}` };
}

/** One 25-company page of a Swedish slice; the caller validates the task and the position. No headcount: every slice reads the whole class. */
export async function readHeEngScbRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'scb' || task.country !== 'sweden' || !CLASSES.has(task.category)) fail('registry_invalid_task');
  const list = (await entities(options)).get(task.category) ?? [];
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length,
    excluded: {}, recordsRead: page.length };
}
