import { createUsWebsiteFetchGuard } from '@/lib/enrich/publicAddress';
import { discoverContactLinks, fetchFollowingGuarded, readBodyCapped, WEBSITE_ACCEPT_LANGUAGE_EN } from '@/lib/enrich/websiteParser';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';
import { heCompanySiteIdentity } from './collectionIdentity';
import { readHeEngSourceCountry, withHeEngSourceCountry } from './engCompanyCountry';
import { extractHeEngOfficialCountryEvidence, HE_ENG_OWN_ORGANIZATION_TYPES, type HeEngOfficialCountryEvidence } from './engCompanySearchCountry';
import type { HeEngCompanySearchCandidate } from './engCompanySearch';
import { ENG_COUNTRIES, normalizeEngCountry } from './engCountries';
import { createHeEngSourceEvidenceAudit, recordHeEngSourcePageAudit, type HeEngSourceEvidenceAudit } from './engSourceEvidenceAudit';
import { readHeIcpFrame } from './icpFrame';
import { withHeDeadline } from './operationDeadline';
import { heStageSignal } from './stages/io';
import type { HeStageContext } from './stages/shared';

const MAX_CATALOG_MATCHES = 20;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_OFFICIAL_PAGES = 3;

type Row = Record<string, unknown>;
export interface HeEngEmployeeRange { min: number; max: number | null }
export type HeEngSearchEvidenceReason = 'confirmed_catalog' | 'confirmed_website' | 'invalid_website' |
  'size_scope_ambiguous' | 'size_unconfirmed' | 'outside_size' | 'country_unconfirmed' | 'website_unavailable' | 'identity_unconfirmed';
export interface HeEngSearchEvidenceScope {
  allowedCountries: readonly string[];
  icp?: unknown;
  hypotheses: ReadonlyArray<{ title?: string; description?: string }>;
}
export interface HeEngSearchCompanyEvidenceResult {
  row: Row | null;
  reason: HeEngSearchEvidenceReason;
  countrySource?: 'pdl' | 'company_website';
  audit?: HeEngSourceEvidenceAudit;
}
export interface OfficialPage { url: string; html: string }
/** Injectable reads support offline checks without live network/provider calls. */
export interface HeEngSearchCompanyEvidenceReads {
  catalog?: (websites: string[], signal?: AbortSignal) => Promise<Row[]>;
  page?: (url: string, signal?: AbortSignal) => Promise<OfficialPage | null>;
}

function record(value: unknown): Row | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null; }
function text(value: unknown, max = 400): string {
  return typeof value === 'string' ? sliceWholeChars(stripUnstorableJsonChars(value).replace(/\s+/g, ' ').trim(), 0, max) : '';
}
function host(value: unknown): string | null {
  const raw = text(value, 2048);
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.port
      ? heCompanySiteIdentity(url.href)?.host ?? null : null;
  } catch { return null; }
}
function integer(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d[\d,]*$/.test(value.trim())
    ? Number(value.replace(/,/g, '')) : NaN;
  return Number.isSafeInteger(n) && n >= 0 && n <= 100_000_000 ? n : null;
}
function structuredCountry(raw: unknown): string | null {
  const country = record(raw);
  for (const value of country ? [country.name, country.alternateName, country.identifier] : [raw]) {
    const name = text(value);
    const normalized = normalizeEngCountry(name) ?? ENG_COUNTRIES.find(item => item.iso2 === name.toLowerCase())?.value;
    if (normalized) return normalized;
  }
  return null;
}
function companyNameKey(raw: unknown): string {
  return text(raw).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.join(' ') ?? '';
}

/** Numeric employee evidence only; PDL buckets and Schema.org values share this reader. */
export function readHeEngEmployeeRange(value: unknown): HeEngEmployeeRange | null {
  const exact = integer(value);
  if (exact !== null) return { min: exact, max: exact };
  const object = record(value);
  if (object) {
    if (object.value !== undefined) {
      const declared = readHeEngEmployeeRange(object.value);
      if (!declared) return null;
      const min = object.minValue === undefined ? null : integer(object.minValue);
      const max = object.maxValue === undefined ? null : integer(object.maxValue);
      if ((object.minValue !== undefined && (min === null || declared.min < min)) ||
          (object.maxValue !== undefined && (max === null || declared.max === null || declared.max > max))) return null;
      return declared;
    }
    const min = integer(object.minValue);
    const max = integer(object.maxValue);
    return min !== null && max !== null && max >= min ? { min, max } : null;
  }
  const raw = text(value).replace(/[–—]/g, '-');
  const between = /^(\d[\d,]*)\s*-\s*(\d[\d,]*)$/.exec(raw);
  if (between) {
    const min = integer(between[1]); const max = integer(between[2]);
    return min !== null && max !== null && min <= max ? { min, max } : null;
  }
  const above = /^(\d[\d,]*)\s*\+$/.exec(raw);
  const min = above ? integer(above[1]) : null;
  return min === null ? null : { min, max: null };
}

function employeeConstraint(raw: string): HeEngEmployeeRange | null {
  let value = raw.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim()
    .replace(/^(?:company size|employees?|headcount|staff)\s*:\s*/, '')
    .replace(/\s*(?:employees?|staff|people|headcount)\s*$/, '');
  const atLeast = /^(?:at least|no fewer than|minimum|min\.?|>=|≥)\s*(\d[\d,]*)$/.exec(value);
  if (atLeast) value = `${atLeast[1]}+`;
  const orMore = /^(\d[\d,]*)\s*(?:or more|and above)$/.exec(value);
  if (orMore) value = `${orMore[1]}+`;
  const strictMin = /^(?:more than|greater than|over|>)\s*(\d[\d,]*)$/.exec(value);
  if (strictMin) {
    const n = integer(strictMin[1]);
    return n === null ? null : { min: n + 1, max: null };
  }
  const strictMax = /^(?:less than|fewer than|under|<)\s*(\d[\d,]*)$/.exec(value);
  if (strictMax) {
    const n = integer(strictMax[1]);
    return n === null || n === 0 ? null : { min: 0, max: n - 1 };
  }
  const max = /^(?:up to|no more than|maximum|max\.?|<=|≤)\s*(\d[\d,]*)$/.exec(value);
  if (max) {
    const n = integer(max[1]);
    return n === null ? null : { min: 0, max: n };
  }
  const between = /^between\s+(\d[\d,]*)\s+and\s+(\d[\d,]*)$/.exec(value);
  return readHeEngEmployeeRange(between ? `${between[1]}-${between[2]}` : value);
}

/** Unrecognized explicit size restrictions are not silently removed for web search. */
function hypothesisEmployeeRanges(hypothesis: { title?: string; description?: string }): { valid: boolean; ranges: HeEngEmployeeRange[] } {
  const relation = /\b(?:serving|selling\s+to|supplying(?:\s+to)?|supporting|targeting|for|whose\s+(?:clients|customers)|(?:their|its)\s+(?:clients|customers))\b/i;
  const rangePattern = /((?:(?:at least|up to|no fewer than|no more than|more than|greater than|over|less than|fewer than|under|minimum|maximum|min\.?|max\.?)\s+|[<>]=?\s*|[≥≤]\s*)?\d[\d,]*(?:\s*[–—-]\s*\d[\d,]*|\s*\+|\s+(?:or more|and above))?|between\s+\d[\d,]*\s+and\s+\d[\d,]*)\s*(?:employees?|staff|people|headcount)\b/gi;
  const audience = (hypothesis.title ?? '').split(relation)[0].toLowerCase().replace(/\([^)]*\)|\d[^,;]*/g, ' ')
    .match(/[a-z]+/g)?.join(' ').replace(/\s+(?:with|having|employing|has|have|employs?)$/, '') ?? '';
  const audienceNoun = audience.split(' ').at(-1) ?? '';
  const specificNouns = new Set(['vendors', 'providers', 'manufacturers', 'administrators', 'banks', 'insurers', 'hospitals',
    'clinics', 'practices', 'carriers', 'operators', 'funds', 'managers', 'consultancies', 'consultants', 'integrators', 'hotels']);
  const explicitTarget = (clause: string) => {
    const start = clause.toLowerCase().replace(/^(?:the|these|those)\s+/, '').trim();
    return /^(?:target|selected|prospect|candidate)\s+(?:companies|firms|organizations|organisations|businesses|entities)\b/.test(start) ||
      /^target audience\b/.test(start) ||
      (!!audience && start.startsWith(`${audience} `)) ||
      (specificNouns.has(audienceNoun) && start.startsWith(`${audienceNoun} `));
  };
  const ranges: HeEngEmployeeRange[] = [];
  for (const raw of [hypothesis.title, hypothesis.description]) {
    let customerContext = false;
    const clauses = (raw ?? '').replace(/\b(min|max)\.\s*/gi, '$1 ').split(/[.;!?]+/).map(value => value.trim()).filter(Boolean);
    for (const clause of clauses) {
      const link = relation.exec(clause);
      const explicitCustomer = /^(?:(?:their|its|these|those|the)\s+)?(?:clients|customers)\b/i.test(clause);
      const target = explicitTarget(clause) || !customerContext && !explicitCustomer;
      const matches = [...clause.matchAll(rangePattern)];
      if (!matches.length && /\d[^.;]{0,30}\b(?:employees?|staff|people|headcount)\b/i.test(clause)) return { valid: false, ranges: [] };
      for (const match of matches) {
        const afterRelation = link && match.index! >= link.index + link[0].length;
        if (afterRelation || explicitCustomer) {
          const between = clause.slice(afterRelation ? link!.index + link![0].length : 0, match.index);
          if (afterRelation && !/[a-z]/i.test(clause.slice(0, link!.index))) return { valid: false, ranges: [] };
          // The size must syntactically belong to the customer named after the
          // relationship. A comma or pronoun-only continuation can refer back
          // to the target; silently dropping that size would widen collection.
          if (/[,;:]/.test(between) || !/\b(?:with|having|employing|has|have|employs?)\s+(?:(?:at least|up to|no fewer than|no more than|more than|greater than|over|less than|fewer than|under|minimum|maximum|min|max)\s+)?$/i.test(between)) {
            return { valid: false, ranges: [] };
          }
          continue;
        }
        if (!target) return { valid: false, ranges: [] };
        const range = employeeConstraint(match[1]);
        if (!range) return { valid: false, ranges: [] };
        ranges.push(range);
      }
      customerContext = !!link || explicitCustomer || (customerContext && !explicitTarget(clause));
    }
  }
  return { valid: true, ranges };
}

export function heEngSearchEmployeeConstraint(scope: HeEngSearchEvidenceScope): {
  valid: boolean; range: HeEngEmployeeRange | null;
} {
  const size = readHeIcpFrame(scope.icp)?.size ?? '';
  const global = size ? employeeConstraint(size) : null;
  if (size && !global) return { valid: false, range: null };
  const alternatives: HeEngEmployeeRange[] = [];
  for (const hypothesis of scope.hypotheses) {
    const parsed = hypothesisEmployeeRanges(hypothesis);
    if (!parsed.valid) return { valid: false, range: null };
    const unique = [...new Map(parsed.ranges.map(range => [JSON.stringify(range), range])).values()];
    if (unique.length > 1) return { valid: false, range: null };
    if (unique[0]) alternatives.push(unique[0]);
  }
  const distinct = new Map(alternatives.map(range => [JSON.stringify(range), range]));
  if (distinct.size > 1) return { valid: false, range: null };
  const selected = alternatives[0] ?? null;
  if (!global) return { valid: true, range: selected };
  if (!selected) return { valid: true, range: global };
  const min = Math.max(global.min, selected.min);
  const maxima = [global.max, selected.max].filter((n): n is number => n !== null);
  const max = maxima.length ? Math.min(...maxima) : null;
  return { valid: max === null || min <= max, range: { min, max } };
}

function satisfiesSize(value: HeEngEmployeeRange | null, expected: HeEngEmployeeRange | null): 'match' | 'unknown' | 'outside' {
  if (!expected) return 'match';
  if (!value) return 'unknown';
  if ((value.max !== null && value.max < expected.min) || (expected.max !== null && value.min > expected.max)) return 'outside';
  return value.min >= expected.min && (expected.max === null || (value.max !== null && value.max <= expected.max)) ? 'match' : 'unknown';
}

function catalogVariants(website: string): string[] {
  const site = host(website);
  if (!site) return [];
  return [...new Set([site, `www.${site}`].flatMap(domain => [domain, `${domain}/`, `https://${domain}`, `https://${domain}/`, `http://${domain}`, `http://${domain}/`]))];
}

function ownOrganizationFactsMatching(
  page: OfficialPage,
  companyWebsite: string,
  matchesOrganization: (org: Row, name: string) => boolean,
): { name: string; employees: HeEngEmployeeRange | null } | null {
  const found: Array<{ name: string; employees: HeEngEmployeeRange | null }> = [];
  let visited = 0;
  const typeList = (raw: unknown) => (Array.isArray(raw) ? raw : [raw]).map(item => text(item).replace(/^https?:\/\/schema\.org\//, ''));
  const walk = (raw: unknown, depth: number): void => {
    if (depth > 12 || ++visited > 2000) return;
    if (Array.isArray(raw)) { raw.slice(0, 200).forEach(value => walk(value, depth + 1)); return; }
    const org = record(raw);
    if (!org) return;
    let ownUrl: string | null = null;
    try { ownUrl = new URL(text(org.url, 2048), page.url).href; } catch { /* No own Organization URL. */ }
    if (text(org.url) && ownUrl && host(ownUrl) === host(companyWebsite) && typeList(org['@type']).some(type => HE_ENG_OWN_ORGANIZATION_TYPES.has(type))) {
      const name = text(org.legalName) || text(org.name);
      if (name && matchesOrganization(org, name)) found.push({ name, employees: readHeEngEmployeeRange(org.numberOfEmployees) });
    }
    for (const [key, value] of Object.entries(org)) if (key !== '@context') walk(value, depth + 1);
  };
  for (const script of page.html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (!/\btype\s*=\s*(["'])application\/ld\+json\1/i.test(script[1]) || script[2].length > 256_000) continue;
    try { walk(JSON.parse(script[2]), 0); } catch { /* Invalid JSON proves no identity/headcount. */ }
  }
  const distinct = [...new Map(found.map(value => [JSON.stringify(value), value])).values()];
  return distinct.length === 1 ? distinct[0] : null;
}

function ownOrganizationFacts(page: OfficialPage, evidence: HeEngOfficialCountryEvidence): { name: string; employees: HeEngEmployeeRange | null } | null {
  return ownOrganizationFactsMatching(page, evidence.companyWebsite, org => {
    const addresses = Array.isArray(org.address) ? org.address : [org.address];
    // Headcount belongs to the same Organization that supplied the address,
    // never another entity in the page's graph (parent, tenant, or customer).
    return addresses.some(value => {
      const address = record(value);
      const types = address && (Array.isArray(address['@type']) ? address['@type'] : [address['@type']]);
      return address && types?.some(type => text(type).replace(/^https?:\/\/schema\.org\//, '') === 'PostalAddress') &&
        text(address.streetAddress) === evidence.sourcePostalAddress.streetAddress &&
        text(address.addressLocality) === evidence.sourcePostalAddress.addressLocality &&
        text(address.postalCode) === evidence.sourcePostalAddress.postalCode &&
        structuredCountry(address.addressCountry) === evidence.country;
    });
  });
}

function employeeRangeText(range: HeEngEmployeeRange | null): string {
  return range ? range.max === null ? `${range.min}+` : range.min === range.max ? String(range.min) : `${range.min}-${range.max}` : '';
}

function interruption(ctx: HeStageContext, error: unknown): void {
  heStageSignal(ctx)?.throwIfAborted();
  if (error && typeof error === 'object' && (error as { heJobInterruption?: unknown }).heJobInterruption === true) throw error;
}

async function officialPage(ctx: HeStageContext, url: string, parent: AbortSignal | undefined): Promise<OfficialPage | null> {
  const expected = host(url);
  if (!expected) return null;
  return withHeDeadline('ENG search company address', 12_000, parent, async signal => {
    const baseGuard = createUsWebsiteFetchGuard({ maxRedirects: 5 });
    const guard = { ...baseGuard, preferHttpsRedirects: true,
      checkUrl: async (target: URL) => {
        if (host(target.href) !== expected) throw new Error('ENG company address redirect changed the website.');
        await baseGuard.checkUrl(target);
      } };
    const init: RequestInit & { dispatcher?: typeof guard.directDispatcher } = {
      method: 'GET', redirect: 'manual', signal, dispatcher: guard.directDispatcher,
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': WEBSITE_ACCEPT_LANGUAGE_EN },
    };
    const response = await fetchFollowingGuarded(url, init, guard, signal);
    if (!response.res.ok || !/text\/html|application\/xhtml\+xml/i.test(response.res.headers.get('content-type') ?? '')) {
      await response.res.body?.cancel();
      return null;
    }
    const html = new TextDecoder().decode(await readBodyCapped(response.res, MAX_PAGE_BYTES, response.url));
    signal.throwIfAborted();
    ctx.onActivity?.();
    return { url: response.url, html };
  });
}

// The registry path shares these bounded readers without changing web-search
// admission rules or importing any RU/internal Vertical Engine behavior.
export {
  officialPage as fetchHeEngOfficialCompanyPage,
  ownOrganizationFacts as readHeEngOfficialOrganizationFacts,
  satisfiesSize as heEngEmployeeRangeFit,
};

/**
 * Search locates a website only. Country and size come from an exact catalog
 * identity or the company's own structured data; every admitted candidate still
 * needs the normal activity qualification and per-address email validation.
 */
export async function resolveHeEngSearchCompanyEvidence(
  ctx: HeStageContext,
  candidate: HeEngCompanySearchCandidate,
  scope: HeEngSearchEvidenceScope,
  reads: HeEngSearchCompanyEvidenceReads = {},
): Promise<HeEngSearchCompanyEvidenceResult> {
  const audit = createHeEngSourceEvidenceAudit('web_search');
  const finish = (result: Omit<HeEngSearchCompanyEvidenceResult, 'audit'>): HeEngSearchCompanyEvidenceResult => ({ ...result, audit });
  const companyHost = host(candidate.website);
  if (!companyHost) return finish({ row: null, reason: 'invalid_website' });
  const size = heEngSearchEmployeeConstraint(scope);
  if (!size.valid) return finish({ row: null, reason: 'size_scope_ambiguous' });
  const countries = scope.allowedCountries.map(normalizeEngCountry);
  if (!countries.length || countries.some(country => !country)) return finish({ row: null, reason: 'country_unconfirmed' });
  const allowed = countries as string[];
  const signal = heStageSignal(ctx);
  signal?.throwIfAborted();
  const variants = catalogVariants(candidate.website);
  let catalogRows: Row[] = [];
  try {
    catalogRows = await withHeDeadline('ENG exact company catalog lookup', 10_000, signal, async lookupSignal => {
      if (reads.catalog) return reads.catalog(variants, lookupSignal);
      const result = await ctx.supabase.from('pdl_companies')
        .select('id,name,website,country,region,locality,industry,size,description')
        .in('website', variants).limit(MAX_CATALOG_MATCHES + 1).abortSignal(lookupSignal);
      if (result.error) throw new Error('ENG exact company catalog lookup failed.');
      return Array.isArray(result.data) ? result.data : [];
    });
  } catch (error) { interruption(ctx, error); }
  ctx.onActivity?.();
  const exact = catalogRows.filter(row => host(row.website) === companyHost && text(row.name));
  audit.catalogMatches = exact.length;
  // Use the same ISO/name normalization as country proofs: distinct GB/IE rows
  // must not collapse into one identity just because neither is a display name.
  const identities = new Map(exact.map(row => [JSON.stringify([text(row.name).toLowerCase(), structuredCountry(row.country), text(row.size)]), row]));
  const catalog = catalogRows.length <= MAX_CATALOG_MATCHES && identities.size === 1 ? [...identities.values()][0] : null;
  const catalogSize = catalog ? readHeEngEmployeeRange(catalog.size) : null;
  const sizeFit = satisfiesSize(catalogSize, size.range);
  let catalogCountryRow: Row | null = null;
  if (catalog) {
    const row = withHeEngSourceCountry({ company: text(catalog.name), website: text(catalog.website, 2048),
      address: [catalog.locality, catalog.region, catalog.country].map(value => text(value)).filter(Boolean).join(', '),
      category: text(catalog.industry), employees: text(catalog.size), source_detail: 'eng_search:pdl',
      _eng_source_description: text(catalog.description, 1200),
    }, { source: 'pdl', sourceName: catalog.name, sourceWebsite: catalog.website, country: catalog.country, id: catalog.id });
    const proof = readHeEngSourceCountry(row);
    if (proof) {
      audit.countrySource = 'pdl';
      audit.country = proof.country;
      if (allowed.includes(proof.country)) catalogCountryRow = row;
    }
  }
  if (catalogCountryRow && sizeFit === 'match') {
    return finish({ row: catalogCountryRow, reason: 'confirmed_catalog', countrySource: 'pdl' });
  }
  // A group may have its catalog headquarters elsewhere. Only its own proven
  // address in an allowed country can establish local presence here.
  const queue = [`https://${companyHost}/`];
  const seen = new Set<string>();
  let lastReason: HeEngSearchEvidenceReason = 'website_unavailable';
  while (queue.length && seen.size < MAX_OFFICIAL_PAGES) {
    signal?.throwIfAborted();
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    let page: OfficialPage | null;
    try {
      page = reads.page
        ? await withHeDeadline('ENG search company address', 12_000, signal, pageSignal => reads.page!(url, pageSignal))
        : await officialPage(ctx, url, signal);
    } catch (error) { interruption(ctx, error); recordHeEngSourcePageAudit(audit, url, null); continue; }
    ctx.onActivity?.();
    const pageAudit = recordHeEngSourcePageAudit(audit, url, page);
    if (!page || !page.url.startsWith('https:') || host(page.url) !== companyHost || page.html.length > MAX_PAGE_BYTES) continue;
    lastReason = catalogCountryRow ? 'identity_unconfirmed' : 'country_unconfirmed';
    if (catalogCountryRow && catalog) {
      // Country is already a provider fact for this exact entity and website.
      // Resolve only the missing headcount; no second postal address is needed.
      const facts = ownOrganizationFactsMatching(page, candidate.website,
        (_org, name) => companyNameKey(name) === companyNameKey(catalog.name));
      pageAudit.identity = Boolean(facts);
      pageAudit.country = audit.country;
      if (facts) {
        const employeeRange = facts.employees ?? catalogSize;
        const fit = satisfiesSize(employeeRange, size.range);
        pageAudit.employeeFit = fit;
        if (fit === 'match') return finish({ row: { ...catalogCountryRow, employees: employeeRangeText(employeeRange) },
          reason: 'confirmed_catalog', countrySource: 'pdl' });
        lastReason = fit === 'outside' ? 'outside_size' : 'size_unconfirmed';
      }
    }
    const evidence = extractHeEngOfficialCountryEvidence({ companyWebsite: candidate.website, pageUrl: page.url, html: page.html, allowedCountries: allowed });
    if (evidence) {
      const facts = ownOrganizationFacts(page, evidence);
      pageAudit.identity = Boolean(facts);
      pageAudit.country = evidence.country;
      if (!facts) lastReason = 'identity_unconfirmed';
      else {
        const employeeRange = facts.employees ?? (catalog && companyNameKey(catalog.name) === companyNameKey(facts.name) ? catalogSize : null);
        const fit = satisfiesSize(employeeRange, size.range);
        pageAudit.employeeFit = fit;
        if (fit !== 'match') lastReason = fit === 'outside' ? 'outside_size' : 'size_unconfirmed';
        else {
          const row = withHeEngSourceCountry({ company: facts.name, website: evidence.companyWebsite,
            address: evidence.sourceAddress, employees: employeeRangeText(employeeRange), source_detail: 'eng_search:company_website',
          }, { source: 'company_website', sourceName: facts.name, sourceWebsite: evidence.companyWebsite,
            country: evidence.sourceCountry, address: evidence.sourceAddress, page: evidence.pageUrl,
            organizationWebsite: evidence.sourceOrganizationWebsite, postalAddress: evidence.sourcePostalAddress });
          if (readHeEngSourceCountry(row)) {
            audit.countrySource = 'company_website';
            audit.country = evidence.country;
            return finish({ row, reason: 'confirmed_website', countrySource: 'company_website' });
          }
        }
      }
    }
    if (seen.size === 1) {
      for (const link of discoverContactLinks(page.html, page.url)) {
        if (host(link) === companyHost && link.startsWith('https:') && !seen.has(link)) queue.push(link);
        if (queue.length >= MAX_OFFICIAL_PAGES - 1) break;
      }
    }
  }
  return finish({ row: null, reason: lastReason });
}
