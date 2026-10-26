import { isIP } from 'node:net';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { ENG_COUNTRIES } from './engCountries';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryTask } from './engPublicRegistryTypes';
import { readHeEngRegistryText } from './engRegistryHttp';

/**
 * Wikidata (keyless, CC0) through the QLever SPARQL endpoint: organisations of
 * a sector in any country, with their official website and, for some (about
 * one in twenty-five), a dated employee count. Mostly larger and well-known
 * companies; the website comes with the record, so no paid site search is
 * needed. A sector is a closed list of Wikidata classes (instance of) and
 * industries. The country is a headquarters country, the one that is also the
 * organisation's own when it has several (Freshfields: London and a Frankfurt
 * tower), otherwise its own country. A slice reads its countries whole in one
 * query, largest first (by employees, then by Wikipedia articles), 25 a page.
 */
const ENDPOINT = 'https://qlever.dev/api/wikidata';
const PAGE_SIZE = 25;
const MAX_BYTES = 32 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;
const CACHE_MS = 6 * 60 * 60_000;
const MAX_CACHED_SLICES = 16;
const MAX_ROWS = 60_000;

interface Vocabulary { types: readonly string[]; industries: readonly string[]; health?: boolean }
/** Wikidata classes («instance of») and industries per sector, checked against live counts in October 2026. */
export const HE_ENG_WIKIDATA_SECTORS: Readonly<Record<string, Vocabulary>> = {
  // Not «information technology» (Q11661): it also tags Uber, Yelp, drone and chemical makers.
  software: { types: ['Q1058914'], industries: ['Q880371', 'Q638608', 'Q1254596', 'Q1540863', 'Q483639', 'Q112165968', 'Q110702998',
    'Q386275', 'Q1481411', 'Q112165970', 'Q112165934', 'Q1318054', 'Q1654942'] },
  banks: { types: ['Q22687', 'Q3277997', 'Q13601825', 'Q848507', 'Q745877', 'Q157963', 'Q2111088', 'Q568041', 'Q1553482', 'Q7309198', 'Q116763871'],
    industries: ['Q806718', 'Q22687', 'Q3435731', 'Q319845', 'Q96107414', 'Q941185', 'Q11833245', 'Q1548025', 'Q96107484'] },
  asset_management: { types: ['Q4230006', 'Q1752459', 'Q2563546', 'Q5418962', 'Q3487908'],
    industries: ['Q14864997', 'Q873442', 'Q112166021', 'Q14947471', 'Q476115', 'Q219409', 'Q105611', 'Q1752459'] },
  insurance: { types: ['Q2143354', 'Q695318', 'Q563787'],
    industries: ['Q43183', 'Q2518196', 'Q626608', 'Q334911', 'Q1068361', 'Q29585701', 'Q476118', 'Q2663825', 'Q2143354'] },
  insurance_brokers: { types: ['Q285759', 'Q27038992'], industries: ['Q58037976'] },
  hospitals: { types: ['Q16917', 'Q7257872', 'Q1059324', 'Q1774587', 'Q4284971', 'Q210999', 'Q2440002', 'Q644264', 'Q89371670', 'Q1813474', 'Q7048982'],
    industries: ['Q130370834', 'Q112166139', 'Q16917', 'Q112122809', 'Q29584854'], health: true },
  clinics: { types: ['Q1774898', 'Q23905463', 'Q695416'], industries: ['Q7900484'], health: true },
  dental: { types: ['Q2979300', 'Q111744778'], industries: ['Q12128'], health: true },
  laboratories: { types: ['Q2296168'], industries: [], health: true },
  veterinary: { types: ['Q1706476'], industries: ['Q170201'], health: true },
  trucking: { types: ['Q1468664', 'Q840850', 'Q83698915', 'Q57616098'],
    industries: ['Q177777', 'Q651658', 'Q516739', 'Q57615173', 'Q29585624', 'Q83698112', 'Q57616098', 'Q840850'] },
  construction: { types: ['Q811930'], industries: ['Q385378', 'Q13405640', 'Q3875186', 'Q112122737', 'Q2349677', 'Q29585433', 'Q811930'] },
  hotels: { types: ['Q27686', 'Q1631129', 'Q115040846', 'Q2880255'], industries: ['Q1285245', 'Q27686', 'Q1631129', 'Q112122766', 'Q1495452'] },
  machinery: { types: [], industries: ['Q101333', 'Q1957908', 'Q107597925', 'Q13747706', 'Q12088781', 'Q3045515'] },
  law_firms: { types: ['Q613142'], industries: ['Q1494322', 'Q613142', 'Q112122785', 'Q220117'] },
  accounting: { types: ['Q2781630'], industries: ['Q4116214', 'Q10757701', 'Q181487'] },
  real_estate_agencies: { types: ['Q21662626', 'Q16148831'], industries: ['Q519076', 'Q113652623', 'Q1618728', 'Q58081477'] },
  architects: { types: ['Q4387609', 'Q98446764'], industries: ['Q12271', 'Q4387609', 'Q12079357', 'Q47844'] },
  engineering: { types: ['Q921773'], industries: ['Q11023', 'Q77590', 'Q43035', 'Q4986607', 'Q20612431', 'Q150737'] },
  travel_agencies: { types: ['Q217107', 'Q133744', 'Q118710708', 'Q135409668'], industries: ['Q217107', 'Q133744', 'Q118710708', 'Q1423777'] },
  recruitment: { types: ['Q261362', 'Q17175443', 'Q59545', 'Q63349565'],
    industries: ['Q899277', 'Q1227658', 'Q261362', 'Q131766571', 'Q1783605', 'Q29584814'] },
  marketing_agencies: { types: ['Q216931', 'Q9592701', 'Q12043474', 'Q1369723'], industries: ['Q216931', 'Q112166060', 'Q23700481', 'Q133080', 'Q1323528'] },
  pharmacies: { types: ['Q61676930', 'Q90298865'], industries: ['Q614304', 'Q1260046'] },
  restaurants: { types: ['Q18534542', 'Q18509232'], industries: ['Q104714944', 'Q1442415', 'Q2898326'] },
  fitness: { types: ['Q76223357', 'Q1065656'], industries: ['Q112166133', 'Q59677291'] },
  car_dealers: { types: ['Q786803'], industries: ['Q786803'] },
};
// Never buyers here: people, universities, research institutes, government and
// political bodies, international organisations; outside health also
// foundations, non-profits and associations.
const EXCLUDED = ['Q5', 'Q3918', 'Q875538', 'Q902104', 'Q31855', 'Q1664720', 'Q2659904', 'Q327333', 'Q484652', 'Q7210356'];
const EXCLUDED_OUTSIDE_HEALTH = ['Q157031', 'Q163740', 'Q15911314'];

interface Options { signal?: AbortSignal; fetch?: typeof fetch; now?: () => number }
interface Organisation { id: string; name: string; country: string; hq: string; website: string; employees: number | null; year: number | null; links: number }
interface Seat { iso: string; name: string }
type Binding = Record<string, { value?: unknown } | undefined>;

function fail(code: string): never { throw new Error(code); }
function str(raw: unknown, max = 300): string {
  return typeof raw === 'string'
    ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function value(row: Binding, key: string, max = 300): string { return str(row[key]?.value, max); }
function website(raw: string): string {
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port || !host.includes('.') || isIP(host)) return '';
    return url.origin;
  } catch { return ''; }
}

function query(vocabulary: Vocabulary, iso: readonly string[]): string {
  const ids = (list: readonly string[]) => list.map(id => `wd:${id}`).join(' ');
  const excluded = vocabulary.health ? EXCLUDED : [...EXCLUDED, ...EXCLUDED_OUTSIDE_HEALTH];
  const match = [vocabulary.types.length ? `{ VALUES ?type { ${ids(vocabulary.types)} } ?item wdt:P31 ?type }` : '',
    vocabulary.industries.length ? `{ VALUES ?industry { ${ids(vocabulary.industries)} } ?item wdt:P452 ?industry }` : ''].filter(Boolean).join(' UNION ');
  return [
    'PREFIX wd: <http://www.wikidata.org/entity/>', 'PREFIX wdt: <http://www.wikidata.org/prop/direct/>',
    'PREFIX p: <http://www.wikidata.org/prop/>', 'PREFIX ps: <http://www.wikidata.org/prop/statement/>',
    'PREFIX pq: <http://www.wikidata.org/prop/qualifier/>', 'PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>',
    'PREFIX wikibase: <http://wikiba.se/ontology#>',
    'SELECT ?item (SAMPLE(?en) AS ?name) (SAMPLE(?official) AS ?legal) (MIN(STR(?site)) AS ?web)',
    '  (MAX(?links) AS ?sitelinks) (GROUP_CONCAT(DISTINCT ?ownIso; SEPARATOR=" ") AS ?own)',
    '  (GROUP_CONCAT(DISTINCT CONCAT(?hqIso, "|", COALESCE(?hqName, "")); SEPARATOR=";") AS ?seats)',
    '  (GROUP_CONCAT(DISTINCT CONCAT(COALESCE(STR(?when), ""), "|", STR(?staff)); SEPARATOR=";") AS ?employees) WHERE {',
    `  VALUES ?iso { ${iso.map(code => `"${code}"`).join(' ')} }`,
    '  ?country wdt:P297 ?iso .',
    '  { ?item wdt:P17 ?country } UNION { ?item wdt:P159 ?seat . ?seat wdt:P17 ?country }',
    `  ${match}`,
    '  ?item wdt:P856 ?site .',
    '  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved }',
    `  FILTER NOT EXISTS { VALUES ?excluded { ${ids(excluded)} } ?item wdt:P31 ?excluded }`,
    '  OPTIONAL { ?item wdt:P17 ?ownCountry . ?ownCountry wdt:P297 ?ownIso }',
    '  OPTIONAL { ?item wdt:P159 ?hqPlace . ?hqPlace wdt:P17 ?hqCountry . ?hqCountry wdt:P297 ?hqIso .',
    '    OPTIONAL { ?hqPlace rdfs:label ?hqName FILTER(LANG(?hqName) = "en") } }',
    '  OPTIONAL { ?item rdfs:label ?en FILTER(LANG(?en) = "en") }',
    '  OPTIONAL { ?item wdt:P1448 ?official }',
    '  OPTIONAL { ?item wikibase:sitelinks ?links }',
    '  OPTIONAL { ?item p:P1128 ?statement . ?statement ps:P1128 ?staff . OPTIONAL { ?statement pq:P585 ?when } }',
    '} GROUP BY ?item',
  ].join('\n');
}

/**
 * The slice country of an organisation and its headquarters' name: a
 * headquarters country that is also its own, else any headquarters country,
 * else (no headquarters known) its own country. A headquarters abroad keeps
 * it out of the slice: a London holding of a Moscow company is not British.
 */
function home(iso: readonly string[], own: readonly string[], seats: readonly Seat[]): Seat | null {
  if (seats.length) {
    return iso.map(code => seats.find(seat => seat.iso === code && own.includes(code))).find(Boolean)
      ?? iso.map(code => seats.find(seat => seat.iso === code)).find(Boolean) ?? null;
  }
  const code = iso.find(item => own.includes(item));
  return code ? { iso: code, name: '' } : null;
}

/** The latest dated employee count; without dates, the largest. */
function headcount(raw: string): { employees: number | null; year: number | null } {
  let best: { at: string; employees: number } | null = null;
  for (const entry of raw.split(';')) {
    const [at, count] = entry.split('|');
    const employees = Number(count);
    if (!Number.isFinite(employees) || employees < 1 || employees > 5_000_000) continue;
    const when = /^\d{4}-\d{2}-\d{2}/.test(at ?? '') ? at!.slice(0, 10) : '';
    if (!best || when > best.at || (when === best.at && employees > best.employees)) best = { at: when, employees: Math.round(employees) };
  }
  return { employees: best?.employees ?? null, year: best?.at ? Number(best.at.slice(0, 4)) : null };
}

const cache = new Map<string, { at: number; organisations: Organisation[] }>();
async function organisations(task: HeEngRegistryTask, options: Options): Promise<Organisation[]> {
  const vocabulary = HE_ENG_WIKIDATA_SECTORS[task.category];
  const allowed = task.countries ?? [];
  const iso = allowed.map(country => (ENG_COUNTRIES.find(item => item.value === country)?.iso2 ?? '').toUpperCase());
  if (!vocabulary || !iso.length || iso.some(code => !/^[A-Z]{2}$/.test(code))) fail('registry_invalid_task');
  const key = `${task.category}:${allowed.join(',')}`;
  const now = (options.now ?? Date.now)();
  for (const [cached, entry] of cache) if (now - entry.at >= CACHE_MS) cache.delete(cached);
  const hit = cache.get(key);
  if (hit) return hit.organisations;
  const url = new URL(ENDPOINT);
  url.searchParams.set('query', query(vocabulary, iso));
  let body: { results?: { bindings?: unknown } };
  try { body = JSON.parse(await readHeEngRegistryText(url.href, { ...options, accept: 'application/sparql-results+json', maxBytes: MAX_BYTES, timeoutMs: REQUEST_TIMEOUT_MS })); }
  catch (error) { if (error instanceof SyntaxError) fail('registry_invalid_response'); throw error; }
  const rows = body?.results?.bindings;
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) fail('registry_invalid_response');
  const found: Organisation[] = [];
  for (const row of rows as Binding[]) {
    const id = value(row, 'item').replace('http://www.wikidata.org/entity/', '');
    const name = value(row, 'name') || value(row, 'legal');
    const site = website(value(row, 'web', 2048));
    const seats = value(row, 'seats', 5000).split(';').map(entry => entry.split('|'))
      .filter(([code]) => /^[A-Z]{2}$/.test(code ?? '')).map(([code, place]) => ({ iso: code, name: str(place, 120) }));
    const seat = home(iso, value(row, 'own').split(' ').filter(Boolean), seats);
    if (!/^Q[1-9]\d{0,11}$/.test(id) || !name || !site || !seat) continue;
    const { employees, year } = headcount(value(row, 'employees', 20_000));
    const links = Number(value(row, 'sitelinks'));
    found.push({ id, name, country: allowed[iso.indexOf(seat.iso)], hq: seat.name, website: site, employees, year,
      links: Number.isFinite(links) ? links : 0 });
  }
  found.sort((a, b) => (b.employees ?? -1) - (a.employees ?? -1) || b.links - a.links || Number(a.id.slice(1)) - Number(b.id.slice(1)));
  if (cache.size >= MAX_CACHED_SLICES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { at: now, organisations: found });
  return found;
}

/** A known headcount outside the slice's range is skipped; without one the company stays, after the counted ones. */
function withinRange(organisation: Organisation, task: HeEngRegistryTask): boolean {
  if (organisation.employees === null) return true;
  return organisation.employees >= (task.minEmployees ?? 0) && (task.maxEmployees === undefined || organisation.employees <= task.maxEmployees);
}

function candidate(organisation: Organisation, sector: string): HeEngRegistryCandidate {
  const country = ENG_COUNTRIES.find(item => item.value === organisation.country)?.label ?? organisation.country;
  const address = [organisation.hq, country].filter(Boolean).join(', ');
  return { provider: 'wikidata', recordId: organisation.id, company: organisation.name, country: organisation.country,
    address: address.length >= 5 ? address : `${country} (country)`, addressKind: 'business', category: `Wikidata ${sector.replace(/_/g, ' ')}`,
    ...(organisation.employees !== null ? { employees: String(organisation.employees) } : {}),
    ...(organisation.year !== null && organisation.year >= 1900 && organisation.year <= 2100 ? { employeeYear: organisation.year } : {}),
    website: organisation.website, emails: [],
    description: str(`An organisation listed in Wikidata (${sector.replace(/_/g, ' ')})${organisation.hq ? `, headquartered in ${organisation.hq}` : ''}${organisation.employees !== null ? `, ${organisation.employees} employees${organisation.year ? ` (${organisation.year})` : ''}` : ''}. Official website from Wikidata; current employee count and services require verification.`, 1500),
    sourceUrl: `https://www.wikidata.org/wiki/${organisation.id}` };
}

/** One 25-organisation page of a Wikidata slice; the caller validates the task and the position. */
export async function readHeEngWikidataRegistryPage(task: HeEngRegistryTask, position: number, options: Options = {}): Promise<HeEngRegistryPage> {
  if (task.provider !== 'wikidata' || task.country !== 'global') fail('registry_invalid_task');
  const list = (await organisations(task, options)).filter(organisation => withinRange(organisation, task));
  const page = list.slice(position, position + PAGE_SIZE);
  return { candidates: page.map(organisation => candidate(organisation, task.category)), nextPosition: position + PAGE_SIZE,
    exhausted: position + page.length >= list.length, excluded: {}, recordsRead: page.length };
}
