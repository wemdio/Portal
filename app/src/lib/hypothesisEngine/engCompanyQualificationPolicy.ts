import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { heCompanySiteIdentity } from './collectionIdentity';
import { normalizeEngCountry, readHeCollectCountries } from './engCountries';
import { HE_ENG_COMPANY_QUALIFICATION_VERSION } from './engCompanyQualificationVersion';

export { HE_ENG_COMPANY_QUALIFICATION_VERSION } from './engCompanyQualificationVersion';

export interface HeEngQualificationScope {
  key: string;
  projectId: string;
  verticalId: string;
  hypotheses: Array<{ id: string; title: string; description: string }>;
  countries: string[];
  countryPolicy: 'qualified_local_entity';
  /** Customer targeting constraints are data, never model instructions. */
  icp: unknown;
}

export interface HeEngCompanyEvidence {
  kind: 'identity' | 'activity' | 'country';
  url: string;
  quote: string;
}

export interface HeEngCompanyVerdict {
  version: typeof HE_ENG_COMPANY_QUALIFICATION_VERSION;
  scopeKey: string;
  companyKey: string;
  status: 'accepted' | 'rejected' | 'unverified';
  reason: string;
  country: string | null;
  hypothesisId: string | null;
  evidence: HeEngCompanyEvidence[];
  checkedAt: string;
}

export interface HeEngQualificationMemo {
  version: typeof HE_ENG_COMPANY_QUALIFICATION_VERSION;
  scopeKey: string;
  verdicts: Record<string, HeEngCompanyVerdict>;
  /** Retryable failures are progress, not a permanent company verdict. */
  attempts?: Record<string, HeEngQualificationAttempt>;
  /** Reuse a paid decision only when a partial website retry has identical inputs. */
  partial?: Record<string, { inputHash: string; verdict: HeEngCompanyVerdict }>;
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
  _eng_company_qualification?: unknown;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function scopeKey(scope: Omit<HeEngQualificationScope, 'key'>): string {
  return digest({ version: HE_ENG_COMPANY_QUALIFICATION_VERSION, ...scope });
}

/** JSON stored by this stage must be self-consistent before it can authorize paid work. */
function frozenScope(raw: unknown, projectId: string, verticalId: string): HeEngQualificationScope {
  const scope = raw as Partial<HeEngQualificationScope> | null;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) ||
      scope.projectId !== projectId || scope.verticalId !== verticalId ||
      scope.countryPolicy !== 'qualified_local_entity' ||
      typeof scope.key !== 'string' || !Object.hasOwn(scope, 'icp') ||
      !Array.isArray(scope.hypotheses) || scope.hypotheses.length === 0 ||
      scope.hypotheses.some((h) => !h || typeof h.id !== 'string' || !h.id ||
        typeof h.title !== 'string' || !h.title.trim() || typeof h.description !== 'string') ||
      new Set(scope.hypotheses.map((h) => h.id)).size !== scope.hypotheses.length ||
      !Array.isArray(scope.countries) || scope.countries.some((c) => typeof c !== 'string' || normalizeEngCountry(c) !== c) ||
      new Set(scope.countries).size !== scope.countries.length) {
    throw new HeEngQualificationScopeError('saved criteria are invalid');
  }
  const criteria = { projectId, verticalId, hypotheses: scope.hypotheses, countries: scope.countries,
    countryPolicy: 'qualified_local_entity' as const, icp: scope.icp };
  if (scopeKey(criteria) !== scope.key) throw new HeEngQualificationScopeError('saved criteria do not match their fingerprint');
  return { key: scope.key, ...criteria };
}

function assertMemoScope(info: Record<string, unknown>, scope: HeEngQualificationScope): void {
  if (!Object.hasOwn(info, 'eng_company_qualification')) return;
  const memo = info.eng_company_qualification as Partial<HeEngQualificationMemo> | null;
  if (!memo || memo.version !== HE_ENG_COMPANY_QUALIFICATION_VERSION || memo.scopeKey !== scope.key ||
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
  const criteria = { projectId: project.id, verticalId, hypotheses, countries,
    countryPolicy: 'qualified_local_entity' as const, icp };
  const current = { key: scopeKey(criteria), ...criteria };
  if (saved && saved.key !== current.key) throw new HeEngQualificationScopeError('the audience criteria changed after collection');
  // A legacy memo has no full snapshot. It can be adopted only when its exact
  // fingerprint still matches; changing criteria must never silently reset it.
  assertMemoScope(info, current);
  return saved ?? current;
}

/** Evidence belongs to this company AND this exact target, not another base. */
export function heEngCompanyQualified(row: HeEngQualificationRow, scope: HeEngQualificationScope): boolean {
  const proof = row._eng_company_qualification as Partial<HeEngCompanyVerdict> | null | undefined;
  if (!proof || proof.version !== HE_ENG_COMPANY_QUALIFICATION_VERSION || proof.status !== 'accepted' ||
      proof.scopeKey !== scope.key || proof.companyKey !== heEngCompanyKey(row)) return false;
  const country = normalizeEngCountry(proof.country);
  if (!country || (scope.countries.length > 0 && !scope.countries.includes(country))) return false;
  if (!scope.hypotheses.some((h) => h.id === proof.hypothesisId)) return false;
  if (!Array.isArray(proof.evidence)) return false;
  const site = heCompanySiteIdentity(typeof row.website === 'string' ? row.website : '');
  if (!site) return false;
  return (['identity', 'activity', 'country'] as const).every((kind) => proof.evidence!.some((e) => {
    if (!e || typeof e !== 'object') return false;
    if (e.kind !== kind || typeof e.quote !== 'string' || e.quote.trim().length < 8 || typeof e.url !== 'string') return false;
    const source = heCompanySiteIdentity(e.url);
    return !!source && source.registrable === site.registrable;
  }));
}

/** Every provider upload in this launch passed company qualification. */
export interface HeEngQualifiedLaunchStamp {
  version: typeof HE_ENG_COMPANY_QUALIFICATION_VERSION;
  scope_key: string;
  base_id: string;
}

export const HE_ENG_COMPANY_QUALIFICATION_REQUIRED =
  'Company qualification is required. Collect a new base and create a new campaign before starting or resuming sending.';

export function heEngQualifiedLaunchStamp(scope: HeEngQualificationScope, baseId: string): HeEngQualifiedLaunchStamp {
  return { version: HE_ENG_COMPANY_QUALIFICATION_VERSION, scope_key: scope.key, base_id: baseId };
}

/** Read raw launch_info: parseLaunchInfo intentionally omits internal metadata. */
export function heEngLaunchQualified(raw: unknown, scope: HeEngQualificationScope, baseId: string): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const stamp = (raw as { eng_company_qualification?: Partial<HeEngQualifiedLaunchStamp> | null }).eng_company_qualification;
  return !!stamp && stamp.version === HE_ENG_COMPANY_QUALIFICATION_VERSION &&
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
