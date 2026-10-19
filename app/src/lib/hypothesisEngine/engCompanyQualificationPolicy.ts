import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { heCompanySiteIdentity } from './collectionIdentity';
import { normalizeEngCountry, readHeCollectCountries } from './engCountries';

export const HE_ENG_COMPANY_QUALIFICATION_VERSION = 1;

export interface HeEngQualificationScope {
  key: string;
  projectId: string;
  verticalId: string;
  hypotheses: Array<{ id: string; title: string; description: string }>;
  countries: string[];
  /** Customer targeting constraints are data, never model instructions. */
  icp: unknown;
}

export interface HeEngCompanyEvidence {
  kind: 'identity' | 'activity' | 'country';
  url: string;
  quote: string;
}

export interface HeEngCompanyVerdict {
  version: 1;
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
  version: 1;
  scopeKey: string;
  verdicts: Record<string, HeEngCompanyVerdict>;
}

export interface HeEngQualificationRow {
  company?: unknown;
  website?: unknown;
  _eng_company_qualification?: unknown;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
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
  },
): Promise<HeEngQualificationScope> {
  const { project, verticalId } = input;
  const info = (input.collectInfo ?? {}) as Record<string, unknown>;
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
      throw new Error('ENG company qualification: selected hypotheses are invalid; collect the base again');
    }
    const ids = new Set(idsValue as string[]);
    candidates = candidates.filter((h) => ids.has(h.id));
    if (candidates.length !== ids.size) {
      throw new Error('ENG company qualification: selected hypotheses changed; collect the base again');
    }
  } else {
    const accepted = candidates.filter((h) => h.status === 'accepted');
    if (accepted.length) candidates = accepted;
  }
  if (!candidates.length || candidates.some((h) => !h.title?.trim())) {
    throw new Error('ENG company qualification: no selected hypotheses; collect the base again');
  }
  const hypotheses = candidates.map((h) => ({ id: h.id, title: h.title, description: h.description ?? '' }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const rawCountries = Object.hasOwn(info, 'countries') ? info.countries : project.brief?.collect_countries;
  if (rawCountries !== undefined && rawCountries !== null &&
      (!Array.isArray(rawCountries) || rawCountries.some((c) => typeof c !== 'string' || !c.trim()))) {
    throw new Error('ENG company qualification: target countries are invalid');
  }
  const countries = readHeCollectCountries(rawCountries).countries;
  if (countries.some((c) => normalizeEngCountry(c) !== c)) {
    throw new Error('ENG company qualification: target countries are invalid');
  }
  const icp = project.brief?.icp ?? null;
  const criteria = { version: HE_ENG_COMPANY_QUALIFICATION_VERSION, projectId: project.id, verticalId, hypotheses, countries, icp };
  return { key: digest(criteria), projectId: project.id, verticalId, hypotheses, countries, icp };
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
  version: 1;
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
