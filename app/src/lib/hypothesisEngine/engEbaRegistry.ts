import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { ENG_COUNTRIES } from './engCountries';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { readHeEngGleifRegisteredAsByName, readHeEngRegistryText } from './engRegistryHttp';
import { EBA_RECORD, HE_ENG_EBA_ENTITY_TYPES } from './engRegistryIdentity';

/**
 * The EBA's central register of payment institutions, electronic money
 * institutions and account information service providers authorised under
 * PSD2 in the EU and the EEA, as reported by the national supervisors. Every
 * firm on it is licensed for payments; a record has the legal name, a brand
 * name for some, the supervisor's reference (the Central Bank of Ireland's
 * «C182347», DNB's «R149006», or the company number: Norwegian, Danish, Swedish
 * and Finnish supervisors file the organisation number) and the head office
 * address, no website and no LEI.
 *
 * The register's own search answers one query for all of a slice's countries
 * (576 records for the eight EU/EEA countries of HST, about 650 kB); agents and
 * branches, which are 98% of the register, are never asked for. The website is
 * then found and proven like any registry company: the firm's company number
 * (KvK, HRB, CRO … from GLEIF's record of its exact legal name), the
 * supervisor's reference («relationship number: F0038» in Mollie's footer) or
 * its head office address next to its name on its own pages.
 */
const ENDPOINT = 'https://euclid.eba.europa.eu/register/api/search/entities';
const TYPES: Readonly<Record<string, readonly string[]>> = { payment_institutions: HE_ENG_EBA_ENTITY_TYPES };
const TYPE_LABELS: Readonly<Record<string, string>> = {
  PSD_PI: 'payment institution', PSD_EMI: 'electronic money institution', PSD_AISP: 'account information service provider',
};
const PAGE_SIZE = 25;
const MAX_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60_000;
// Supervisors update the register daily; one collection reads every page of a slice.
const CACHE_MS = 6 * 60 * 60_000;
const MAX_CACHED_SLICES = 16;
// GLEIF allows 60 requests a minute; a page asks for at most 25 names.
const GLEIF_SPACING_MS = 1000;
const MAX_NUMBERS = 5000;

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Institution { code: string; codeType: string; types: Set<string>; name: string; brands: string[]; reference: string;
  supervisor: string; country: string; address: string }
type Row = Record<string, unknown>;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 500): string {
  return typeof raw === 'string'
    ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function list(raw: unknown): unknown[] { return Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]; }
function nameKey(name: string): string { return name.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''); }

function body(task: HeEngRegistryTask): string {
  const types = TYPES[task.category];
  const codes = (task.countries ?? [task.country]).map(value => (ENG_COUNTRIES.find(country => country.value === value)?.iso2 ?? '').toUpperCase());
  if (!types || !codes.length || codes.some(code => !/^[A-Z]{2}$/.test(code))) fail('registry_invalid_task');
  // The same query the register's own search page sends; agents and branches are other entity types.
  return JSON.stringify({ $and: [{ '_payload.EntityType': { $in: types } },
    { _searchkeys: { $elemMatch: { T: 'P', K: 'ENT_COU_RES', V: { $in: codes } } } }] });
}

const cache = new Map<string, { at: number; institutions: Institution[] }>();
async function institutions(task: HeEngRegistryTask, options: Options): Promise<Institution[]> {
  const allowed = task.countries ?? [task.country];
  const cacheKey = `${task.category}:${allowed.join(',')}`;
  const now = (options.now ?? Date.now)();
  for (const [key, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(key);
  const cached = cache.get(cacheKey);
  if (cached) return cached.institutions;
  let docs: unknown;
  try {
    docs = JSON.parse(await readHeEngRegistryText(ENDPOINT, { ...options, accept: 'application/json', body: body(task),
      contentType: 'application/json', maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS }));
  } catch (error) { if (error instanceof SyntaxError) fail('registry_invalid_response'); throw error; }
  if (!Array.isArray(docs)) fail('registry_invalid_response');
  const byName = new Map<string, Institution>();
  const payloads = docs.map(raw => raw && typeof raw === 'object' ? ((raw as Row)._payload ?? raw) as Row : null);
  // Sorted by the register's key, so that a fresh read pages in the same order and a merged firm keeps the same code.
  payloads.sort((a, b) => { const x = str(a?.EntityCode, 60), y = str(b?.EntityCode, 60); return x < y ? -1 : x > y ? 1 : 0; });
  for (const payload of payloads) {
    const props: Row = {};
    for (const item of list(payload?.Properties)) if (item && typeof item === 'object') Object.assign(props, item);
    const code = str(payload?.EntityCode, 60); const type = str(payload?.EntityType);
    const name = str(props.ENT_NAM, 300); const iso = str(props.ENT_COU_RES).toLowerCase();
    const country = ENG_COUNTRIES.find(item => item.iso2 === iso)?.value ?? '';
    // An odd number of authorisation dates means authorised now; an even one, authorised and withdrawn.
    const authorised = list(props.ENT_AUT).length % 2 === 1;
    const office = [str(props.ENT_ADD, 300).replace(/[\s,;]+$/, ''), [str(props.ENT_POS_COD, 20), str(props.ENT_TOW_CIT_RES, 100)].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ');
    // Codes differ by supervisor: «IE_CBI!C182347», «FI_FIN_FSA!29182549», «FT00128275», «41801298».
    if (!/^[A-Za-z0-9][A-Za-z0-9_!.-]{3,29}$/.test(code) || !TYPE_LABELS[type] || !name || !authorised ||
      !country || !allowed.includes(country) || office.length < 5) continue;
    // One firm licensed both as a payment and an e-money institution keeps one record.
    const key = `${country}:${nameKey(name)}`;
    const existing = byName.get(key);
    if (existing) { existing.types.add(type); continue; }
    byName.set(key, { code, codeType: type, types: new Set([type]), name, brands: list(props.ENT_NAM_COM).map(item => str(item, 200))
      .filter(brand => brand && nameKey(brand) !== nameKey(name)).slice(0, 3),
      reference: str(props.ENT_NAT_REF_COD, 40), supervisor: str(payload?.CA_OwnerID, 30), country, address: office });
  }
  const result = [...byName.values()];
  if (cache.size >= MAX_CACHED_SLICES) cache.delete(cache.keys().next().value as string);
  cache.set(cacheKey, { at: now, institutions: result });
  return result;
}

// Firm code → GLEIF's company number ('' when GLEIF holds none).
const registeredAs = new Map<string, string>();
/** Company numbers for a page's firms; without GLEIF the page goes on with the supervisors' references, and the next page asks again. */
async function readRegisteredAs(firms: readonly Institution[], options: Options): Promise<void> {
  if (registeredAs.size > MAX_NUMBERS) registeredAs.clear();
  let asked = false;
  for (const firm of firms) {
    if (registeredAs.has(firm.code)) continue;
    if (asked) await new Promise(resolve => setTimeout(resolve, GLEIF_SPACING_MS));
    asked = true;
    const iso = ENG_COUNTRIES.find(item => item.value === firm.country)?.iso2 ?? '';
    try {
      registeredAs.set(firm.code, await readHeEngGleifRegisteredAsByName(firm.name, iso, { ...options, maxBytes: 512 * 1024, timeoutMs: 15_000 }));
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return;
    }
  }
}

function candidate(firm: Institution): HeEngRegistryCandidate {
  const kinds = [...firm.types].sort().map(type => TYPE_LABELS[type]);
  const number = registeredAs.get(firm.code);
  return { provider: 'eba', recordId: firm.code, company: firm.name, country: firm.country, address: firm.address, addressKind: 'business',
    category: `EBA ${kinds.join(' and ')}`, ...(number ? { localRegistryId: number } : {}),
    ...(/[A-Za-z0-9]{4,}/.test(firm.reference) ? { supervisorReference: firm.reference } : {}),
    website: '', emails: [],
    description: str(`${/^[aeiou]/.test(kinds[0]) ? 'An' : 'A'} ${kinds.join(' and ')}${firm.brands.length ? ` trading as ${firm.brands.join(', ')},` : ''} authorised under PSD2 by ${firm.supervisor.replace(/_/g, ' ') || 'its national supervisor'}${firm.reference ? ` (reference ${firm.reference})` : ''}. From the EBA register of payment and electronic money institutions; head office address from the register. Website, employee count and services require verification.`, 1500),
    sourceUrl: `${EBA_RECORD}${firm.codeType}/${firm.code}` };
}

/** One 25-firm page of an EBA slice; the caller validates the task and the position. */
export async function readHeEngEbaRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'eba' || task.country !== 'global') fail('registry_invalid_task');
  const firms = await institutions(task, options);
  const page = firms.slice(position, position + PAGE_SIZE);
  await readRegisteredAs(page, options);
  return { candidates: page.map(candidate), nextPosition: position + PAGE_SIZE,
    exhausted: position + page.length >= firms.length, excluded: {}, recordsRead: page.length };
}
