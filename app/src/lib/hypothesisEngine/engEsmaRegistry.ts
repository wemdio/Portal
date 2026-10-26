import { isIP } from 'node:net';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { ENG_COUNTRIES } from './engCountries';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { readHeEngGleifRegisteredAs, readHeEngRegistryText } from './engRegistryHttp';
import { ESMA_RECORD, validLei } from './engRegistryIdentity';

/**
 * ESMA's public register of alternative investment fund managers (AIFM) and
 * UCITS management companies authorised in the EU and the EEA, from the
 * national supervisors (Central Bank of Ireland, CSSF, AFM, BaFin, the Nordic
 * FSAs …). Every firm on it is licensed to manage funds; a record has the
 * legal name, LEI, head office address and supervisor, rarely a website.
 *
 * The register has no field to collapse a firm that is both an AIFM and a UCITS
 * manager, so one request reads the slice's countries whole (about 1 400 head
 * offices for ten countries), merges records of one LEI and pages that list.
 * The website is then found and proven like any registry company: the LEI or
 * the local register number GLEIF holds for it on the firm's own pages, or its
 * head office address next to its name.
 */
const ENDPOINT = 'https://registers.esma.europa.eu/solr/esma_registers_upreg/select';
/** ISO code → ESMA member state; the register covers no other countries. */
export const HE_ENG_ESMA_MEMBER_STATES: Readonly<Record<string, string>> = {
  at: 'austria', be: 'belgium', bg: 'bulgaria', hr: 'croatia', cy: 'cyprus', cz: 'czechia', dk: 'denmark', ee: 'estonia',
  fi: 'finland', fr: 'france', de: 'germany', gr: 'greece', hu: 'hungary', ie: 'ireland', it: 'italy', lv: 'latvia',
  lt: 'lithuania', lu: 'luxembourg', mt: 'malta', nl: 'netherlands', pl: 'poland', pt: 'portugal', ro: 'romania',
  sk: 'slovakia', si: 'slovenia', es: 'spain', se: 'sweden', no: 'norway', is: 'iceland', li: 'liechtenstein',
};
const TYPES: Readonly<Record<string, readonly string[]>> = { fund_managers: ['AIF', 'UCI'] };
const TYPE_LABELS: Readonly<Record<string, string>> = { AIF: 'alternative investment fund manager', UCI: 'UCITS management company' };
const PAGE_SIZE = 25;
const MAX_RECORDS = 6000;
const MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
// The register changes daily at most; one collection reads every page of a slice.
const CACHE_MS = 6 * 60 * 60_000;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Manager { key: string; id: string; lei: string; name: string; country: string; address: string; authority: string;
  types: Set<string>; funds: number | null; website: string; localRegistryId?: string }
type Row = Record<string, unknown>;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 500): string {
  return typeof raw === 'string'
    ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
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
/** «Emil-Riedl-Weg 6,82049,Pullach i. Isartal,DE» → «Emil-Riedl-Weg 6, 82049, Pullach i. Isartal, DE». */
function address(raw: unknown): string {
  return str(raw, 1500).split(',').map(part => part.trim()).filter(Boolean).join(', ');
}
function engCountry(state: unknown): string | null {
  const name = str(state).toLowerCase();
  const iso = Object.entries(HE_ENG_ESMA_MEMBER_STATES).find(([, value]) => value === name)?.[0];
  return iso ? ENG_COUNTRIES.find(country => country.iso2 === iso)?.value ?? null : null;
}

function query(task: HeEngRegistryTask): string {
  const types = TYPES[task.category];
  const states = (task.countries ?? [task.country]).map(value => {
    const iso = ENG_COUNTRIES.find(country => country.value === value)?.iso2 ?? '';
    return HE_ENG_ESMA_MEMBER_STATES[iso];
  });
  if (!types || !states.length || states.some(state => !state)) fail('registry_invalid_task');
  const url = new URL(ENDPOINT);
  // Active head offices only: a branch is the same firm registered in another country.
  url.searchParams.set('q', `ae_entityTypeCode:(${types.join(' OR ')}) AND ae_status:Active AND ae_officeType:"Head office" AND ae_homeMemberState:(${states.map(state => `"${state}"`).join(' OR ')})`);
  url.searchParams.set('fl', 'id,ae_lei,ae_entityName,ae_entityTypeCode,ae_homeMemberState,ae_headOfficeAddress,ae_competentAuthority,ae_website,no_of_funds');
  url.searchParams.set('rows', String(MAX_RECORDS));
  url.searchParams.set('sort', 'id asc');
  url.searchParams.set('wt', 'json');
  return url.href;
}

/** Letters and digits only, for comparing two spellings of one firm. */
function nameKey(name: string): string { return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }
/** ESMA cuts some names at 50 characters («…Management Limit»): a long prefix is the same name. */
function sameName(a: string, b: string): boolean {
  const [x, y] = [nameKey(a), nameKey(b)];
  return x === y || (Math.min(x.length, y.length) >= 30 && (x.startsWith(y) || y.startsWith(x)));
}

const cache = new Map<string, { at: number; managers: Manager[] }>();
const MAX_CACHED_SLICES = 16;
async function managers(task: HeEngRegistryTask, options: Options): Promise<Manager[]> {
  const cacheKey = `${task.category}:${(task.countries ?? [task.country]).join(',')}`;
  const now = (options.now ?? Date.now)();
  for (const [key, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(key);
  const cached = cache.get(cacheKey);
  if (cached) return cached.managers;
  let body: Row | null = null;
  try { body = JSON.parse(await readHeEngRegistryText(query(task), { ...options, accept: 'application/json', maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS })) as Row; }
  catch (error) { if (error instanceof SyntaxError) fail('registry_invalid_response'); throw error; }
  const response = body && typeof body.response === 'object' ? body.response as Row : null;
  const docs = response?.docs;
  const found = typeof response?.numFound === 'number' ? response.numFound : null;
  if (!Array.isArray(docs) || found === null) fail('registry_invalid_response');
  if (found > MAX_RECORDS) fail('registry_page_limit');
  // A register that answers fewer rows than it counts would silently shorten the list.
  if (docs.length < found) fail('registry_invalid_response');
  type EsmaRecord = Omit<Manager, 'key' | 'types'> & { type: string };
  const records: EsmaRecord[] = [];
  const allowed = task.countries ?? [task.country];
  for (const raw of docs as unknown[]) {
    const doc = raw && typeof raw === 'object' ? raw as Row : null;
    const id = str(doc?.id); const name = str(doc?.ae_entityName, 300); const type = str(doc?.ae_entityTypeCode).toUpperCase();
    const country = engCountry(doc?.ae_homeMemberState); const office = address(doc?.ae_headOfficeAddress);
    if (!/^ae\d{1,9}$/.test(id) || !name || !TYPE_LABELS[type] || !country || !allowed.includes(country) || office.length < 5) continue;
    const lei = str(doc?.ae_lei).toUpperCase();
    const funds = Number(str(doc?.no_of_funds));
    records.push({ id, lei: validLei(lei) ? lei : '', name, country, address: office, authority: str(doc?.ae_competentAuthority, 200),
      type, funds: Number.isSafeInteger(funds) && funds > 0 ? funds : null, website: website(doc?.ae_website) });
  }
  // One LEI under two different names (a rename, or a wrong LEI in the
  // register): no record of it is trusted with that LEI.
  const names = new Map<string, string[]>();
  for (const record of records) if (record.lei) names.set(record.lei, [...(names.get(record.lei) ?? []), record.name]);
  const conflicted = new Set([...names].filter(([, list]) => list.some(name => !sameName(name, list[0]))).map(([lei]) => lei));
  // One firm registered as both AIFM and UCITS manager: one LEI, or one name in
  // one country (ESMA leaves the LEI empty on some of a firm's records).
  const byKey = new Map<string, Manager>();
  const byName = new Map<string, Manager>();
  for (const record of records) {
    const lei = record.lei && !conflicted.has(record.lei) ? record.lei : '';
    const named = `${record.country}:${nameKey(record.name)}`;
    const sameNamed = byName.get(named);
    // Two different LEIs under one name stay two firms.
    const existing = (lei ? byKey.get(lei) : undefined) ?? (sameNamed && (!lei || !sameNamed.lei) ? sameNamed : undefined);
    if (existing) {
      existing.types.add(record.type);
      // Keep the full spelling over one cut at 50 characters.
      if (record.name.length > existing.name.length) existing.name = record.name;
      if (lei && !existing.lei) { byKey.delete(existing.key); Object.assign(existing, { lei, key: lei }); byKey.set(lei, existing); }
      byName.set(named, existing);
      continue;
    }
    const { type, ...rest } = record;
    const manager: Manager = { ...rest, key: lei || named, lei, types: new Set([type]) };
    byKey.set(manager.key, manager);
    byName.set(named, manager);
  }
  const list = [...byKey.values()];
  // Their legal notice names the entity with its local register number (see
  // readHeEngGleifRegisteredAs). Without GLEIF the list still works; it is not
  // cached then, so the next page asks again.
  let complete = true;
  try {
    const registered = await readHeEngGleifRegisteredAs(list.map(manager => manager.lei).filter(Boolean),
      { ...options, maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS });
    for (const manager of list) manager.localRegistryId = registered.get(manager.lei);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    complete = false;
  }
  if (complete) {
    if (cache.size >= MAX_CACHED_SLICES) cache.delete(cache.keys().next().value as string);
    cache.set(cacheKey, { at: now, managers: list });
  }
  return list;
}

function candidate(manager: Manager): HeEngRegistryCandidate {
  const kinds = [...manager.types].sort().map(type => TYPE_LABELS[type]);
  return { provider: 'esma', recordId: manager.lei || manager.id, company: manager.name, country: manager.country,
    address: manager.address, addressKind: 'business', category: `ESMA ${kinds.join(' and ')}`,
    ...(manager.localRegistryId ? { localRegistryId: manager.localRegistryId } : {}), website: manager.website, emails: [],
    description: str(`${/^[aeiou]/.test(kinds[0]) ? 'An' : 'A'} ${kinds.join(' and ')} authorised by ${manager.authority || 'its national supervisor'}${manager.funds ? `, ${manager.funds} funds registered` : ''}${manager.lei ? `; LEI ${manager.lei}` : ''}. From the ESMA register of fund managers; head office address from the register. Website, employee count and services require verification.`, 1500),
    sourceUrl: manager.lei ? `${ESMA_RECORD}ae_lei:${manager.lei}` : `${ESMA_RECORD}id:${manager.id}` };
}

/** One 25-firm page of an ESMA slice; the caller validates the task and the position. */
export async function readHeEngEsmaRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'esma' || task.country !== 'global') fail('registry_invalid_task');
  const list = await managers(task, options);
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE,
    exhausted: position + page.length >= list.length, excluded: {}, recordsRead: page.length };
}
