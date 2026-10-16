import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeCollectionContinuation } from './collectionRecovery';
import { isVeRelevanceTriageEnabled } from './relevanceTriageConfig';
import { isVeAudienceScopeEnabled } from './audienceScope';

/** Bump when the continuation predicate or its underlying selection rules
 * change: an old negative verdict must not hide newly available work. */
export const VE_COLLECTION_CONTINUATION_CACHE_VERSION = 5;

interface VeContinuationCache {
  version: number;
  basis_updated_at: string;
  basis_status: string;
  basis_revision: number;
  basis_max_emails_per_company: number | null;
  basis_contact_cap_applied: number | null;
  triage_enabled: boolean;
  audience_scope_enabled: boolean;
  decision: VeCollectionContinuation;
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const cap = (value: unknown): value is number | null => value === null
  || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 100);

function basis(base: Record<string, unknown>): Omit<VeContinuationCache, 'decision'> | null {
  if (typeof base.updated_at !== 'string' || !Number.isFinite(Date.parse(base.updated_at))
    || typeof base.status !== 'string' || !base.status
    || typeof base.collection_continuation_revision !== 'number'
    || !Number.isSafeInteger(base.collection_continuation_revision) || base.collection_continuation_revision < 0
    || !cap(base.max_emails_per_company) || !cap(base.contact_cap_applied)) return null;
  return {
    version: VE_COLLECTION_CONTINUATION_CACHE_VERSION,
    basis_updated_at: base.updated_at,
    basis_status: base.status,
    basis_revision: base.collection_continuation_revision,
    basis_max_emails_per_company: base.max_emails_per_company,
    basis_contact_cap_applied: base.contact_cap_applied,
    triage_enabled: isVeRelevanceTriageEnabled(typeof base.project_id === 'string' ? base.project_id : null),
    audience_scope_enabled: isVeAudienceScopeEnabled(typeof base.project_id === 'string' ? base.project_id : null),
  };
}

function decision(value: unknown): VeCollectionContinuation | null {
  const item = object(value);
  if (!item || typeof item.available !== 'boolean' || typeof item.code !== 'string' || !item.code
    || item.code === 'state_unchecked' || typeof item.reason !== 'string' || !item.reason
    || (item.available ? item.action !== 'resume_collection' && item.action !== 'resume_preparation' : item.action !== null)) return null;
  // Whitelist the payload: a future caller must not put full state or contacts
  // into a public response by attaching extra fields to a decision.
  return { available: item.available, action: item.action as VeCollectionContinuation['action'],
    code: item.code as VeCollectionContinuation['code'], reason: item.reason };
}

/** Only a decision computed from the full base state belongs in this cache. */
export function createVeCollectionContinuationCache(
  base: Record<string, unknown>, value: VeCollectionContinuation,
): VeContinuationCache | null {
  const current = basis(base);
  const verdict = decision(value);
  return current && verdict ? { ...current, decision: verdict } : null;
}

/** A miss is unknown, never permission or proof that the sources are empty. */
export function readVeCollectionContinuationCache(base: Record<string, unknown>): VeCollectionContinuation | null {
  const cached = object(base.collection_continuation);
  const current = basis(base);
  if (!cached || !current || Object.entries(current).some(([key, value]) => cached[key] !== value)) return null;
  return decision(cached.decision);
}

/** Cache-only CAS: no collect_info/timestamp change, job, or paid provider call.
 * False also includes a race or unavailable response; callers must not treat it
 * as an authorization to enqueue work from the stale snapshot. */
export async function saveVeCollectionContinuationCache(
  supabase: SupabaseClient, base: Record<string, unknown>, value: VeCollectionContinuation,
): Promise<boolean> {
  const cached = createVeCollectionContinuationCache(base, value);
  if (!cached || typeof base.id !== 'string' || !base.id || typeof base.project_id !== 'string' || !base.project_id) return false;
  try {
    let query = supabase.from('ve_bases').update({ collection_continuation: cached })
      .eq('id', base.id).eq('project_id', base.project_id).eq('updated_at', cached.basis_updated_at)
      .eq('status', cached.basis_status).eq('collection_continuation_revision', cached.basis_revision);
    query = cached.basis_max_emails_per_company === null ? query.is('max_emails_per_company', null)
      : query.eq('max_emails_per_company', cached.basis_max_emails_per_company);
    query = cached.basis_contact_cap_applied === null ? query.is('contact_cap_applied', null)
      : query.eq('contact_cap_applied', cached.basis_contact_cap_applied);
    const result = await query.select('id').maybeSingle();
    return !result.error && result.data?.id === base.id;
  } catch {
    return false;
  }
}
