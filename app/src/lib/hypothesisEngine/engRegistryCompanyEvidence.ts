import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';
import { discoverContactLinks } from '@/lib/enrich/websiteParser';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';
import { heCompanySiteIdentity } from './collectionIdentity';
import { readHeEngSourceCountry, withHeEngSourceCountry } from './engCompanyCountry';
import { extractHeEngOfficialCountryEvidence, HE_ENG_OWN_ORGANIZATION_TYPES } from './engCompanySearchCountry';
import { createHeEngCompanySearchCheckpoint, createHeEngRegistryWebsiteSearchPlan, runHeEngCompanySearchPage,
  type HeEngCompanySearchCandidate, type HeEngCompanySearchCheckpoint, type HeEngCompanySearchPlan } from './engCompanySearch';
import { HeEngBaseBudgetError, isHeEngBaseBudgetError } from './engBaseBudgetLedger';
import { ENG_COUNTRIES, normalizeEngCountry } from './engCountries';
import type { HeEngRegistryCandidate } from './engPublicRegistryTypes';
import { HeEngRegistryRetryError } from './engRegistryRetry';
import { fetchHeEngOfficialCompanyPage, heEngEmployeeRangeFit, heEngSearchEmployeeConstraint,
  readHeEngEmployeeRange, readHeEngOfficialOrganizationFacts, type HeEngEmployeeRange,
  type HeEngSearchEvidenceScope, type OfficialPage } from './engSearchCompanyEvidence';
import { withHeDeadline } from './operationDeadline';
import { heStageSignal } from './stages/io';
import type { HeStageContext } from './stages/shared';

type Row = Record<string, unknown>;
const MAX_CATALOG_ROWS = 20;
const MAX_SITES = 3;
const MAX_PAGES_PER_SITE = 3;
const MAX_PAGE_BYTES = 1_500_000;
const DIRECTORY_HOSTS = new Set(['linkedin.com', 'facebook.com', 'instagram.com', 'crunchbase.com', 'zoominfo.com',
  'dnb.com', 'opencorporates.com', 'wikipedia.org', 'brreg.no', 'data.gouv.fr', 'companieshouse.gov.uk',
  'company-information.service.gov.uk', 'npiregistry.cms.hhs.gov', 'fmcsa.dot.gov', 'fdic.gov']);

export type HeEngRegistryResolutionReason = 'confirmed_registry' | 'confirmed_website' | 'invalid_website' |
  'website_not_found' | 'website_search_unavailable' | 'website_unavailable' | 'identity_unconfirmed' |
  'size_scope_ambiguous' | 'size_unconfirmed' | 'outside_size' | 'country_unconfirmed' | 'country_outside';
export interface HeEngRegistryResolutionResult { row: Row | null; reason: HeEngRegistryResolutionReason }
export interface HeEngRegistryResolutionCheckpoint {
  version: 1;
  candidateFingerprint: string;
  scopeFingerprint: string;
  catalogChecked: boolean;
  catalogRows: Row[];
  search?: { plan: HeEngCompanySearchPlan; checkpoint: HeEngCompanySearchCheckpoint; candidates: HeEngCompanySearchCandidate[] };
  websiteReadFailures?: number;
  retryAt?: string;
  result?: HeEngRegistryResolutionResult;
}
/** All injected operations are reads; paid search still uses the base ledger in production. */
export interface HeEngRegistryResolutionReads {
  catalog?: (company: string, country: string, signal?: AbortSignal) => Promise<Row[]>;
  page?: (url: string, signal?: AbortSignal) => Promise<OfficialPage | null>;
  searchPage?: typeof runHeEngCompanySearchPage;
  now?: () => number;
}

function record(value: unknown): Row | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown, max = 400): string {
  return typeof value === 'string' ? sliceWholeChars(stripUnstorableJsonChars(value).replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function key(value: unknown): string { return text(value, 3000).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? ''; }
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
    candidate.emails, candidate.description, candidate.sourceUrl]);
}
function normalizeCatalog(rows: readonly Row[], candidate: HeEngRegistryCandidate): Row[] {
  if (rows.length > MAX_CATALOG_ROWS) return [];
  return rows.filter(row => record(row) && key(row.name) === key(candidate.company) && country(row.country) === country(candidate.country) && website(row.website))
    .map(row => Object.fromEntries(['id', 'name', 'website', 'country', 'region', 'locality', 'industry', 'size', 'description']
      .map(field => [field, text(row[field], field === 'description' ? 1200 : 400)])));
}
function identifierKey(value: unknown): string { return key(value).replace(/\s/g, ''); }
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
      ? frenchIdentifierMatches(raw, expected, namespace) : identifierKey(String(raw)) === expected;
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
function legalBlockIdentity(value: string, candidate: HeEngRegistryCandidate): boolean {
  const normalized = ` ${key(value)} `;
  const legalName = key(candidate.company);
  if (!legalName || !normalized.includes(` ${legalName} `)) return false;
  const labels: Record<HeEngRegistryCandidate['provider'], string> = {
    brreg: 'org(?:anisasjons|anisation)?[\\s.-]*(?:nummer|number|nr)?',
    france: 'siren|siret', fdic: 'fdic\\s*(?:certificate|cert)?', nppes: 'npi',
    fmcsa: '(?:us\\s*)?dot(?:\\s*number)?', companies_house: '(?:company(?:\\s*registration)?|registration)\\s*(?:number|no)',
  };
  const id = identifierKey(candidate.recordId);
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
  }) : id.length >= 5 && new RegExp(`\\b(?:${labels[candidate.provider]})\\b[\\s:./#-]{0,12}(${id.split('').join('[\\s.-]*')})${end}`, 'iu').test(value);
  if (registryNumber) return true;
  const countryDefinition = ENG_COUNTRIES.find(item => item.value === country(candidate.country));
  const countryWords = new Set(key(`${countryDefinition?.value ?? ''} ${countryDefinition?.label ?? ''} ${countryDefinition?.iso2 ?? ''}`).split(' '));
  // Single-character address parts still matter: dropping "1" or "A" would
  // match a different house or street belonging to an unrelated namesake.
  const addressWords = [...new Set(key(candidate.address).split(' ').filter(word => word.length > 0 && !countryWords.has(word)))];
  return addressWords.length >= 3 && addressWords.some(word => /\d/.test(word)) && addressWords.every(word => normalized.includes(` ${word} `));
}
interface OwnFacts { identity: boolean; employees: HeEngEmployeeRange | null }
/** Site identity is verified from its own Organization, never a search result title/snippet. */
export function readHeEngRegistryOwnSiteFacts(
  page: OfficialPage, candidate: HeEngRegistryCandidate, options: { trustedWebsite?: boolean } = {},
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
    if (types.some(type => HE_ENG_OWN_ORGANIZATION_TYPES.has(type)) && sameSite(ownUrl, page.url) && key(name) === key(candidate.company)) {
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
  const footerMatch = $('footer, [role="contentinfo"]').slice(0, 8).toArray()
    .some(node => legalBlockIdentity($(node).text().slice(0, 20_000), candidate));
  const ownHeading = $('title, h1').slice(0, 8).toArray()
    .some(node => ` ${key($(node).text())} `.includes(` ${key(candidate.company)} `));
  // Contact/legal blocks only establish ownership if the page itself names the
  // legal entity. A directory article mentioning a firm is not its own website.
  const contactMatch = ownHeading && $('address, #contact, .contact, #legal, .legal, #imprint, .imprint').slice(0, 12).toArray()
    .some(node => legalBlockIdentity($(node).text().slice(0, 20_000), candidate));
  const declared = [...new Map(matching.filter(item => item.employees && (item.identity || options.trustedWebsite))
    .map(item => [JSON.stringify(item.employees), item.employees])).values()];
  return { identity: footerMatch || contactMatch || matching.some(item => item.identity), employees: declared.length === 1 ? declared[0] : null };
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
  const finish = async (result: HeEngRegistryResolutionResult) => {
    state.result = result;
    await options.onCheckpoint(structuredClone(state));
    return result;
  };
  if (!size.valid) return finish({ row: null, reason: 'size_scope_ambiguous' });
  const candidateCountry = country(candidate.country);
  if (!candidateCountry || !allowed.length || allowed.some(value => value === null)) return finish({ row: null, reason: 'country_unconfirmed' });
  if (!allowed.includes(candidateCountry)) return finish({ row: null, reason: 'country_outside' });
  if (state.result) {
    const result = record(state.result), row = record(result?.row);
    const validReasons: HeEngRegistryResolutionReason[] = ['confirmed_registry', 'confirmed_website', 'invalid_website', 'website_not_found',
      'website_search_unavailable', 'website_unavailable', 'identity_unconfirmed', 'size_scope_ambiguous', 'size_unconfirmed',
      'outside_size', 'country_unconfirmed', 'country_outside'];
    const proof = row ? readHeEngSourceCountry(row) : null;
    const original = row ? record(row._eng_registry_candidate) : null;
    const accepted = ['confirmed_registry', 'confirmed_website'].includes(String(result?.reason));
    const proofBound = proof && (proof.source === 'public_registry'
      ? candidate.addressKind === 'business' && proof.registryProvider === candidate.provider && proof.sourceId === candidate.recordId &&
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
          const exactName = text(candidate.company, 250).replace(/[\\%_]/g, '\\$&');
          const result = await ctx.supabase.from('pdl_companies').select('id,name,website,country,region,locality,industry,size,description')
            .ilike('name', exactName).eq('country', candidateCountry).limit(MAX_CATALOG_ROWS + 1).abortSignal(lookupSignal);
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
  const checkedSites = new Set<string>();
  let anyPageRead = false;
  let lastReason: HeEngRegistryResolutionReason = 'website_not_found';
  let contentReason: HeEngRegistryResolutionReason | null = null;
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
      if (candidate.addressKind !== 'business') return null;
      const row = withHeEngSourceCountry(rowFor(range), { source: 'public_registry', sourceName: candidate.company,
        sourceWebsite: site, country: candidate.country, address: candidate.address, id: candidate.recordId,
        page: candidate.sourceUrl, registryProvider: candidate.provider });
      return readHeEngSourceCountry(row) ? { row, reason: 'confirmed_registry' } : null;
    };
    let range = heEngEmployeeRangeFit(registrySize, size.range) === 'match' ? registrySize : catalogSize;
    if (trusted && heEngEmployeeRangeFit(range, size.range) === 'match') {
      const admitted = admitRegistry(range);
      if (admitted) return admitted;
    }
    const queue = [site];
    const seen = new Set<string>();
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
      } catch (error) { interruption(ctx, error); continue; }
      ctx.onActivity?.();
      if (!page || !page.url.startsWith('https:') || !sameSite(page.url, site) || page.html.length > MAX_PAGE_BYTES) continue;
      anyPageRead = true;
      const facts = readHeEngRegistryOwnSiteFacts(page, candidate, { trustedWebsite: trusted });
      const identity = trusted || facts.identity;
      if (!identity) lastReason = 'identity_unconfirmed';
      else {
        // A coarse source band may overlap the scope without proving it. Exact
        // own-site or same-entity catalog headcount can resolve that uncertainty.
        range = heEngEmployeeRangeFit(registrySize, size.range) === 'match' ? registrySize : facts.employees ?? catalogSize;
        const fit = heEngEmployeeRangeFit(range, size.range);
        if (fit !== 'match') lastReason = fit === 'outside' ? 'outside_size' : 'size_unconfirmed';
        else {
          const admitted = admitRegistry(range);
          if (admitted) return admitted;
          // A registered office is not automatically a business location. Its
          // actual presence must be proven on this exact company's own website.
          const evidence = extractHeEngOfficialCountryEvidence({ companyWebsite: site, pageUrl: page.url, html: page.html,
            allowedCountries: allowed as string[] });
          const own = evidence ? readHeEngOfficialOrganizationFacts(page, evidence) : null;
          if (evidence && own && key(own.name) === key(candidate.company)) {
            const row = withHeEngSourceCountry(rowFor(range), { source: 'company_website', sourceName: candidate.company,
              sourceWebsite: site, country: evidence.sourceCountry, address: evidence.sourceAddress, page: evidence.pageUrl,
              organizationWebsite: evidence.sourceOrganizationWebsite, postalAddress: evidence.sourcePostalAddress });
            if (readHeEngSourceCountry(row)) return { row, reason: 'confirmed_website' };
          }
          lastReason = 'country_unconfirmed';
        }
      }
      contentReason = lastReason;
      if (seen.size === 1) {
        for (const link of discoverContactLinks(page.html, page.url)) {
          if (link.startsWith('https:') && sameSite(link, site) && !seen.has(link)) queue.push(link);
          if (queue.length >= MAX_PAGES_PER_SITE - 1) break;
        }
      }
    }
    return null;
  };
  const initialSites = trustedWebsite ? [trustedWebsite] : [...new Set(catalogRows.map(row => website(row.website)!))].slice(0, 1);
  for (const site of initialSites) {
    const result = await trySite(site, trustedWebsite === site);
    if (result) return finish(result);
  }
  // A registry-provided site is already linked to the entity. Search must not
  // replace a failed/undersized known website with a convenient namesake.
  if (trustedWebsite) return finishUnresolved();
  const plan = createHeEngRegistryWebsiteSearchPlan(candidate);
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
  if (state.search.checkpoint.unavailable) return finish({ row: null, reason: 'website_search_unavailable' });
  for (const hit of state.search.candidates) {
    const site = website(hit.website);
    if (!site) continue;
    const result = await trySite(site, false);
    if (result) return finish(result);
  }
  return finishUnresolved();
}
