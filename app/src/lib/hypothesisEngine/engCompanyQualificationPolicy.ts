import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { companySiteAlias } from '@/lib/enrich/companySiteAlias';
import { heCompanySiteIdentity } from './collectionIdentity';
import { normalizeEngCountry, readHeCollectCountries } from './engCountries';
import { HE_ENG_COMPANY_QUALIFICATION_VERSION, type HeEngCompanyQualificationVersion } from './engCompanyQualificationVersion';
import type { HeEngQualificationBudget } from './engQualificationBudget';
import type { HeEngCompanyFitDecision } from './engCompanyFit';
import type { HeEngCompanySearchCandidate, HeEngCompanySearchCheckpoint, HeEngCompanySearchPlan } from './engCompanySearch';
import { heEngCompanyCountryProofValid, readHeEngSourceCountry } from './engCompanyCountry';

export { HE_ENG_COMPANY_QUALIFICATION_VERSION } from './engCompanyQualificationVersion';

export interface HeEngQualificationScope {
  /** v2 snapshots predate this field; every new source-country snapshot sets 3. */
  version?: HeEngCompanyQualificationVersion;
  key: string;
  projectId: string;
  verticalId: string;
  hypotheses: Array<{ id: string; title: string; description: string }>;
  countries: string[];
  countryPolicy: 'qualified_local_entity' | 'source_country';
  /** Customer targeting constraints are data, never model instructions. */
  icp: unknown;
}

export interface HeEngCompanyEvidence {
  kind: 'identity' | 'activity' | 'country';
  url: string;
  quote: string;
}

/** Server-only input from this base's verified constructor job, never a grid/CSV description. */
export interface HeEngCollectedCompanyEvidence {
  version: 1;
  source: 'constructor_website';
  jobId: string;
  company: string;
  website: string;
  /** Actual page URLs captured by the constructor, after its same-site redirect checks. */
  pages: Array<{ url: string; text: string; truncated?: boolean }>;
}

export interface HeEngCompanyQualificationAudit {
  version: 1;
  /** Exact bounded classifier input, or cited passages when compaction is present. */
  quotes: Array<{ id: string; url: string; text: string; source: 'constructor_website' | 'website' }>;
  /** New adaptive bases compact finished waves, preserving every decision citation. */
  compaction?: {
    version: 1;
    strategy: 'decision_quotes';
    originalQuoteCount: number;
    originalQuotesSha256: string;
  };
  collectedJobId?: string;
  classifier?: HeEngCompanyQualificationAssessment;
  review?: HeEngCompanyQualificationAssessment;
}

export interface HeEngCompanyQualificationAssessment {
  model: string;
  status: HeEngCompanyFitDecision['status'];
  reason: string;
  hypothesisId: string | null;
  /** Missing in older audits; preserves the exact exclusion selected by each assessment. */
  exclusionCause?: HeEngCompanyFitDecision['exclusionCause'];
  quoteIds: string[];
  explanation: string;
}

export interface HeEngCompanyVerdict {
  version: HeEngCompanyQualificationVersion;
  scopeKey: string;
  companyKey: string;
  status: 'accepted' | 'rejected' | 'unverified';
  reason: string;
  country: string | null;
  hypothesisId: string | null;
  evidence: HeEngCompanyEvidence[];
  checkedAt: string;
  /** v3 only: trusted source provenance, validated independently of model output. */
  countryProof?: unknown;
  /** v3 only: an independent reviewer confirmed the selected activity evidence. */
  fitReview?: { model: 'openai/gpt-5-mini'; status: 'match'; hypothesisId: string };
  /**
   * v3 only, instead of fitReview: the catalogue industry itself names the
   * hypothesis and the company's own site gave the models no evidence either
   * way (see heEngCatalogDirectHypothesis). Softer than the two-model match.
   */
  catalogFit?: { source: 'pdl'; industry: string; hypothesisId: string };
  /**
   * The catalogue domain no longer exists or is parked; the activity evidence
   * comes from this current site of the same brand (companySiteAlias), found
   * by one paid search. row.website stays the catalogue site: it keys the
   * verdict and the source-country proof. The constructor crawls this site.
   */
  currentWebsite?: string;
  audit?: HeEngCompanyQualificationAudit;
}

/** One paid search for a dead or parked catalogue site; durable before and after the call. */
export interface HeEngCatalogSiteSearch {
  plan: HeEngCompanySearchPlan;
  checkpoint: HeEngCompanySearchCheckpoint;
  candidates: HeEngCompanySearchCandidate[];
}

export interface HeEngQualificationMemo {
  version: HeEngCompanyQualificationVersion;
  scopeKey: string;
  verdicts: Record<string, HeEngCompanyVerdict>;
  /** Retryable failures are progress, not a permanent company verdict. */
  attempts?: Record<string, HeEngQualificationAttempt>;
  /** Reuse a paid decision only when a partial website retry has identical inputs. */
  partial?: Record<string, { inputHash: string; verdict: HeEngCompanyVerdict }>;
  /** Execution progress only: it never replaces the versioned company proof. */
  economy?: {
    version: 1;
    workflow?: 'fit_review_v3' | 'fit_review_v3_single';
    budget: HeEngQualificationBudget;
    /** First paid decision is durable before independent review. */
    proposals?: Record<string, HeEngCompanyFitDecision>;
    /** Bounded current batch; terminal verdicts retain selected input in audit. */
    prepared: Record<string, {
      website: string;
      pages: Array<{ url: string; text: string; evidenceSource?: 'constructor_website' | 'website' }>;
      retryableFailure: boolean;
      collectedJobId?: string;
      /** Missing = legacy paid quote IDs; v2 retains every long-paragraph segment. */
      excerptVersion?: 2;
      /** Present only when a page came from a same-brand domain (companySiteAlias). */
      company?: string;
      /** The pages were read from this same-brand site found by search (see HeEngCompanyVerdict). */
      currentWebsite?: string;
    }>;
    /** Searches for the current site of a dead or parked catalogue site, by company key. */
    siteSearches?: Record<string, HeEngCatalogSiteSearch>;
    /** Written before 2026-10-23 (one request at a time); read only, never written. */
    inFlight?: HeEngQualificationInFlight;
    /** Durable before each request; a missing response must not buy it again. */
    inFlights?: HeEngQualificationInFlight[];
  };
}

export interface HeEngQualificationInFlight {
  reservationId: string;
  companyKeys: string[];
  phase?: 'classifier' | 'review';
}

export interface HeEngQualificationAttempt {
  attempts: number;
  kind: 'site_transient' | 'model_transient' | 'model_invalid' | 'site_unavailable';
}

/** A retry cannot repair changed or missing paid criteria. Never pay again implicitly. */
export class HeEngQualificationScopeError extends Error {
  readonly heJobTerminal = true as const;

  constructor(reason: string) {
    super(`ENG company qualification: ${reason}. Review the audience and collect a new base.`);
    this.name = 'HeEngQualificationScopeError';
  }
}

export interface HeEngQualificationRow {
  company?: unknown;
  website?: unknown;
  /** Catalogue industry of a pdl row (pdl_companies.industry). */
  category?: unknown;
  source_detail?: unknown;
  _eng_company_qualification?: unknown;
  _eng_source_country?: unknown;
}

/**
 * Catalogue industries narrow enough to stand for a hypothesis named after
 * them, with the title words that name it. A broad industry («financial
 * services») never does: fund administrators and payments firms sit inside it
 * with everyone else. Fund management companies (ManCos) are a distinct
 * activity from investment management and are not matched here.
 */
const CATALOG_DIRECT_INDUSTRIES: Readonly<Record<string, readonly string[]>> = {
  insurance: ['insurer', 'insurance', 'insurtech', 'reinsur', 'underwrit'],
  banking: ['bank'],
  'investment management': ['asset manag', 'investment manag', 'wealth manag'],
};

/**
 * Owner decision 2026-10-23 («мягче проверка при прямом совпадении отрасли»):
 * a pdl company whose industry directly names a selected hypothesis is
 * accepted when its own site gave the models too little to decide. The
 * hypothesis it names, or null. Explicit contrary evidence still rejects.
 */
export function heEngCatalogDirectHypothesis(
  row: HeEngQualificationRow, scope: Pick<HeEngQualificationScope, 'hypotheses'>,
): { hypothesisId: string; industry: string } | null {
  if (row.source_detail !== 'pdl' || typeof row.category !== 'string') return null;
  const industry = row.category.trim().toLowerCase();
  const words = Object.hasOwn(CATALOG_DIRECT_INDUSTRIES, industry) ? CATALOG_DIRECT_INDUSTRIES[industry] : undefined;
  const hypothesis = words && scope.hypotheses.find((h) => words.some((word) => h.title.toLowerCase().includes(word)));
  return hypothesis ? { hypothesisId: hypothesis.id, industry } : null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function heEngQualificationVersion(scope: Pick<HeEngQualificationScope, 'version' | 'countryPolicy'>): HeEngCompanyQualificationVersion | null {
  if ((scope.version === undefined || scope.version === 2) && scope.countryPolicy === 'qualified_local_entity') return 2;
  return scope.version === 3 && scope.countryPolicy === 'source_country' ? 3 : null;
}

function scopeKey(scope: Omit<HeEngQualificationScope, 'key'>): string {
  const version = heEngQualificationVersion(scope);
  if (!version) throw new HeEngQualificationScopeError('criteria version is invalid');
  return digest({ version, projectId: scope.projectId, verticalId: scope.verticalId,
    hypotheses: scope.hypotheses, countries: scope.countries, countryPolicy: scope.countryPolicy, icp: scope.icp });
}

/** JSON stored by this stage must be self-consistent before it can authorize paid work. */
function frozenScope(raw: unknown, projectId: string, verticalId: string): HeEngQualificationScope {
  const scope = raw as Partial<HeEngQualificationScope> | null;
  // v2 snapshots predate an explicit version field. Their original hash and
  // country policy remain authoritative; never stamp them as a v3 decision.
  const version = scope?.version ?? (scope?.countryPolicy === 'qualified_local_entity' ? 2 : undefined);
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
      scope.projectId !== projectId || scope.verticalId !== verticalId ||
      !((version === 2 && scope.countryPolicy === 'qualified_local_entity') ||
        (version === 3 && scope.countryPolicy === 'source_country')) ||
      typeof scope.key !== 'string' || !Object.hasOwn(scope, 'icp') ||
      !Array.isArray(scope.hypotheses) || scope.hypotheses.length === 0 ||
      scope.hypotheses.some((h) => !h || typeof h.id !== 'string' || !h.id ||
        typeof h.title !== 'string' || !h.title.trim() || typeof h.description !== 'string') ||
      new Set(scope.hypotheses.map((h) => h.id)).size !== scope.hypotheses.length ||
      !Array.isArray(scope.countries) || scope.countries.some((c) => typeof c !== 'string' || normalizeEngCountry(c) !== c) ||
      new Set(scope.countries).size !== scope.countries.length) {
    throw new HeEngQualificationScopeError('saved criteria are invalid');
  }
  const criteria = { version: version as HeEngCompanyQualificationVersion, projectId, verticalId,
    hypotheses: scope.hypotheses, countries: scope.countries,
    countryPolicy: scope.countryPolicy as HeEngQualificationScope['countryPolicy'], icp: scope.icp };
  if (scopeKey(criteria) !== scope.key) throw new HeEngQualificationScopeError('saved criteria do not match their fingerprint');
  return { key: scope.key, ...criteria };
}

function assertMemoScope(info: Record<string, unknown>, scope: HeEngQualificationScope): void {
  if (!Object.hasOwn(info, 'eng_company_qualification')) return;
  const memo = info.eng_company_qualification as Partial<HeEngQualificationMemo> | null;
  if (!memo || memo.version !== heEngQualificationVersion(scope) || memo.scopeKey !== scope.key ||
      !memo.verdicts || typeof memo.verdicts !== 'object' || Array.isArray(memo.verdicts)) {
    throw new HeEngQualificationScopeError('saved progress uses different or invalid criteria');
  }
}

export function heEngCompanyKey(row: HeEngQualificationRow): string {
  const company = typeof row.company === 'string' ? row.company.trim().toLowerCase().replace(/\s+/g, ' ') : '';
  const website = typeof row.website === 'string' ? row.website.trim() : '';
  const identity = heCompanySiteIdentity(website);
  return digest([company, identity?.host ?? website.toLowerCase()]);
}

/** Call only after the existing project-owner check confirms an ENG client. */
export async function readHeEngQualificationScope(
  db: SupabaseClient,
  input: {
    project: { id: string; brief?: Record<string, unknown> | null };
    verticalId: string;
    collectInfo?: object | null;
    /** Collection resumes its paid snapshot; audience use must still match current criteria. */
    mode?: 'collection';
  },
): Promise<HeEngQualificationScope> {
  const { project, verticalId } = input;
  const info = (input.collectInfo ?? {}) as Record<string, unknown>;
  const saved = Object.hasOwn(info, 'eng_company_qualification_scope')
    ? frozenScope(info.eng_company_qualification_scope, project.id, verticalId)
    : null;
  if (saved) {
    assertMemoScope(info, saved);
    if (input.mode === 'collection') return saved;
  }
  const { data, error } = await db.from('he_hypotheses')
    .select('id,title,description,status')
    .eq('project_id', project.id).eq('vertical_id', verticalId).neq('status', 'rejected');
  if (error) throw new Error(`ENG company qualification: hypotheses could not be read: ${error.message}`);
  let candidates = (data ?? []) as Array<{ id: string; title: string; description: string | null; status: string | null }>;
  // The plan records the exact hypotheses used. Never broaden to the whole
  // vertical when one selected hypothesis disappears or is rejected later.
  const idsValue = Object.hasOwn(info, 'hypotheses')
    ? (Array.isArray(info.hypotheses)
      ? info.hypotheses.map((h) => h && typeof h === 'object' ? (h as { id?: unknown }).id : null)
      : [])
    : info.hypothesis_ids;
  if (idsValue !== undefined && idsValue !== null) {
    if (!Array.isArray(idsValue) || idsValue.length === 0 || idsValue.some((id) => typeof id !== 'string' || !id)) {
      throw new HeEngQualificationScopeError('selected hypotheses are invalid');
    }
    const ids = new Set(idsValue as string[]);
    candidates = candidates.filter((h) => ids.has(h.id));
    if (candidates.length !== ids.size) {
      throw new HeEngQualificationScopeError('selected hypotheses changed');
    }
  } else {
    const accepted = candidates.filter((h) => h.status === 'accepted');
    if (accepted.length) candidates = accepted;
  }
  if (!candidates.length || candidates.some((h) => !h.title?.trim())) {
    throw new HeEngQualificationScopeError('no selected hypotheses');
  }
  const hypotheses = candidates.map((h) => ({ id: h.id, title: h.title, description: h.description ?? '' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const rawCountries = Object.hasOwn(info, 'countries') ? info.countries : project.brief?.collect_countries;
  if (rawCountries !== undefined && rawCountries !== null &&
      (!Array.isArray(rawCountries) || rawCountries.some((c) => typeof c !== 'string' || !c.trim()))) {
    throw new HeEngQualificationScopeError('target countries are invalid');
  }
  const countries = readHeCollectCountries(rawCountries).countries;
  if (countries.some((c) => normalizeEngCountry(c) !== c)) {
    throw new HeEngQualificationScopeError('target countries are invalid');
  }
  const icp = project.brief?.icp ?? null;
  // Audience checks of a historical base compare its current criteria under
  // the same policy/hash version. A rollout alone must not revoke its launch.
  const legacyMemo = info.eng_company_qualification as Partial<HeEngQualificationMemo> | null | undefined;
  const version = saved?.version ?? (legacyMemo?.version === 2 ? 2 : HE_ENG_COMPANY_QUALIFICATION_VERSION);
  const criteria = { version,
    projectId: project.id, verticalId, hypotheses, countries,
    countryPolicy: saved?.countryPolicy ?? (version === 2 ? 'qualified_local_entity' : 'source_country') as HeEngQualificationScope['countryPolicy'], icp };
  const current = { key: scopeKey(criteria), ...criteria };
  if (saved && saved.key !== current.key) throw new HeEngQualificationScopeError('the audience criteria changed after collection');
  // A legacy memo has no full snapshot. It can be adopted only when its exact
  // fingerprint still matches; changing criteria must never silently reset it.
  assertMemoScope(info, current);
  return saved ?? current;
}

/** Evidence belongs to this company AND this exact target, not another base. */
/**
 * The site the constructor should crawl for this row: the verdict's current
 * website when the catalogue domain was dead or parked, else null (crawl
 * row.website). Only a same-brand domain of the catalogue site is returned.
 */
export function heEngConstructWebsite(
  row: HeEngQualificationRow,
  proof: Partial<HeEngCompanyVerdict> | null | undefined = row._eng_company_qualification as Partial<HeEngCompanyVerdict> | null | undefined,
): string | null {
  const current = proof?.currentWebsite;
  const website = typeof row.website === 'string' ? row.website : '';
  const company = typeof row.company === 'string' ? row.company : '';
  if (typeof current !== 'string' || !/^https:\/\//i.test(current) || current.length > 2000 || !company) return null;
  const site = heCompanySiteIdentity(website);
  const found = heCompanySiteIdentity(current);
  return site && found && found.registrable !== site.registrable && companySiteAlias(current, website, company) !== null ? current : null;
}

export function heEngCompanyQualified(row: HeEngQualificationRow, scope: HeEngQualificationScope): boolean {
  const version = heEngQualificationVersion(scope);
  const proof = row._eng_company_qualification as Partial<HeEngCompanyVerdict> | null | undefined;
  if (!version || !proof || proof.version !== version || proof.status !== 'accepted' ||
      proof.scopeKey !== scope.key || proof.companyKey !== heEngCompanyKey(row)) return false;
  const country = normalizeEngCountry(proof.country);
  if (!country || (scope.countries.length > 0 && !scope.countries.includes(country))) return false;
  if (!scope.hypotheses.some((h) => h.id === proof.hypothesisId)) return false;
  if (!Array.isArray(proof.evidence)) return false;
  const website = typeof row.website === 'string' ? row.website : '';
  const site = heCompanySiteIdentity(website);
  if (!site) return false;
  // A found current site must be the same brand as the catalogue site; its
  // pages already pass the evidence check below through the same rule.
  if (proof.currentWebsite !== undefined && heEngConstructWebsite(row, proof) === null) return false;
  if (proof.catalogFit !== undefined) {
    // Softer path: the catalogue industry stands in for the two-model match;
    // the source country is proven exactly as in the v3 path below.
    const direct = heEngCatalogDirectHypothesis(row, scope);
    const fit = proof.catalogFit;
    return version === 3 && scope.countryPolicy === 'source_country' && proof.reason === 'catalog_industry_match' &&
      !proof.fitReview && !!fit && fit.source === 'pdl' && !!direct && fit.industry === direct.industry &&
      fit.hypothesisId === direct.hypothesisId && proof.hypothesisId === direct.hypothesisId &&
      heEngCompanyCountryProofValid(row, proof.countryProof, scope.countries) &&
      readHeEngSourceCountry({ ...row, _eng_source_country: proof.countryProof })?.country === country;
  }
  if (version === 3) {
    const review = proof.fitReview;
    if (scope.countryPolicy !== 'source_country' || review?.model !== 'openai/gpt-5-mini' ||
        review.status !== 'match' || review.hypothesisId !== proof.hypothesisId ||
        !heEngCompanyCountryProofValid(row, proof.countryProof, scope.countries) ||
        readHeEngSourceCountry({ ...row, _eng_source_country: proof.countryProof })?.country !== country) return false;
  }
  // v2 remains exactly the historical site-proof contract. v3 does not invent
  // identity/address quotes: its country provenance has a separate verifier.
  const required = version === 2 ? ['identity', 'activity', 'country'] as const : ['activity'] as const;
  const company = typeof row.company === 'string' ? row.company : '';
  return required.every((kind) => proof.evidence!.some((e) => {
    if (!e || typeof e !== 'object') return false;
    if (e.kind !== kind || typeof e.quote !== 'string' || e.quote.trim().length < 8 || typeof e.url !== 'string') return false;
    const source = heCompanySiteIdentity(e.url);
    // The company's own page may have redirected to a domain of the same brand.
    return !!source && (source.registrable === site.registrable
      || (!!company && companySiteAlias(e.url, website, company) !== null));
  }));
}

/** Every provider upload in this launch passed company qualification. */
export interface HeEngQualifiedLaunchStamp {
  version: HeEngCompanyQualificationVersion;
  scope_key: string;
  base_id: string;
}

export const HE_ENG_COMPANY_QUALIFICATION_REQUIRED =
  'Company qualification is required. Collect a new base and create a new campaign before starting or resuming sending.';

export function heEngQualifiedLaunchStamp(scope: HeEngQualificationScope, baseId: string): HeEngQualifiedLaunchStamp {
  const version = heEngQualificationVersion(scope);
  if (!version) throw new HeEngQualificationScopeError('criteria version is invalid');
  return { version, scope_key: scope.key, base_id: baseId };
}

/** Read raw launch_info: parseLaunchInfo intentionally omits internal metadata. */
export function heEngLaunchQualified(raw: unknown, scope: HeEngQualificationScope, baseId: string): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const stamp = (raw as { eng_company_qualification?: Partial<HeEngQualifiedLaunchStamp> | null }).eng_company_qualification;
  const version = heEngQualificationVersion(scope);
  return !!version && !!stamp && stamp.version === version &&
    stamp.scope_key === scope.key && stamp.base_id === baseId;
}

/** Refill recipients may no longer be in the original base: keep the whole stamped scope safe. */
export function heEngScopeWithinCurrentCountries(
  scope: HeEngQualificationScope,
  brief: Record<string, unknown> | null | undefined,
): boolean {
  const raw = brief?.collect_countries;
  if (raw !== undefined && raw !== null &&
      (!Array.isArray(raw) || raw.some((value) => typeof value !== 'string' || !value.trim()))) return false;
  const current = readHeCollectCountries(raw).countries;
  if (current.some((c) => normalizeEngCountry(c) !== c)) return false;
  return current.length === 0 || (scope.countries.length > 0 && scope.countries.every((c) => current.includes(c)));
}
