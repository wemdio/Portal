import { isIP } from 'node:net';
import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { normalizeEngCountry } from './engCountries';
import { validateHeEngRegistryTask } from './engPublicRegistryPlan';
import type { HeEngRegistryCandidate, HeEngRegistryPage, HeEngRegistryProvider, HeEngRegistryTask } from './engPublicRegistryTypes';

const PAGE_SIZE = 25;
const MAX_BYTES = 3 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 25_000;
// Official Brreg legal entities, partnerships and registered foreign branches.
// ENK/PERS (individuals), associations and bare fund vehicles are not included.
// Helseforetak use SÆR; there is no HF organisation-form code in this API.
const BRREG_COMPANY_FORMS = ['AS', 'ASA', 'ANS', 'DA', 'BA', 'SA', 'SE', 'SF', 'SPA', 'GFS', 'IKS', 'KS', 'SÆR', 'NUF'] as const;
const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '));
const ENDPOINTS: Readonly<Record<HeEngRegistryProvider, string>> = {
  brreg: 'https://data.brreg.no/enhetsregisteret/api/enheter',
  france: 'https://recherche-entreprises.api.gouv.fr/search',
  fdic: 'https://banks.data.fdic.gov/api/institutions',
  nppes: 'https://npiregistry.cms.hhs.gov/api/',
  fmcsa: 'https://data.transportation.gov/resource/az4n-8mr2.json',
  companies_house: 'https://api.company-information.service.gov.uk/advanced-search/companies',
};
type Row = Record<string, unknown>;
function object(raw: unknown): Row | null { return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw as Row : null; }
function str(raw: unknown, max = 500): string {
  return typeof raw === 'string'
    ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max)
    : '';
}
function integer(raw: unknown): number | null {
  if (typeof raw !== 'number' && (typeof raw !== 'string' || !/^\d+$/.test(raw))) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function joined(values: unknown[]): string { return sliceWholeChars(values.map(value => str(value)).filter(Boolean).join(', '), 0, 1500); }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function fail(code: string): never { throw new Error(code); }
function httpFailure(status: number, retryAfter: string | null): never {
  const error = new Error(`registry_http_${status}`) as Error & { retryAfterMs?: number };
  if ((status === 408 || status === 429 || status >= 500) && retryAfter?.trim()) {
    const value = retryAfter.trim();
    // A numeric-looking malformed delay is not an HTTP date (Date.parse accepts
    // values such as "1.5"). Accept the HTTP date family only after a weekday.
    const delay = /^\d+$/.test(value) ? Number(value) * 1000
      : /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)/i.test(value) ? Date.parse(value) - Date.now() : NaN;
    if (delay > 24 * 60 * 60 * 1000) fail('registry_retry_after_too_long');
    if (Number.isFinite(delay)) error.retryAfterMs = Math.max(0, Math.ceil(delay));
  }
  throw error;
}
function exclude(counts: Record<string, number>, reason: string): null { counts[reason] = (counts[reason] ?? 0) + 1; return null; }
function website(raw: unknown): string {
  const value = str(raw, 2048);
  if (!value) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !host.includes('.') || isIP(host.replace(/^\[|\]$/g, '')) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)) return '';
    return url.origin;
  } catch { return ''; }
}
function emails(raw: unknown): string[] {
  // Source addresses stay unvalidated; the normal validator decides OK/catch-all.
  const values = typeof raw === 'string' ? raw.split(/[;,\s]+/) : list(raw);
  return [...new Set(values.map(value => str(value, 254).toLowerCase()).filter(value =>
    /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(value)))].slice(0, 5);
}
function withinRange(value: number | null, task: HeEngRegistryTask): boolean {
  return value === null || ((task.minEmployees === undefined || value >= task.minEmployees) &&
    (task.maxEmployees === undefined || value <= task.maxEmployees));
}
const FR_BANDS: Readonly<Record<string, readonly [number, number | null]>> = {
  '00': [0, 0], '01': [1, 2], '02': [3, 5], '03': [6, 9], '11': [10, 19], '12': [20, 49],
  '21': [50, 99], '22': [100, 199], '31': [200, 249], '32': [250, 499], '41': [500, 999],
  '42': [1000, 1999], '51': [2000, 4999], '52': [5000, 9999], '53': [10000, null],
};
function matchingFranceBands(task: HeEngRegistryTask): string[] {
  return Object.keys(FR_BANDS).filter(code => {
    const [min, max] = FR_BANDS[code];
    return (max === null || max >= (task.minEmployees ?? 0)) && (task.maxEmployees === undefined || min <= task.maxEmployees);
  });
}

function request(task: HeEngRegistryTask, position: number): { url: URL; headers: Record<string, string> } {
  const url = new URL(ENDPOINTS[task.provider]);
  const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': 'Portal ENG public-company-discovery/1.0 (+https://app.outreachos.xyz)' };
  const q = url.searchParams;
  switch (task.provider) {
    case 'brreg':
      q.set('naeringskode', task.category); q.set('organisasjonsform', BRREG_COMPANY_FORMS.join(',')); q.set('konkurs', 'false');
      q.set('forretningsadresse.landkode', 'NO'); q.set('size', String(PAGE_SIZE)); q.set('page', String(position / PAGE_SIZE));
      q.set('sort', 'organisasjonsnummer,ASC');
      // Brreg suppresses exact headcounts 1–4. Query overlapping bounds and retain
      // the unknown status; never substitute a requested size for the real one.
      if (task.minEmployees !== undefined) q.set('fraAntallAnsatte', String(task.minEmployees > 1 && task.minEmployees < 5 ? 1 : task.minEmployees));
      if (task.maxEmployees !== undefined) q.set('tilAntallAnsatte', String(task.maxEmployees > 0 && task.maxEmployees < 4 ? 4 : task.maxEmployees));
      break;
    case 'france':
      q.set('activite_principale', task.category); q.set('etat_administratif', 'A'); q.set('est_entrepreneur_individuel', 'false');
      q.set('per_page', String(PAGE_SIZE)); q.set('page', String(position / PAGE_SIZE + 1));
      q.set('minimal', 'true'); q.set('include', 'siege,complements');
      if (task.minEmployees !== undefined || task.maxEmployees !== undefined) q.set('tranche_effectif_salarie', matchingFranceBands(task).join(','));
      break;
    case 'fdic':
      q.set('filters', 'ACTIVE:1'); q.set('fields', 'CERT,NAME,ACTIVE,ADDRESS,CITY,STALP,ZIP,WEBADDR');
      q.set('limit', String(PAGE_SIZE)); q.set('offset', String(position)); q.set('sort_by', 'CERT'); q.set('sort_order', 'ASC');
      break;
    case 'nppes':
      q.set('version', '2.1'); q.set('enumeration_type', 'NPI-2'); q.set('taxonomy_description', task.category); q.set('country_code', 'US');
      q.set('limit', String(PAGE_SIZE)); q.set('skip', String(position));
      break;
    case 'fmcsa':
      // The source columns, including power_units, are TEXT, not numbers.
      q.set('$where', "status_code='A' AND phy_country='US' AND business_org_desc in('CORPORATION','PARTNERSHIP') AND power_units != '0' AND classdef like '%FOR HIRE%'");
      q.set('$select', 'dot_number,legal_name,dba_name,phy_country,phy_state,phy_city,phy_street,phy_zip,status_code,business_org_desc,classdef,power_units,carship,email_address');
      q.set('$limit', String(PAGE_SIZE)); q.set('$offset', String(position)); q.set('$order', 'dot_number ASC');
      break;
    case 'companies_house': {
      const key = (process.env.COMPANIES_HOUSE_API_KEY ?? '').trim();
      if (!key) fail('registry_key_missing');
      headers.Authorization = `Basic ${Buffer.from(`${key}:`).toString('base64')}`;
      q.set('sic_codes', task.category); q.set('company_status', 'active'); q.set('size', String(PAGE_SIZE)); q.set('start_index', String(position));
      break;
    }
  }
  return { url, headers };
}

async function jsonResponse(task: HeEngRegistryTask, position: number, options: { signal?: AbortSignal; fetch?: typeof fetch }): Promise<unknown> {
  const { url, headers } = request(task, position);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) fail('registry_aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // No redirects, provider-returned URLs, user-controlled hosts or paid fallback.
    const response = await (options.fetch ?? fetch)(url, { method: 'GET', headers, redirect: 'error', signal: controller.signal });
    if (response.status === 404 && task.provider === 'companies_house') return { items: [], hits: 0 };
    if (!response.ok) httpFailure(response.status, response.headers.get('retry-after'));
    const declared = integer(response.headers.get('content-length'));
    if (declared !== null && declared > MAX_BYTES) fail('registry_response_too_large');
    if (!response.body) fail('registry_invalid_response');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) { await reader.cancel(); fail('registry_response_too_large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
    catch { return fail('registry_invalid_response'); }
  } catch (error) {
    if (options.signal?.aborted) return fail('registry_aborted');
    if (controller.signal.aborted) return fail('registry_timeout');
    if (error instanceof Error && /^registry_[a-z0-9_]+$/.test(error.message)) throw error;
    return fail('registry_network_error');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}

function brreg(row: Row, task: HeEngRegistryTask, excluded: Record<string, number>): HeEngRegistryCandidate | null {
  const recordId = str(row.organisasjonsnummer); const company = str(row.navn);
  if (!/^\d{9}$/.test(recordId) || !company) return exclude(excluded, 'missing_identity');
  const form = str(object(row.organisasjonsform)?.kode);
  if (!(BRREG_COMPANY_FORMS as readonly string[]).includes(form)) return exclude(excluded, 'not_company');
  if (form === 'NUF') {
    // NUF also covers foreign sole proprietors. Only explicit home-country legal
    // form evidence admits a corporate branch; a company-looking name is not it.
    const home = object(row.foretaksformIHjemlandet);
    const homeDescription = joined([home?.beskrivelseBokmaal, home?.beskrivelse]).toLowerCase();
    const homeCode = str(home?.kode).toUpperCase().replace(/[.\s/]/g, '');
    if (/enkeltperson|sole (?:propriet|trad)|individual|einzelunternehmen/i.test(homeDescription)) return exclude(excluded, 'not_company');
    if (!['AS', 'ASA', 'AB', 'OY', 'OYJ', 'LTD', 'LIMITED', 'PLC', 'LLC', 'INC', 'GMBH', 'AG', 'SA', 'SAS', 'SARL', 'BV', 'NV', 'APS'].includes(homeCode) &&
      !/(?:aksjeselskap|aktiebolag|limited (?:liability|company)|selskap med begrenset ansvar|allmennaksjeselskap)/i.test(homeDescription)) {
      return exclude(excluded, 'organization_form_unconfirmed');
    }
  }
  if (row.konkurs !== false || row.underAvvikling === true || row.underTvangsavviklingEllerTvangsopplosning === true || row.slettedato) return exclude(excluded, 'inactive');
  const address = object(row.forretningsadresse);
  if (str(address?.landkode) !== 'NO' || !str(address?.poststed) || !str(address?.postnummer)) return exclude(excluded, 'country_unconfirmed');
  const activity = [row.naeringskode1, row.naeringskode2, row.naeringskode3].map(object).filter((item): item is Row => item !== null);
  if (!activity.some(item => str(item.kode).startsWith(task.category))) return exclude(excluded, 'category_mismatch');
  const count = row.harRegistrertAntallAnsatte === true ? integer(row.antallAnsatte) : null;
  if (!withinRange(count, task)) return exclude(excluded, 'employee_range');
  const description = joined(activity.map(item => joined([item.kode, item.beskrivelse])));
  return { provider: task.provider, recordId, company, country: 'norway', address: joined([...list(address?.adresse), address?.postnummer, address?.poststed, 'Norway']),
    addressKind: 'business', category: description,
    ...(count !== null ? { employees: String(count) } : {}),
    website: website(row.hjemmeside), emails: emails(row.epostadresse),
    description: joined([description, ...list(row.aktivitet).slice(0, 5), ...list(row.vedtektsfestetFormaal).slice(0, 3)]),
    sourceUrl: `https://data.brreg.no/enhetsregisteret/api/enheter/${recordId}` };
}

function france(row: Row, task: HeEngRegistryTask, excluded: Record<string, number>): HeEngRegistryCandidate | null {
  const recordId = str(row.siren); const company = str(row.nom_raison_sociale) || str(row.nom_complet); const address = object(row.siege);
  if (!/^\d{9}$/.test(recordId) || !company) return exclude(excluded, 'missing_identity');
  const complements = object(row.complements);
  if (row.statut_diffusion !== 'O' || address?.statut_diffusion_etablissement !== 'O' ||
    row.diffusion_commerciale === false || row.diffusionCommerciale === false || row.opposition_prospection === true) return exclude(excluded, 'restricted_reuse');
  const legal = str(row.nature_juridique);
  if (!legal || legal.startsWith('1') || complements?.est_entrepreneur_individuel === true) return exclude(excluded, 'not_company');
  if (row.etat_administratif !== 'A' || address?.etat_administratif !== 'A') return exclude(excluded, 'inactive');
  // SIRENE also contains foreign companies. A domestic commune and postal code
  // must come from the returned establishment; requested France is not evidence.
  if (str(address?.code_pays_etranger) || str(address?.libelle_pays_etranger) || str(address?.libelle_commune_etranger) ||
    !/^(?:\d{5}|2[AB]\d{3})$/.test(str(address?.commune)) || !/^\d{5}$/.test(str(address?.code_postal)) ||
    !str(address?.libelle_commune) || !str(address?.adresse)) return exclude(excluded, 'country_unconfirmed');
  // Overseas territories have separate country scope in ENG.
  if (/^9[78]/.test(str(address?.code_postal))) return exclude(excluded, 'country_unconfirmed');
  if (str(row.activite_principale) !== task.category) return exclude(excluded, 'category_mismatch');
  const bandCode = str(row.tranche_effectif_salarie); const band = FR_BANDS[bandCode];
  if (band && !matchingFranceBands(task).includes(bandCode)) return exclude(excluded, 'employee_range');
  const year = integer(row.annee_tranche_effectif_salarie);
  return { provider: task.provider, recordId, company, country: 'france', address: str(address.adresse, 1500), addressKind: 'registered',
    category: `NAF ${task.category}`, ...(band ? { employees: band[1] === null ? `${band[0]}+` : `${band[0]}-${band[1]}` } : {}),
    ...(year !== null && year >= 1900 && year <= 2100 ? { employeeYear: year } : {}), website: '', emails: [],
    description: `Active French legal entity; NAF ${str(row.activite_principale)}. Employee band is historical${year !== null ? ` (${year})` : ''}; registered headquarters address.`,
    sourceUrl: `https://annuaire-entreprises.data.gouv.fr/entreprise/${recordId}` };
}

function fdic(row: Row, task: HeEngRegistryTask, excluded: Record<string, number>): HeEngRegistryCandidate | null {
  const data = object(row.data);
  if (!data) return exclude(excluded, 'invalid_record');
  const cert = integer(data.CERT); const company = str(data.NAME);
  if (cert === null || cert < 1 || !company) return exclude(excluded, 'missing_identity');
  if (integer(data.ACTIVE) !== 1) return exclude(excluded, 'inactive');
  if (!US_STATES.has(str(data.STALP)) || !str(data.CITY) || !str(data.ADDRESS) || !/^\d{5}(?:-\d{4})?$/.test(str(data.ZIP))) return exclude(excluded, 'country_unconfirmed');
  return { provider: task.provider, recordId: String(cert), company, country: 'united states',
    address: joined([data.ADDRESS, data.CITY, data.STALP, data.ZIP, 'United States']), addressKind: 'business',
    category: 'FDIC insured bank', website: website(data.WEBADDR), emails: [],
    description: 'Active FDIC insured banking institution. Specific services require verification on the institution website.',
    sourceUrl: `https://banks.data.fdic.gov/bankfind-suite/bankfind/details/${cert}` };
}

const NPI_CODES: Readonly<Record<string, RegExp>> = {
  Dentist: /^1223/, 'Clinic/Center': /^261Q/, 'General Acute Care Hospital': /^282N/, 'Clinical Medical Laboratory': /^291U/,
};
function nppes(row: Row, task: HeEngRegistryTask, excluded: Record<string, number>): HeEngRegistryCandidate | null {
  const basic = object(row.basic); const recordId = typeof row.number === 'number' ? String(row.number) : str(row.number); const company = str(basic?.organization_name);
  if (!/^\d{10}$/.test(recordId) || !company) return exclude(excluded, 'missing_identity');
  if (row.enumeration_type !== 'NPI-2') return exclude(excluded, 'not_company');
  if (basic?.status !== 'A') return exclude(excluded, 'inactive');
  const address = list(row.addresses).map(object).find(item => item?.address_purpose === 'LOCATION' && item.country_code === 'US');
  if (!address || !US_STATES.has(str(address.state)) || !str(address.city) || !str(address.address_1)) return exclude(excluded, 'country_unconfirmed');
  const taxonomies = list(row.taxonomies).map(object).filter((item): item is Row => item !== null);
  if (!taxonomies.some(item => NPI_CODES[task.category]?.test(str(item.code)))) return exclude(excluded, 'category_mismatch');
  return { provider: task.provider, recordId, company, country: 'united states',
    address: joined([address.address_1, address.address_2, address.city, address.state, address.postal_code, 'United States']), addressKind: 'business',
    category: joined(taxonomies.map(item => item.desc)), website: '', emails: [],
    description: `Active NPI-2 healthcare organization; ${joined(taxonomies.map(item => item.desc))}. NPI registration is not an endorsement or licence verification.`,
    sourceUrl: `https://npiregistry.cms.hhs.gov/provider-view/${recordId}` };
}

function fmcsa(row: Row, task: HeEngRegistryTask, excluded: Record<string, number>): HeEngRegistryCandidate | null {
  const recordId = str(row.dot_number); const company = str(row.legal_name);
  if (!/^\d{1,9}$/.test(recordId) || !company) return exclude(excluded, 'missing_identity');
  if (!['CORPORATION', 'PARTNERSHIP'].includes(str(row.business_org_desc))) return exclude(excluded, 'not_company');
  if (row.status_code !== 'A') return exclude(excluded, 'inactive');
  if (row.phy_country !== 'US' || !US_STATES.has(str(row.phy_state)) || !str(row.phy_city) || !str(row.phy_street)) return exclude(excluded, 'country_unconfirmed');
  const fleet = integer(row.power_units);
  if (fleet === null || fleet === 0 || !str(row.carship).split(';').includes('C') || !/FOR HIRE/.test(str(row.classdef))) return exclude(excluded, 'category_mismatch');
  return { provider: task.provider, recordId, company, country: 'united states',
    address: joined([row.phy_street, row.phy_city, row.phy_state, row.phy_zip, 'United States']), addressKind: 'business',
    category: str(row.classdef), website: '', emails: emails(row.email_address),
    // Vehicle and driver counts must never masquerade as employee count.
    description: `Active FMCSA carrier; ${str(row.classdef)}; ${fleet} reported power units. Specific cargo and services require verification.`,
    sourceUrl: `https://safer.fmcsa.dot.gov/query.asp?query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${recordId}` };
}

export function mapHeEngCompaniesHouseRecord(row: Row, task: HeEngRegistryTask, excluded: Record<string, number>): HeEngRegistryCandidate | null {
  const recordId = str(row.company_number); const company = str(row.company_name); const address = object(row.registered_office_address);
  if (!/^[A-Z0-9]{8}$/.test(recordId) || !company) return exclude(excluded, 'missing_identity');
  if (row.company_status !== 'active') return exclude(excluded, 'inactive');
  const country = str(address?.country);
  const domesticCountry = !country || normalizeEngCountry(country) === 'united kingdom';
  if (!domesticCountry || !str(address?.locality) || !str(address?.address_line_1) ||
    !/^(?:GIR 0AA|[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2})$/i.test(str(address?.postal_code))) return exclude(excluded, 'country_unconfirmed');
  if (!list(row.sic_codes).includes(task.category)) return exclude(excluded, 'category_mismatch');
  return { provider: task.provider, recordId, company, country: 'united kingdom',
    address: joined([address?.premises, address?.address_line_1, address?.address_line_2, address?.locality, address?.postal_code, country]),
    addressKind: 'registered', category: `SIC ${task.category}`, website: '', emails: [],
    description: `Active UK registered company; SIC ${task.category}. Country comes from the registry address, which may be an agent address and does not establish an operating office. Website identity, employee count and relevant services require verification.`,
    sourceUrl: `https://find-and-update.company-information.service.gov.uk/company/${recordId}` };
}

/** One bounded public page. The caller checkpoints only completed pages and caps total pages. */
export async function readHeEngRegistryPage(task: HeEngRegistryTask, position: number,
  options: { signal?: AbortSignal; fetch?: typeof fetch } = {}): Promise<HeEngRegistryPage> {
  validateHeEngRegistryTask(task);
  if (!Number.isSafeInteger(position) || position < 0 || position % PAGE_SIZE !== 0) fail('registry_invalid_position');
  // CMS permits skip=1000 inclusive; with our 25-row pages the next offset is
  // 1025, which must fail rather than repeat the provider's last page.
  const maxOffset = task.provider === 'nppes' ? 1025 : task.provider === 'companies_house' ? 5000 : 10000;
  if (position >= maxOffset) fail('registry_page_limit');
  const raw = await jsonResponse(task, position, options); const body = object(raw);
  let rows: unknown[]; let total: number | null = null;
  switch (task.provider) {
    case 'brreg': {
      const page = object(body?.page); total = integer(page?.totalElements);
      const embedded = object(body?._embedded);
      if (!body || total === null || (total !== 0 && !Array.isArray(embedded?.enheter))) fail('registry_invalid_response');
      rows = list(embedded?.enheter); break;
    }
    case 'france':
      if (!body || !Array.isArray(body.results) || integer(body.total_results) === null) fail('registry_invalid_response');
      rows = body.results; total = integer(body.total_results); break;
    case 'fdic':
      if (!body || !Array.isArray(body.data) || integer(object(body.meta)?.total) === null) fail('registry_invalid_response');
      rows = body.data; total = integer(object(body.meta)?.total); break;
    case 'nppes':
      if (!body || body.Errors || integer(body.result_count) === null || (body.result_count !== 0 && !Array.isArray(body.results))) fail('registry_invalid_response');
      rows = list(body.results); break;
    case 'fmcsa':
      if (!Array.isArray(raw)) fail('registry_invalid_response');
      rows = raw; break;
    case 'companies_house':
      if (!body || !Array.isArray(body.items) || integer(body.hits) === null) fail('registry_invalid_response');
      rows = body.items; total = integer(body.hits); break;
  }
  if (rows.length > PAGE_SIZE) fail('registry_invalid_response');
  // A contradictory empty page is not permission to skip records or declare a
  // source exhausted. Preserve the cursor and let the controller record failure.
  if (rows.length === 0 && total !== null && total > position) fail('registry_invalid_response');
  const excluded: Record<string, number> = {}; const candidates: HeEngRegistryCandidate[] = []; const seen = new Set<string>();
  const mapper = { brreg, france, fdic, nppes, fmcsa, companies_house: mapHeEngCompaniesHouseRecord }[task.provider];
  for (const rawRow of rows) {
    const row = object(rawRow);
    if (!row) { exclude(excluded, 'invalid_record'); continue; }
    const candidate = mapper(row, task, excluded);
    if (!candidate) continue;
    if (candidate.country !== task.country) { exclude(excluded, 'country_unconfirmed'); continue; }
    if (seen.has(candidate.recordId)) { exclude(excluded, 'duplicate_record'); continue; }
    seen.add(candidate.recordId); candidates.push(candidate);
  }
  return { candidates, nextPosition: position + PAGE_SIZE,
    exhausted: total !== null ? position + rows.length >= total : rows.length < PAGE_SIZE,
    excluded, recordsRead: rows.length };
}
