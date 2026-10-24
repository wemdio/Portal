import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { discoverContactLinks } from '@/lib/enrich/websiteParser';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';
import { heCompanySiteIdentity } from './collectionIdentity';
import { readHeEngSourceCountry, withHeEngSourceCountry } from './engCompanyCountry';
import { HE_ENG_OWN_ORGANIZATION_TYPES } from './engCompanySearchCountry';
import { createHeEngCompanySearchCheckpoint, createHeEngRegistryWebsiteSearchPlan, heEngLegalNameCore, runHeEngCompanySearchPage,
  HE_ENG_SEARCH_QUERY_MAX, type HeEngCompanySearchCandidate, type HeEngCompanySearchCheckpoint, type HeEngCompanySearchPlan } from './engCompanySearch';
import { HeEngBaseBudgetError, isHeEngBaseBudgetError } from './engBaseBudgetLedger';
import { ENG_COUNTRIES, normalizeEngCountry } from './engCountries';
import type { HeEngRegistryCandidate } from './engPublicRegistryTypes';
import { heEngRegistryRecordValid } from './engRegistryIdentity';
import { HeEngRegistryRetryError } from './engRegistryRetry';
import { createHeEngSourceEvidenceAudit, recordHeEngSourcePageAudit, type HeEngSourceEvidenceAudit } from './engSourceEvidenceAudit';
import { fetchHeEngOfficialCompanyPage, heEngEmployeeRangeFit, heEngSearchEmployeeConstraint,
  readHeEngEmployeeRange, type HeEngEmployeeRange,
  type HeEngSearchEvidenceScope, type OfficialPage } from './engSearchCompanyEvidence';
import { withHeDeadline } from './operationDeadline';
import { heStageSignal } from './stages/io';
import type { HeStageContext } from './stages/shared';

type Row = Record<string, unknown>;
const MAX_CATALOG_ROWS = 20;
const MAX_SITES = 3;
// Home, the legal notice (where a company number or SIREN lives) and contact.
const MAX_PAGES_PER_SITE = 4;
const MAX_PAGE_BYTES = 1_500_000;
// Business directories and registers list the legal name and number but are
// never the company's own site. Searching a legal name returns mostly these;
// without the list they took the three site slots before the real website.
const DIRECTORY_HOSTS = new Set(['linkedin.com', 'facebook.com', 'instagram.com', 'crunchbase.com', 'zoominfo.com',
  'dnb.com', 'opencorporates.com', 'wikipedia.org', 'brreg.no', 'data.gouv.fr', 'companieshouse.gov.uk',
  'company-information.service.gov.uk', 'npiregistry.cms.hhs.gov', 'fmcsa.dot.gov', 'fdic.gov',
  'fca.org.uk', 'kompass.com', 'endole.co.uk', 'companycheck.co.uk', 'formationdata.co.uk', 'doogal.co.uk',
  'ukcompaniesdata.uk', 'opendata.bot', 'ceoemail.com', 'verified.com', 'dbsnow.co.uk', 'bizdb.co.uk',
  'companiesintheuk.co.uk', 'checkcompany.co.uk', 'opengovuk.com', 'find-open-data.co.uk', 'yell.com',
  'thomsonlocal.com', '192.com', 'cylex-uk.co.uk', 'cylex.de', 'hackforddata.com', 'rooplex.co.uk',
  'scoriff.co.uk', 'businessmad.com', 'northdata.com', 'northdata.de', 'bloomberg.com', 'rocketreach.co',
  'apollo.io', 'signalhire.com', 'lusha.com', 'cbinsights.com', 'pitchbook.com', 'preqin.com', 'legal500.com',
  'chambers.com', 'vat-search.ie', 'solocheck.ie', 'societe.com', 'pappers.fr', 'infogreffe.fr', 'verif.com',
  'manageo.fr', 'proff.no', 'purehelp.no', '1881.no', 'gulesider.no', 'bizapedia.com', 'manta.com',
  'buzzfile.com', 'yelp.com', 'bbb.org', 'sophymarine.com', 'experian.com', 'ebay.com', 'amazon.com']);
// Legal-form words: the register says «LTD», the company's own footer «Limited».
const LEGAL_FORM_PHRASES: readonly string[][] = [
  ['public', 'limited', 'company'], ['limited', 'liability', 'partnership'], ['limited', 'liability', 'company'],
  ['limited', 'company'], ['ltd'], ['limited'], ['plc'], ['llp'], ['lp'], ['llc'], ['inc'], ['incorporated'], ['corp'],
  ['corporation'], ['gmbh'], ['ag'], ['sa'], ['sas'], ['sarl'], ['bv'], ['nv'], ['as'], ['asa'], ['ab'], ['oy'],
  ['oyj'], ['aps'],
  // Continental forms as GLEIF and sites write them: «GmbH & Co. KG», «B.V.», «S.p.A.», «UG (haftungsbeschränkt)».
  ['gmbh', 'co', 'kg'], ['ag', 'co', 'kg'], ['co', 'kg'], ['kg'], ['mbh'], ['se'], ['ug', 'haftungsbeschränkt'], ['eg'],
  ['b', 'v'], ['n', 'v'], ['s', 'a'], ['a', 'g'], ['a', 's'], ['a', 'b'], ['s', 'e'], ['spa'], ['s', 'p', 'a'], ['srl'],
  ['s', 'r', 'l'], ['sl'], ['s', 'l'], ['dac'], ['vvag'], ['aktiengesellschaft'], ['kommanditgesellschaft'],
  ['gesellschaft', 'mit', 'beschränkter', 'haftung'],
];

export type HeEngRegistryResolutionReason = 'confirmed_registry' | 'confirmed_website' | 'invalid_website' |
  'website_not_found' | 'website_search_unavailable' | 'website_unavailable' | 'identity_unconfirmed' |
  'size_scope_ambiguous' | 'size_unconfirmed' | 'outside_size' | 'country_unconfirmed' | 'country_outside';
export interface HeEngRegistryResolutionResult { row: Row | null; reason: HeEngRegistryResolutionReason; audit?: HeEngSourceEvidenceAudit }
export interface HeEngRegistryResolutionCheckpoint {
  version: 1;
  candidateFingerprint: string;
  scopeFingerprint: string;
  catalogChecked: boolean;
  catalogRows: Row[];
  search?: { plan: HeEngCompanySearchPlan; checkpoint: HeEngCompanySearchCheckpoint; candidates: HeEngCompanySearchCandidate[] };
  websiteReadFailures?: number;
  retryAt?: string;
  audit?: HeEngSourceEvidenceAudit;
  result?: HeEngRegistryResolutionResult;
}
/** All injected operations are reads; paid search still uses the base ledger in production. */
export interface HeEngRegistryResolutionReads {
  catalog?: (company: string, country: string, signal?: AbortSignal) => Promise<Row[]>;
  /** Same-host catalog rows of a site whose identity is already proven (headcount only). */
  catalogByWebsite?: (variants: string[], signal?: AbortSignal) => Promise<Row[]>;
  page?: (url: string, signal?: AbortSignal) => Promise<OfficialPage | null>;
  searchPage?: typeof runHeEngCompanySearchPage;
  now?: () => number;
}

function record(value: unknown): Row | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown, max = 400): string {
  return typeof value === 'string' ? sliceWholeChars(stripUnstorableJsonChars(value).replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function key(value: unknown): string { return text(value, 3000).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? ''; }
/** Words of a text without «the»/«and»: «A & G» and «A and G» compare equal. */
function nameWords(value: unknown): string[] {
  return key(value).split(' ').filter(word => word && word !== 'the' && word !== 'and');
}
/** The legal name without its trailing legal form, for comparing register, catalog and site. */
function legalNameKey(value: unknown): string {
  const words = nameWords(value);
  for (let changed = true; changed && words.length > 1;) {
    changed = false;
    for (const phrase of LEGAL_FORM_PHRASES) {
      if (words.length > phrase.length && phrase.every((word, i) => words[words.length - phrase.length + i] === word)) {
        words.splice(words.length - phrase.length); changed = true; break;
      }
    }
  }
  return words.join(' ');
}
function website(value: unknown): string | null {
  const raw = text(value, 2048);
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    const site = heCompanySiteIdentity(url.href);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port && site &&
      ![...DIRECTORY_HOSTS].some(domain => site.host === domain || site.host.endsWith(`.${domain}`)) ? `https://${site.host}/` : null;
  } catch { return null; }
}
function sameSite(a: unknown, b: unknown): boolean {
  const first = website(a); return first !== null && first === website(b);
}
function country(raw: unknown): string | null {
  const value = text(raw);
  return normalizeEngCountry(value) ?? ENG_COUNTRIES.find(item => item.iso2 === value.toLowerCase())?.value ?? null;
}
function rangeText(range: HeEngEmployeeRange | null): string {
  return !range ? '' : range.max === null ? `${range.min}+` : range.min === range.max ? String(range.min) : `${range.min}-${range.max}`;
}
function interruption(ctx: HeStageContext, error: unknown): void {
  heStageSignal(ctx)?.throwIfAborted();
  if (isHeEngBaseBudgetError(error) || (error && typeof error === 'object' && (error as { heJobInterruption?: unknown }).heJobInterruption === true)) throw error;
}
function fingerprint(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function candidateFingerprint(candidate: HeEngRegistryCandidate): string {
  return fingerprint([candidate.provider, candidate.recordId, candidate.company, candidate.country, candidate.address,
    candidate.addressKind, candidate.category, candidate.employees ?? '', candidate.employeeYear ?? null, candidate.website,
    candidate.emails, candidate.description, candidate.sourceUrl,
    // Only GLEIF records carry it; older candidates keep their fingerprint.
    ...(candidate.localRegistryId !== undefined ? [candidate.localRegistryId] : [])]);
}
function hasRegistryCountry(candidate: HeEngRegistryCandidate): boolean {
  // The adapter validates the record address; never infer country from the
  // discovery task. UK and French adapters supply validated domestic
  // registered offices; accepting their country does not claim a local team.
  return (candidate.addressKind === 'business' ||
      (['companies_house', 'france'].includes(candidate.provider) && candidate.addressKind === 'registered')) &&
    text(candidate.address).length >= 5 &&
    heEngRegistryRecordValid(candidate.provider, candidate.recordId, country(candidate.country), candidate.sourceUrl);
}
function normalizeCatalog(rows: readonly Row[], candidate: HeEngRegistryCandidate): Row[] {
  if (rows.length > MAX_CATALOG_ROWS) return [];
  const legalName = legalNameKey(candidate.company);
  return rows.filter(row => record(row) && legalName && legalNameKey(row.name) === legalName && country(row.country) === country(candidate.country) && website(row.website))
    .map(row => Object.fromEntries(['id', 'name', 'website', 'country', 'region', 'locality', 'industry', 'size', 'description']
      .map(field => [field, text(row[field], field === 'description' ? 1200 : 400)])));
}
/**
 * Catalog spellings of one legal name: the register form, without its legal
 * form, with the country's usual legal forms, and with «&»/«and» swapped.
 * The register says «1 ANSWER INSURANCE SERVICES LTD.», the catalog
 * «1 answer insurance services» or «… limited»; an exact match missed both.
 * The catalog stores names in lower case, so equality is exact; it uses the
 * trigram index (≈1 s), while an OR of ILIKE patterns scanned the whole
 * country (12 s on production, over the 10 s lookup deadline).
 */
const CATALOG_LEGAL_FORMS: Readonly<Record<string, readonly string[]>> = {
  'united kingdom': ['ltd', 'limited', 'plc', 'llp'], norway: ['as', 'asa'], france: ['sa', 'sas', 'sarl'],
  'united states': ['inc', 'llc', 'corp', 'corporation', 'co'],
  germany: ['gmbh', 'ag', 'se', 'gmbh & co. kg', 'kg'], austria: ['gmbh', 'ag'], switzerland: ['ag', 'sa', 'gmbh'],
  netherlands: ['bv', 'b.v.', 'nv', 'n.v.'], belgium: ['nv', 'bv', 'sa', 'srl'], luxembourg: ['sa', 's.a.', 'sarl'],
  denmark: ['a/s', 'aps'], sweden: ['ab'], finland: ['oy', 'oyj'], ireland: ['ltd', 'limited', 'dac', 'plc'],
  spain: ['sa', 'sl', 's.a.', 's.l.'], italy: ['spa', 'srl', 's.p.a.', 's.r.l.'],
};
function catalogNameVariants(company: string, countryValue: string): string[] {
  // Quotes and backslashes never reach a filter value: «"FIVE TOWNS PLUS" …».
  const exact = text(company, 250).toLowerCase().replace(/["\\]/g, '').replace(/\s+/g, ' ').trim();
  const core = heEngLegalNameCore(exact).toLowerCase();
  const variants = new Set([exact, exact.replace(/[.,;]+$/, ''), core,
    ...(CATALOG_LEGAL_FORMS[countryValue] ?? ['ltd', 'limited', 'inc']).map(form => `${core} ${form}`)]);
  for (const value of [...variants]) {
    if (/\s&\s/.test(value)) variants.add(value.replace(/\s&\s/g, ' and '));
    if (/\sand\s/.test(value)) variants.add(value.replace(/\sand\s/g, ' & '));
  }
  return [...variants].filter(value => value.length >= 3).slice(0, 16);
}
function websiteVariants(site: string): string[] {
  const host = heCompanySiteIdentity(site)?.host;
  if (!host) return [];
  return [...new Set([host, `www.${host}`].flatMap(domain => [domain, `${domain}/`, `https://${domain}`, `https://${domain}/`, `http://${domain}`, `http://${domain}/`]))];
}
const GENERIC_NAME_WORDS = new Set(['insurance', 'services', 'service', 'financial', 'finance', 'group', 'holdings',
  'holding', 'management', 'capital', 'investments', 'investment', 'international', 'global', 'solutions',
  'consulting', 'partners', 'company', 'limited', 'brokers', 'broking', 'underwriting', 'risk', 'uk', 'europe']);
/** Search hits whose domain carries the company's own words come first. */
function brandScore(site: string, company: string): number {
  const label = (heCompanySiteIdentity(site)?.registrable ?? '').split('.')[0].replace(/[^a-z0-9]/g, '');
  const words = legalNameKey(company).split(' ').filter(word => word.length >= 3 && !GENERIC_NAME_WORDS.has(word));
  return label ? words.reduce((score, word) => score + (label.includes(word) ? word.length : 0), 0) : 0;
}
// Pages where UK/EU law puts the company number: legal notice, terms, privacy.
const LEGAL_LINK = /\b(?:legal|impressum|imprint|mentions[\s-]*l[ée]gales|regulatory|company[\s-]*(?:information|details)|important[\s-]*information|terms|privacy)\b/i;
// Insurers sell «legal expenses» cover; those product pages are not legal notices.
const LEGAL_PRODUCT = /\blegal[\s-]*(?:expenses?|cover|protection|services?|advice|aid|insurance|assistance)\b/i;
function legalLinkRank(label: string): number {
  return /\bterms\b/i.test(label) ? 1 : /\bprivacy\b/i.test(label) ? 2 : 0;
}
/** Same-origin legal pages linked from the home page, legal notice first. */
function legalLinks(html: string, baseUrl: string): string[] {
  const $ = cheerio.load(html);
  const found = new Map<string, number>();
  $('a[href]').slice(0, 600).each((_index, node) => {
    const href = ($(node).attr('href') ?? '').trim();
    const label = `${href} ${$(node).text()}`.slice(0, 300);
    if (!href || /^(?:#|mailto:|tel:|javascript:)/i.test(href) || !LEGAL_LINK.test(label) || LEGAL_PRODUCT.test(label)) return;
    try {
      const url = new URL(href, baseUrl);
      url.hash = '';
      if (url.origin === new URL(baseUrl).origin && !found.has(url.href)) found.set(url.href, legalLinkRank(label));
    } catch { /* Not a link. */ }
  });
  return [...found].sort((a, b) => a[1] - b[1]).map(([url]) => url);
}
function identifierKey(value: unknown): string { return key(value).replace(/\s/g, ''); }
/** Companies House pads numbers to eight characters; sites often drop the zeros («No. 354568»). */
function companiesHouseDigits(id: string): string { return /^0+[1-9]\d{3,}$/.test(id) ? id.replace(/^0+/, '') : id; }
type FrenchIdentifierNamespace = 'siren' | 'siret' | 'vat';
function frenchNamespace(raw: unknown): FrenchIdentifierNamespace | null {
  const namespace = identifierKey(raw);
  if (namespace === 'siren' || namespace === 'siret') return namespace;
  return ['vat', 'vatid', 'vatnumber', 'tva', 'tvaintracommunautaire'].includes(namespace) ? 'vat' : null;
}
function frenchIdentifierMatches(raw: unknown, siren: string, namespace?: FrenchIdentifierNamespace): boolean {
  if (typeof raw !== 'string' && typeof raw !== 'number') return false;
  const value = identifierKey(String(raw));
  if (!/^\d{9}$/.test(siren)) return false;
  // INSEE: SIRET = SIREN (9) + NIC (5). French tax authority: VAT =
  // FR + numeric key (2) + SIREN (9). These relations establish identity,
  // never operating-country proof. No unlabelled suffix/substring inference.
  // https://www.insee.fr/fr/metadonnees/definition/c1841
  // https://www.impots.gouv.fr/professionnel/les-numeros-didentification
  if (namespace === 'siret') return /^\d{14}$/.test(value) && value.slice(0, 9) === siren;
  if (namespace === 'vat') return /^fr\d{11}$/.test(value) && value.slice(4) === siren;
  return /^\d{9}$/.test(value) && value === siren;
}
function hasRegistryIdentifier(org: Row, candidate: HeEngRegistryCandidate): boolean {
  const expected = identifierKey(candidate.recordId);
  const visit = (raw: unknown, depth: number, namespace?: FrenchIdentifierNamespace): boolean => {
    if (depth > 4) return false;
    if (typeof raw === 'string' || typeof raw === 'number') return candidate.provider === 'france'
      ? frenchIdentifierMatches(raw, expected, namespace)
      : candidate.provider === 'companies_house'
        ? companiesHouseDigits(identifierKey(String(raw))) === companiesHouseDigits(expected)
        : identifierKey(String(raw)) === expected;
    if (Array.isArray(raw)) return raw.slice(0, 20).some(value => visit(value, depth + 1, namespace));
    const item = record(raw);
    if (!item) return false;
    const declared = item.propertyID ?? item.name;
    const explicit = declared === undefined ? namespace : frenchNamespace(declared);
    if (candidate.provider === 'france' && declared !== undefined && explicit === null) return false;
    return ['value', 'identifier'].some(field => visit(item[field], depth + 1, explicit ?? undefined));
  };
  return expected.length >= 5 && ['identifier', 'taxID', 'vatID'].some(field =>
    visit(org[field], 0, candidate.provider === 'france' && field === 'vatID' ? 'vat' : undefined));
}
function addressMatches(raw: unknown, candidate: HeEngRegistryCandidate): boolean {
  const address = record(raw);
  if (!address) return false;
  const candidateCountry = country(candidate.country);
  const rawCountry = record(address.addressCountry);
  if (country(rawCountry?.name ?? address.addressCountry) !== candidateCountry) return false;
  const street = key(address.streetAddress), locality = key(address.addressLocality), postcode = key(address.postalCode);
  if (street.length < 5 || locality.length < 2 || postcode.length < 3) return false;
  const registered = ` ${key(candidate.address)} `;
  // Match all three independent address parts, not a country word or TLD.
  return [street, locality, postcode].every(part => registered.includes(` ${part} `));
}
// «Company No.», «Registration number», «Registered in England and Wales No.»,
// «Registered number», «Reg. No.», «under number», «CRN», «Registered in England
// #3630812». GLEIF's UK entities carry the same number as `registeredAs`.
const UK_COMPANY_NUMBER_LABELS = '(?:company\\s+(?:registration\\s+|reg(?:istered)?\\.?\\s*)?(?:number|no|nr)'
  + '|registration\\s+(?:number|no|nr)'
  + '|registered\\s+(?:in\\s+(?:england(?:\\s*(?:and|&)\\s*wales)?|wales|scotland|northern\\s+ireland)\\s*)?(?:company\\s+)?(?:number|no|nr)'
  + '|registered\\s+in\\s+(?:england(?:\\s*(?:and|&)\\s*wales)?|wales|scotland|northern\\s+ireland)(?=\\s*#)'
  + '|reg\\.?\\s*(?:number|no|nr)|under\\s+(?:registration\\s+)?(?:number|no)|crn)';
/**
 * A legal block names this entity. With `numberAlone` (the site's own footer) a
 * labelled registry number is enough by itself: the number is unique, and a
 * directory page lists other companies' numbers in its body, not in its footer.
 * With `numberRequired` (a whole legal page) the name must come with the number.
 */
function legalBlockIdentity(value: string, candidate: HeEngRegistryCandidate,
  options: { numberAlone?: boolean; numberRequired?: boolean } = {}): boolean {
  const normalized = ` ${key(value)} `;
  const named = ` ${nameWords(value).join(' ')} `;
  const legalName = legalNameKey(candidate.company);
  const labels: Record<HeEngRegistryCandidate['provider'], string> = {
    brreg: 'org(?:anisasjons|anisation)?[\\s.-]*(?:nummer|number|nr)?',
    france: 'siren|siret', fdic: 'fdic\\s*(?:certificate|cert)?', nppes: 'npi',
    fmcsa: '(?:us\\s*)?dot(?:\\s*number)?',
    companies_house: UK_COMPANY_NUMBER_LABELS,
    // The LEI itself; the local register number is matched separately below.
    gleif: 'lei|legal\\s+entity\\s+identifier',
    // An OpenStreetMap element id never appears on a company site.
    osm: '(?!)',
  };
  const id = identifierKey(candidate.recordId);
  const digits = candidate.provider === 'companies_house' ? companiesHouseDigits(id) : id;
  const idPattern = `${digits !== id ? '(?:0[\\s.-]*)*' : ''}${digits.split('').join('[\\s.-]*')}`;
  // A labelled registry identifier in the company's own legal footer is a
  // second identity fact. Arbitrary numbers in articles/testimonials are not.
  const end = '(?![\\p{L}\\p{N}]|[\\s.-]{1,3}\\d)';
  const registryNumber = candidate.provider === 'france' ? ([
    ['siren', 'SIREN', '\\d(?:[\\s.-]*\\d){8}'],
    ['siret', 'SIRET', '\\d(?:[\\s.-]*\\d){13}'],
    ['vat', '(?:TVA(?:\\s+intracommunautaire)?|VAT(?:\\s+(?:number|ID))?)', 'FR[\\s.-]*\\d(?:[\\s.-]*\\d){10}'],
  ] as const).some(([namespace, label, pattern]) => {
    const matches = value.matchAll(new RegExp(`\\b${label}\\b[\\s:./#-]{0,12}(${pattern})${end}`, 'giu'));
    return [...matches].some(match => frenchIdentifierMatches(match[1], id, namespace));
  }) : id.length >= 5 && new RegExp(`\\b(?:${labels[candidate.provider]})\\b[\\s:./#-]{0,12}(${idPattern})${end}`, 'iu').test(value);
  if (registryNumber && options.numberAlone) return true;
  if (!legalName || !named.includes(` ${legalName} `)) return false;
  if (registryNumber || localRegistryNumber(value, candidate)) return true;
  // A long legal page contains most address words somewhere; only the number counts there.
  if (options.numberRequired) return false;
  const countryDefinition = ENG_COUNTRIES.find(item => item.value === country(candidate.country));
  // Companies House ends a registered office with «ENGLAND»/«WALES»/«SCOTLAND»;
  // the company's own pages rarely repeat it after the postcode.
  const countryWords = new Set(key(`${countryDefinition?.value ?? ''} ${countryDefinition?.label ?? ''} ${countryDefinition?.iso2 ?? ''}${
    countryDefinition?.value === 'united kingdom' ? ' uk england wales scotland northern ireland' : ''}`).split(' '));
  // Single-character address parts still matter: dropping "1" or "A" would
  // match a different house or street belonging to an unrelated namesake.
  const addressWords = [...new Set(key(candidate.address).split(' ').filter(word => word.length > 0 && !countryWords.has(word)))];
  return addressWords.length >= 3 && addressWords.some(word => /\d/.test(word)) && addressWords.every(word => normalized.includes(` ${word} `));
}
/**
 * Short passages around each mention of the legal name: «issued by 1st Sure Ltd …
 * Our registered office is at: 6 Station Close, Potters Bar EN6 1TL». Address
 * words only count this close to the name, not scattered over a long page.
 */
function nameWindows(value: string, company: string): string[] {
  const words = legalNameKey(company).split(' ').filter(Boolean);
  if (!words.length) return [];
  const pattern = new RegExp(words.map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^\\p{L}\\p{N}]+(?:(?:and|the)[^\\p{L}\\p{N}]+)?'), 'giu');
  const windows: string[] = [];
  for (const match of value.matchAll(pattern)) {
    windows.push(value.slice(Math.max(0, match.index - 300), match.index + match[0].length + 500));
    if (windows.length >= 12) break;
  }
  return windows;
}
// Labels that precede a local company number across GLEIF's countries: German
// Handelsregister, Dutch KvK, Danish CVR, Nordic org. numbers, Finnish Y-tunnus,
// Irish CRO, Luxembourg RCS, Austrian Firmenbuch, Belgian KBO and others; the UK
// Companies House forms; the NAIC company code GLEIF holds for many US insurers.
const LOCAL_REGISTRY_LABELS = '(?:handelsregister|registernummer|registergericht|hr[ab]|kvk|kamer\\s+van\\s+koophandel|cvr|'
  + 'org(?:anisations|anisasjons)?\\.?[\\s-]*(?:nr|nummer|number|no)|y-tunnus|business\\s+id|fo-nummer|cro|rcs|firmenbuch|fn|'
  + 'kbo|ondernemingsnummer|company\\s+(?:reg(?:istration)?\\.?\\s*)?(?:no|number|nr)|registration\\s+(?:no|number|nr)|'
  + 'registered\\s+(?:no|number)|reg\\.?\\s*(?:no|nr)|krs|nip|regon|cif|nif|p\\.?\\s*iva|partita\\s+iva|'
  + `naic(?:\\s+company)?(?:\\s+(?:code|number|no))?|${UK_COMPANY_NUMBER_LABELS})`;
/**
 * GLEIF's `registeredAs`: «HRB 7876», «B123456», «12345678». A number with its
 * own letters is matched as written; a bare number needs a register label.
 * Local numbers repeat between courts and countries, so the caller also
 * requires the legal name in the same block.
 */
function localRegistryNumber(value: string, candidate: HeEngRegistryCandidate): boolean {
  if (candidate.provider !== 'gleif' || !candidate.localRegistryId) return false;
  const chars = candidate.localRegistryId.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
  if (chars.length < 5 || chars.length > 30) return false;
  // GLEIF keeps a Companies House number padded («01167327»); the site writes
  // «company number 1167327». Same rule as companiesHouseDigits.
  const digits = companiesHouseDigits(chars);
  const pattern = `${digits !== chars ? '(?:0[\\s.:/-]*)*' : ''}${digits.split('').map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\s.:/-]*')}`;
  const end = '(?![\\p{L}\\p{N}]|[\\s.-]{1,3}\\d)';
  return /\p{L}/u.test(chars)
    ? new RegExp(`(?<![\\p{L}\\p{N}])${pattern}${end}`, 'iu').test(value)
    : new RegExp(`\\b${LOCAL_REGISTRY_LABELS}\\b[\\s:./#-]{0,16}${pattern}${end}`, 'iu').test(value);
}
interface OwnFacts { identity: boolean; employees: HeEngEmployeeRange | null }
/** Site identity is verified from its own Organization, never a search result title/snippet. */
export function readHeEngRegistryOwnSiteFacts(
  page: OfficialPage, candidate: HeEngRegistryCandidate, options: { trustedWebsite?: boolean; legalPage?: boolean } = {},
): OwnFacts {
  if (!website(page.url) || page.html.length > MAX_PAGE_BYTES) return { identity: false, employees: null };
  const $ = cheerio.load(page.html);
  const matching: Array<{ identity: boolean; employees: HeEngEmployeeRange | null }> = [];
  let visited = 0;
  const walk = (raw: unknown, depth: number): void => {
    if (depth > 12 || ++visited > 2000) return;
    if (Array.isArray(raw)) { raw.slice(0, 200).forEach(value => walk(value, depth + 1)); return; }
    const org = record(raw);
    if (!org) return;
    const types = (Array.isArray(org['@type']) ? org['@type'] : [org['@type']]).map(value => text(value).replace(/^https?:\/\/schema\.org\//, ''));
    let ownUrl = '';
    try { if (text(org.url)) ownUrl = new URL(text(org.url, 2048), page.url).href; } catch { /* Invalid identity URL. */ }
    const name = text(org.legalName) || text(org.name);
    if (types.some(type => HE_ENG_OWN_ORGANIZATION_TYPES.has(type)) && sameSite(ownUrl, page.url) &&
        legalNameKey(candidate.company) && legalNameKey(name) === legalNameKey(candidate.company)) {
      const addresses = Array.isArray(org.address) ? org.address.slice(0, 30) : [org.address];
      matching.push({ identity: hasRegistryIdentifier(org, candidate) || addresses.some(address => addressMatches(address, candidate)),
        employees: readHeEngEmployeeRange(org.numberOfEmployees) });
    }
    for (const [field, value] of Object.entries(org)) if (field !== '@context') walk(value, depth + 1);
  };
  $('script[type="application/ld+json"]').slice(0, 30).each((_index, node) => {
    const json = $(node).text();
    if (json.length > 256_000) return;
    try { walk(JSON.parse(json), 0); } catch { /* Invalid structured data proves nothing. */ }
  });
  $('script, style, noscript, template').remove();
  // .text() glues adjacent blocks: Fremtind's footer «0106 Oslo</p><p>Organisasjonsnummer:
  // 915 651 232</p></div><div><a>Kontakt oss» read «OsloOrganisasjonsnummer: 915 651
  // 232Kontakt», and neither end of the labelled number matched. A block never ends
  // mid-word, so a separator after each one changes no word (as in websiteParser).
  $('br').replaceWith(' ');
  $('p, div, li, address, section, article, header, footer, h1, h2, h3, h4, h5, h6, td, th, tr, dt, dd').append(' ');
  // A legal page linked from the home page of this site (terms, privacy, legal
  // notice) names the entity with its number: «Acme Ltd, company number …».
  const legalText = options.legalPage ? $('body').text().replace(/\s+/g, ' ').slice(0, 200_000) : '';
  const legalPageMatch = !!options.legalPage && (legalBlockIdentity(legalText, candidate, { numberRequired: true }) ||
    nameWindows(legalText, candidate.company).some(window => legalBlockIdentity(window, candidate)));
  // Many sites build the footer from a div named «footer»/«copyright», not the
  // <footer> element. A long block is a page wrapper, not a footer.
  const footerMatch = $('footer, [role="contentinfo"], [id*="footer"], [class*="footer"], [id*="copyright"], [class*="copyright"]')
    .slice(0, 16).toArray()
    .some(node => !$(node).is('body, html') && $(node).text().length <= 6_000 &&
      legalBlockIdentity($(node).text(), candidate, { numberAlone: true }));
  const legalName = legalNameKey(candidate.company);
  const ownHeading = !!legalName && $('title, h1').slice(0, 8).toArray()
    .some(node => ` ${nameWords($(node).text()).join(' ')} `.includes(` ${legalName} `));
  // Contact/legal blocks only establish ownership if the page itself names the
  // legal entity. A directory article mentioning a firm is not its own website.
  const contactMatch = ownHeading && $('address, #contact, .contact, #legal, .legal, #imprint, .imprint').slice(0, 12).toArray()
    .some(node => legalBlockIdentity($(node).text().slice(0, 20_000), candidate));
  const declared = [...new Map(matching.filter(item => item.employees && (item.identity || options.trustedWebsite))
    .map(item => [JSON.stringify(item.employees), item.employees])).values()];
  return { identity: footerMatch || legalPageMatch || contactMatch || matching.some(item => item.identity),
    employees: declared.length === 1 ? declared[0] : null };
}

/**
 * A registry chooses candidates, not recipients. Unknown websites are resolved
 * by a free exact-name catalog lookup, then at most one paid search page.
 * Neither search rank nor matching names alone establish a company identity.
 */
export async function resolveHeEngRegistryCandidate(
  ctx: HeStageContext,
  candidate: HeEngRegistryCandidate,
  scope: HeEngSearchEvidenceScope,
  options: {
    db: SupabaseClient; baseId: string; projectId: string;
    saved?: HeEngRegistryResolutionCheckpoint;
    onCheckpoint: (checkpoint: HeEngRegistryResolutionCheckpoint) => Promise<void>;
    reads?: HeEngRegistryResolutionReads;
  },
): Promise<HeEngRegistryResolutionResult> {
  const signal = heStageSignal(ctx);
  signal?.throwIfAborted();
  const now = options.reads?.now ?? Date.now;
  const size = heEngSearchEmployeeConstraint(scope);
  const allowed = scope.allowedCountries.map(country);
  const identityFingerprint = candidateFingerprint(candidate);
  const scopeFingerprint = fingerprint([allowed, size]);
  const state: HeEngRegistryResolutionCheckpoint = options.saved ? structuredClone(options.saved) : {
    version: 1, candidateFingerprint: identityFingerprint, scopeFingerprint, catalogChecked: false, catalogRows: [],
  };
  if (state.version !== 1 || state.candidateFingerprint !== identityFingerprint || state.scopeFingerprint !== scopeFingerprint ||
      typeof state.catalogChecked !== 'boolean' || !Array.isArray(state.catalogRows) || state.catalogRows.length > MAX_CATALOG_ROWS) {
    throw new Error('ENG registry resolution checkpoint belongs to a different company or scope.');
  }
  if ((state.websiteReadFailures !== undefined && (!Number.isInteger(state.websiteReadFailures) || state.websiteReadFailures < 0 || state.websiteReadFailures > 2)) ||
      (state.retryAt !== undefined && (typeof state.retryAt !== 'string' || !Number.isFinite(Date.parse(state.retryAt)) || state.websiteReadFailures !== 1))) {
    throw new Error('ENG registry website retry checkpoint is invalid.');
  }
  if (state.search && (!record(state.search) || !record(state.search.checkpoint) || !record(state.search.plan))) {
    throw new Error('ENG registry website search checkpoint is invalid.');
  }
  if (state.search?.checkpoint.inFlight) throw new HeEngBaseBudgetError('unknown_cost');
  if (state.retryAt && Date.parse(state.retryAt) > now()) throw new HeEngRegistryRetryError(Math.max(1000, Date.parse(state.retryAt) - now()));
  delete state.retryAt;
  const audit = state.audit ??= createHeEngSourceEvidenceAudit('public_registry', country(candidate.country) ?? undefined);
  const finish = async (result: HeEngRegistryResolutionResult) => {
    state.result = { ...result, audit: structuredClone(audit) };
    await options.onCheckpoint(structuredClone(state));
    return state.result;
  };
  if (!size.valid) return finish({ row: null, reason: 'size_scope_ambiguous' });
  const candidateCountry = country(candidate.country);
  if (!candidateCountry || !allowed.length || allowed.some(value => value === null)) return finish({ row: null, reason: 'country_unconfirmed' });
  if (!allowed.includes(candidateCountry)) return finish({ row: null, reason: 'country_outside' });
  if (!hasRegistryCountry(candidate)) return finish({ row: null, reason: 'country_unconfirmed' });
  audit.countrySource = 'public_registry';
  audit.country = candidateCountry;
  if (state.result) {
    const result = record(state.result), row = record(result?.row);
    const validReasons: HeEngRegistryResolutionReason[] = ['confirmed_registry', 'confirmed_website', 'invalid_website', 'website_not_found',
      'website_search_unavailable', 'website_unavailable', 'identity_unconfirmed', 'size_scope_ambiguous', 'size_unconfirmed',
      'outside_size', 'country_unconfirmed', 'country_outside'];
    const proof = row ? readHeEngSourceCountry(row) : null;
    const original = row ? record(row._eng_registry_candidate) : null;
    const accepted = ['confirmed_registry', 'confirmed_website'].includes(String(result?.reason));
    const proofBound = proof && (proof.source === 'public_registry'
      ? hasRegistryCountry(candidate) && proof.registryProvider === candidate.provider && proof.sourceId === candidate.recordId &&
        proof.sourcePage === candidate.sourceUrl && proof.sourceAddress === candidate.address && proof.country === candidateCountry &&
        result?.reason === 'confirmed_registry'
      : proof.source === 'company_website' && result?.reason === 'confirmed_website');
    const validRow = row && original && candidateFingerprint(original as unknown as HeEngRegistryCandidate) === identityFingerprint &&
      row.company === candidate.company && website(row.website) && (!candidate.website || sameSite(row.website, candidate.website)) &&
      row.email === candidate.emails.join('; ') && proof && proofBound && allowed.includes(proof.country) &&
      heEngEmployeeRangeFit(readHeEngEmployeeRange(row.employees), size.range) === 'match' && row._email_status === undefined;
    if (!result || !validReasons.includes(result.reason as HeEngRegistryResolutionReason) ||
        (result.row !== null && (!validRow || !accepted)) || (result.row === null && accepted)) {
      throw new Error('ENG registry cached resolution is invalid.');
    }
    return state.result;
  }
  const registrySize = readHeEngEmployeeRange(candidate.employees);
  if (heEngEmployeeRangeFit(registrySize, size.range) === 'outside') return finish({ row: null, reason: 'outside_size' });
  const trustedWebsite = website(candidate.website);
  if (candidate.website && !trustedWebsite) return finish({ row: null, reason: 'invalid_website' });
  if (!state.catalogChecked) {
    let rows: Row[] = [];
    // A supplied website and a sufficient registry size need no extra lookup.
    if (!trustedWebsite || heEngEmployeeRangeFit(registrySize, size.range) !== 'match') {
      try {
        rows = await withHeDeadline('ENG registry exact company catalog lookup', 10_000, signal, async lookupSignal => {
          if (options.reads?.catalog) return options.reads.catalog(candidate.company, candidateCountry, lookupSignal);
          const result = await ctx.supabase.from('pdl_companies').select('id,name,website,country,region,locality,industry,size,description')
            .in('name', catalogNameVariants(candidate.company, candidateCountry)).eq('country', candidateCountry)
            .limit(MAX_CATALOG_ROWS + 1).abortSignal(lookupSignal);
          if (result.error) throw new Error('ENG registry company catalog lookup failed.');
          return Array.isArray(result.data) ? result.data : [];
        });
      } catch (error) { interruption(ctx, error); }
    }
    state.catalogRows = normalizeCatalog(rows, candidate);
    state.catalogChecked = true;
    await options.onCheckpoint(structuredClone(state));
  }
  const catalogRows = normalizeCatalog(state.catalogRows, candidate);
  audit.catalogMatches = catalogRows.length;
  const checkedSites = new Set<string>();
  let anyPageRead = false;
  let lastReason: HeEngRegistryResolutionReason = 'website_not_found';
  let contentReason: HeEngRegistryResolutionReason | null = null;
  // The entity's own site is found but its size does not fit or is unknown:
  // another site could only be a namesake or a partner portal.
  let ownSiteFound = false;
  const finishUnresolved = async () => {
    // Only an entirely unreadable free-site pass may retry. Source candidates,
    // catalog decisions and paid SERP receipts remain frozen in this checkpoint.
    if (checkedSites.size > 0 && !anyPageRead) {
      state.websiteReadFailures = (state.websiteReadFailures ?? 0) + 1;
      if (state.websiteReadFailures === 1) {
        state.retryAt = new Date(now() + 30_000).toISOString();
        await options.onCheckpoint(structuredClone(state));
        throw new HeEngRegistryRetryError(30_000);
      }
    }
    return finish({ row: null, reason: contentReason ?? lastReason });
  };
  const trySite = async (site: string, trusted: boolean): Promise<HeEngRegistryResolutionResult | null> => {
    if (checkedSites.has(site) || checkedSites.size >= MAX_SITES) return null;
    checkedSites.add(site);
    const sameCatalog = catalogRows.filter(row => sameSite(row.website, site));
    const catalogRanges = [...new Map(sameCatalog.map(row => readHeEngEmployeeRange(row.size))
      .filter((value): value is HeEngEmployeeRange => value !== null).map(value => [JSON.stringify(value), value])).values()];
    const catalogSize = catalogRanges.length === 1 ? catalogRanges[0] : null;
    const rowFor = (range: HeEngEmployeeRange | null): Row => ({
      company: candidate.company, website: site, address: candidate.address, category: candidate.category,
      employees: rangeText(range), email: candidate.emails.join('; '), source_detail: `eng_registry:${candidate.provider}`,
      _eng_source_description: text(candidate.description, 1200), _eng_registry_candidate: structuredClone(candidate),
    });
    const admitRegistry = (range: HeEngEmployeeRange | null): HeEngRegistryResolutionResult | null => {
      if (!hasRegistryCountry(candidate)) return null;
      const row = withHeEngSourceCountry(rowFor(range), { source: 'public_registry', sourceName: candidate.company,
        sourceWebsite: site, country: candidate.country, address: candidate.address, id: candidate.recordId,
        page: candidate.sourceUrl, registryProvider: candidate.provider });
      return readHeEngSourceCountry(row) ? { row, reason: 'confirmed_registry' } : null;
    };
    // The catalog often files a big company under its brand («Aviva»), not the
    // legal name, so the name lookup misses its headcount. Once this site is
    // proven to be the entity's own, the catalog rows of the same site count.
    let siteCatalogSize: HeEngEmployeeRange | null | undefined;
    const sizeBySite = async (): Promise<HeEngEmployeeRange | null> => {
      if (siteCatalogSize !== undefined) return siteCatalogSize;
      siteCatalogSize = null;
      const variants = websiteVariants(site);
      if (!variants.length) return null;
      try {
        const rows = await withHeDeadline('ENG registry site catalog lookup', 10_000, signal, async lookupSignal => {
          if (options.reads?.catalogByWebsite) return options.reads.catalogByWebsite(variants, lookupSignal);
          const result = await ctx.supabase.from('pdl_companies').select('website,size')
            .in('website', variants).limit(MAX_CATALOG_ROWS + 1).abortSignal(lookupSignal);
          if (result.error) throw new Error('ENG registry site catalog lookup failed.');
          return Array.isArray(result.data) ? result.data : [];
        });
        const ranges = rows.length > MAX_CATALOG_ROWS ? [] : [...new Map(rows.filter(row => record(row) && sameSite(row.website, site))
          .map(row => readHeEngEmployeeRange(row.size)).filter((value): value is HeEngEmployeeRange => value !== null)
          .map(value => [JSON.stringify(value), value])).values()];
        siteCatalogSize = ranges.length === 1 ? ranges[0] : null;
      } catch (error) { interruption(ctx, error); }
      ctx.onActivity?.();
      return siteCatalogSize;
    };
    let range = heEngEmployeeRangeFit(registrySize, size.range) === 'match' ? registrySize : catalogSize;
    if (trusted && heEngEmployeeRangeFit(range, size.range) === 'match') {
      const admitted = admitRegistry(range);
      if (admitted) return admitted;
    }
    const queue = [site];
    const seen = new Set<string>();
    const legalPages = new Set<string>();
    lastReason = 'website_unavailable';
    while (queue.length && seen.size < MAX_PAGES_PER_SITE) {
      signal?.throwIfAborted();
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      let page: OfficialPage | null = null;
      try {
        page = options.reads?.page ? await withHeDeadline('ENG registry company website', 12_000, signal, pageSignal => options.reads!.page!(url, pageSignal))
          : await fetchHeEngOfficialCompanyPage(ctx, url, signal);
      } catch (error) {
        recordHeEngSourcePageAudit(audit, url, null);
        interruption(ctx, error); continue;
      }
      ctx.onActivity?.();
      const pageAudit = recordHeEngSourcePageAudit(audit, url, page);
      if (!page || !page.url.startsWith('https:') || !sameSite(page.url, site) || page.html.length > MAX_PAGE_BYTES) continue;
      anyPageRead = true;
      const facts = readHeEngRegistryOwnSiteFacts(page, candidate, { trustedWebsite: trusted, legalPage: legalPages.has(url) });
      const identity = trusted || facts.identity;
      pageAudit.identity = identity;
      // A later page without the legal footer does not undo a proven identity.
      if (!identity) { if (!ownSiteFound) lastReason = 'identity_unconfirmed'; }
      else {
        // A coarse source band may overlap the scope without proving it. Exact
        // own-site or same-entity catalog headcount can resolve that uncertainty.
        range = heEngEmployeeRangeFit(registrySize, size.range) === 'match' ? registrySize : facts.employees ?? catalogSize;
        let fit = heEngEmployeeRangeFit(range, size.range);
        if (fit === 'unknown') {
          const bySite = await sizeBySite();
          if (bySite) { range = bySite; fit = heEngEmployeeRangeFit(range, size.range); }
        }
        pageAudit.employeeFit = fit;
        if (fit !== 'match') lastReason = fit === 'outside' ? 'outside_size' : 'size_unconfirmed';
        else {
          const admitted = admitRegistry(range);
          if (admitted) return admitted;
          // A valid source country is already known. Failure to bind its
          // proof must not be repaired by borrowing another website address.
          lastReason = 'country_unconfirmed';
        }
        // The rest of this site may still declare a headcount; other sites are not tried.
        ownSiteFound = true;
      }
      contentReason = lastReason;
      if (seen.size === 1) {
        // Two legal pages (where the company number lives), then contact pages.
        const legal = legalLinks(page.html, page.url).filter(link => link.startsWith('https:') && sameSite(link, site) && !seen.has(link)).slice(0, 2);
        for (const link of legal) { queue.push(link); legalPages.add(link); }
        for (const link of discoverContactLinks(page.html, page.url)) {
          if (queue.length >= MAX_PAGES_PER_SITE - 1) break;
          if (link.startsWith('https:') && sameSite(link, site) && !seen.has(link) && !queue.includes(link)) queue.push(link);
        }
      }
    }
    return null;
  };
  const initialSites = trustedWebsite ? [trustedWebsite] : [...new Set(catalogRows.map(row => website(row.website)!))].slice(0, 1);
  for (const site of initialSites) {
    const result = await trySite(site, trustedWebsite === site);
    if (result) return finish(result);
    if (ownSiteFound) return finishUnresolved();
  }
  // A registry-provided site is already linked to the entity. Search must not
  // replace a failed/undersized known website with a convenient namesake.
  if (trustedWebsite) return finishUnresolved();
  // A page already bought under an older query keeps its plan; an unpaid older
  // checkpoint moves to the current query (v2 dropped «LTD.», v3 also «N.V.», «GmbH & Co. KG»).
  let plan = createHeEngRegistryWebsiteSearchPlan(candidate);
  // Saved before 23.10.2026 under a query longer than any search accepts: its
  // checkpoint failed validation before a page could be bought, so it is rebuilt.
  if (state.search && state.search.checkpoint.calls === 0 && !state.search.checkpoint.unavailable &&
      state.search.plan.tasks.some(task => task.query.length > HE_ENG_SEARCH_QUERY_MAX)) delete state.search;
  const legacyPlan = [createHeEngRegistryWebsiteSearchPlan(candidate, 1), createHeEngRegistryWebsiteSearchPlan(candidate, 2)]
    .find(older => older.fingerprint !== plan.fingerprint && older.fingerprint === state.search?.plan.fingerprint);
  if (state.search && legacyPlan) {
    if (state.search.checkpoint.calls > 0 || state.search.checkpoint.unavailable) plan = legacyPlan;
    else delete state.search;
  }
  if (state.search && (state.search.plan.fingerprint !== plan.fingerprint || !Array.isArray(state.search.candidates) || state.search.candidates.length > 10)) {
    throw new Error('ENG registry website search checkpoint does not match the legal entity.');
  }
  if (!state.search) {
    state.search = { plan, checkpoint: createHeEngCompanySearchCheckpoint(plan), candidates: [] };
    await options.onCheckpoint(structuredClone(state));
  }
  if (state.search.checkpoint.calls === 0 && !state.search.checkpoint.unavailable) {
    await (options.reads?.searchPage ?? runHeEngCompanySearchPage)({ db: options.db, baseId: options.baseId, projectId: options.projectId,
      plan: state.search.plan, checkpoint: state.search.checkpoint, signal,
      onCheckpoint: async (checkpoint, candidates) => {
        state.search = { plan, checkpoint: structuredClone(checkpoint), candidates: structuredClone(candidates) };
        await options.onCheckpoint(structuredClone(state));
      } });
  }
  if (state.search.checkpoint.inFlight) throw new HeEngBaseBudgetError('unknown_cost');
  // A paid page that never answered (charged at its reserve) found nothing either way.
  const unanswered = state.search.checkpoint.calls > 0 && state.search.checkpoint.unanswered === state.search.checkpoint.calls;
  if (state.search.checkpoint.unavailable || unanswered) return finish({ row: null, reason: 'website_search_unavailable' });
  // Only three sites are read: hits whose domain carries the company's own
  // words go first, directories and namesakes after, search rank breaks ties.
  const hits = [...new Set(state.search.candidates.map(hit => website(hit.website)).filter((site): site is string => site !== null))]
    .map((site, rank) => ({ site, rank, score: brandScore(site, candidate.company) }))
    .sort((a, b) => b.score - a.score || a.rank - b.rank);
  for (const { site } of hits) {
    const result = await trySite(site, false);
    if (result) return finish(result);
    if (ownSiteFound) break;
  }
  return finishUnresolved();
}
