import { createReadStream } from 'node:fs';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { HE_ENG_NACE_CLASSES } from './engNaceRegistryCatalog';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { discardHeEngRegistryBulkFile, heEngRegistryCacheFile, heEngRegistryCsvRows, ownHeEngRegistryText,
  readHeEngRegistryBulkFile } from './engRegistryBulkFile';
import { HeEngRegistryRetryError } from './engRegistryRetry';

/**
 * The Czech Statistical Office's business register (RES) as open data
 * (keyless, monthly): every economic entity with its legal form, CZ-NACE 2025
 * activity, registered seat and employee-size category. ARES's own search
 * stops at 1 000 results and has no size, so the whole file (about 550 MB) is
 * downloaded once a week and the live companies of the catalogue's classes are
 * kept, largest first; a slice pages that list. The download and the reading
 * run in the background: the stage comes back for the list (a free read, no
 * cursor moves), as with the Companies House snapshot.
 */
const SOURCE = 'https://opendata.czso.cz/data/od_org03/res_data.csv';
const FILE = 'czso-res.csv';
const MAX_BYTES = 1536 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;
const FILE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;
// The index is rebuilt from the file on disk after a day.
const INDEX_MAX_AGE_MS = 24 * 60 * 60_000;
// After a failed read every slice gets the same error for a while instead of starting another download.
const FAILURE_PAUSE_MS = 15 * 60_000;
const PAGE_SIZE = 25;
// Legal forms that trade (CZSO code list PravniForma): general and limited
// partnerships, limited liability and joint-stock companies, co-operatives,
// state enterprises, branches of foreign companies, European companies.
const FORMS: Readonly<Record<string, string>> = {
  111: 'general partnership', 112: 'limited liability company', 113: 'limited partnership', 121: 'joint-stock company',
  205: 'co-operative', 301: 'state enterprise', 421: 'branch of a foreign company', 932: 'European company',
};
// Employee-size categories (CZSO code list KategoriePoctuPracovniku); «000» is unknown.
const SIZE: Readonly<Record<string, [number, number | null]>> = {
  110: [0, 0], 120: [1, 5], 130: [6, 9], 210: [10, 19], 220: [20, 24], 230: [25, 49], 240: [50, 99], 310: [100, 199],
  320: [200, 249], 330: [250, 499], 340: [500, 999], 410: [1000, 1499], 420: [1500, 1999], 430: [2000, 2499],
  440: [2500, 2999], 450: [3000, 3999], 460: [4000, 4999], 470: [5000, 9999], 510: [10000, null],
};
const CLASSES = new Set(HE_ENG_NACE_CLASSES.map(code => code.replace('.', '')));
// 39% of live companies file a 2- or 3-digit CZ-NACE code («62», «582»). A short
// code counts where every class under it is in one catalogue sector (software
// publishing includes games, road freight includes removals, advertising
// includes media representation), in that sector's first class.
const SHORT_CODES: Readonly<Record<string, string>> = {
  62: '6210', 621: '6210', 622: '6220', 629: '6290', 582: '5829', 641: '6419', 651: '6511', 652: '6520', 663: '6630',
  861: '8610', 494: '4941', 41: '4100', 410: '4100', 551: '5510', 691: '6910', 692: '6920', 75: '7500', 750: '7500',
  79: '7911', 791: '7911', 78: '7810', 781: '7810', 782: '7820', 731: '7311',
};
function catalogueClass(nace: string): string {
  return nace.length >= 4 ? (CLASSES.has(nace.slice(0, 4)) ? nace.slice(0, 4) : '') : SHORT_CODES[nace] ?? '';
}

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
// [ICO, name, seat, size category, form, CZ-NACE 2025]
type Entity = [string, string, string, string, string, string];

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string' ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function sizeRank(code: string): number { return SIZE[code] ? (SIZE[code][1] ?? 1e6) : -1; }

let index: { at: number; byClass: Map<string, Entity[]> } | null = null;
let building: Promise<void> | null = null;
let failure: { at: number; error: Error } | null = null;
async function build(options: Options): Promise<Map<string, Entity[]>> {
  const file = await readHeEngRegistryBulkFile(SOURCE, heEngRegistryCacheFile(FILE), { fetch: options.fetch, now: options.now,
    maxBytes: MAX_BYTES, maxAgeMs: FILE_MAX_AGE_MS, timeoutMs: DOWNLOAD_TIMEOUT_MS });
  try { return await parse(file); }
  catch (error) { await discardHeEngRegistryBulkFile(file); throw error; }
}
async function parse(file: string): Promise<Map<string, Entity[]>> {
  const byClass = new Map<string, Entity[]>();
  let kept = 0;
  let column: Record<string, number> | null = null;
  let seen = 0;
  for await (const row of heEngRegistryCsvRows(createReadStream(file), ',', { maxBytes: MAX_BYTES })) {
    if (!column) {
      column = Object.fromEntries(row.map((name, i) => [name.trim(), i]));
      if (['ICO', 'DDATZAN', 'FORMA', 'KATPO', 'NACE2025', 'FIRMA', 'PSC', 'OBEC_TEXT', 'COBCE_TEXT', 'ULICE_TEXT', 'CDOM', 'COR']
        .some(name => column![name] === undefined)) fail('registry_invalid_response');
      continue;
    }
    seen += 1;
    const cell = (name: string, max = 300) => str(row[column![name]], max);
    const nace = cell('NACE2025', 10);
    const code = catalogueClass(nace);
    if (cell('DDATZAN') || !FORMS[cell('FORMA', 5)] || !code) continue;
    const ico = cell('ICO', 10);
    const name = cell('FIRMA');
    const city = cell('OBEC_TEXT', 100);
    const number = [cell('CDOM', 10), cell('COR', 10)].filter(Boolean).join('/');
    const street = [cell('ULICE_TEXT', 100) || cell('COBCE_TEXT', 100), number].filter(Boolean).join(' ');
    // Czech sites write the postcode «140 00».
    const postcode = cell('PSC', 10).replace(/^(\d{3})(\d{2})$/, '$1 $2');
    const seat = [street, [postcode, city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    if (!/^\d{8}$/.test(ico) || !name || !city || seat.length < 5) continue;
    const key = `${code.slice(0, 2)}.${code.slice(2, 4)}`;
    const list = byClass.get(key) ?? [];
    // Copies: the index must not keep the parsed file text alive.
    list.push([ownHeEngRegistryText(ico), ownHeEngRegistryText(name), ownHeEngRegistryText(seat), ownHeEngRegistryText(cell('KATPO', 5)),
      ownHeEngRegistryText(cell('FORMA', 5)), ownHeEngRegistryText(nace)]);
    byClass.set(key, list);
    kept += 1;
  }
  // A truncated or reshaped file is not the register (2.9 million live entities, 140 000 kept in October 2026).
  if (seen < 1_000_000 || kept < 10_000) fail('registry_invalid_response');
  for (const list of byClass.values()) list.sort((a, b) => sizeRank(b[3]) - sizeRank(a[3]) || (a[0] < b[0] ? -1 : 1));
  return byClass;
}
/** The list once read; a day-old list is served while the next one is read. */
async function entities(options: Options): Promise<Map<string, Entity[]>> {
  const now = (options.now ?? Date.now)();
  if (index && now - index.at < INDEX_MAX_AGE_MS) return index.byClass;
  if (!index && failure && now - failure.at < FAILURE_PAUSE_MS) throw failure.error;
  // Not tied to one stage run's signal: the next run picks up the finished list.
  building ??= build(options).then(byClass => { index = { at: (options.now ?? Date.now)(), byClass }; failure = null; },
    error => { failure = { at: (options.now ?? Date.now)(), error: error instanceof Error ? error : new Error('registry_unavailable') }; })
    .finally(() => { building = null; });
  if (index) return index.byClass;
  throw new HeEngRegistryRetryError(30_000);
}

// An entity that states no size is almost always a micro or dormant one: a 10+ slice skips it.
const UNKNOWN_SIZE_MAX_MIN = 10;
/** Known size categories outside the slice's range are skipped; an unknown size only stays for small-company slices. */
function withinRange(entity: Entity, task: HeEngRegistryTask): boolean {
  const band = SIZE[entity[3]];
  if (!band) return (task.minEmployees ?? 0) < UNKNOWN_SIZE_MAX_MIN;
  return (task.maxEmployees === undefined || band[0] <= task.maxEmployees) && (band[1] === null || band[1] >= (task.minEmployees ?? 0));
}

function candidate(entity: Entity): HeEngRegistryCandidate {
  const [ico, name, seat, size, form, nace] = entity;
  const shown = nace.length >= 4 ? nace : `${nace} (division or group)`;
  const band = SIZE[size];
  const employees = band ? (band[1] === null ? `${band[0]}+` : band[0] === band[1] ? String(band[0]) : `${band[0]}-${band[1]}`) : '';
  return { provider: 'czso', recordId: ico, company: name, country: 'czechia', address: `${seat}, Czechia`, addressKind: 'registered',
    category: `CZ-NACE ${shown}`, ...(employees ? { employees } : {}), website: '', emails: [],
    description: str(`A Czech ${FORMS[form] ?? 'company'} (CZ-NACE 2025 ${shown})${employees ? `, ${employees} employees by the statistical register` : ''}. From the Czech Statistical Office business register (RES); registered seat. Website requires verification.`, 1500),
    sourceUrl: `https://ares.gov.cz/ekonomicke-subjekty?ico=${ico}` };
}

/** One 25-company page of a Czech slice; the caller validates the task and the position. */
export async function readHeEngCzsoRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'czso' || task.country !== 'czechia' || !CLASSES.has(task.category.replace('.', ''))) fail('registry_invalid_task');
  const list = ((await entities(options)).get(task.category) ?? []).filter(entity => withinRange(entity, task));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE, exhausted: position + page.length >= list.length,
    excluded: {}, recordsRead: page.length };
}
