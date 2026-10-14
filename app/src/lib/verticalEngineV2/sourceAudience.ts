import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { readVeAudienceScope, veAudienceScopeKey, veAudienceScopeText, type VeAudienceScope } from './audienceScope';
import { detectVeNicheSourceProfile, normalizeVeNicheSourceTask, type VeNicheSourceProfile } from './nicheSourcePolicy';
import { veSourceStrategyKey } from './adaptiveCollection';
import type { VeCollectTask, VeSourcePlan } from './prompts/sourcePlan';

export interface VeSourceAudienceHypothesis {
  id: string; title: string; description?: string | null; status: string | null;
  broad?: boolean; origin?: 'generated' | 'manual'; audience_scope?: VeAudienceScope | null;
}
export interface VeCollectionAudienceSnapshot {
  version: 1; hash: string; hypotheses: VeSourceAudienceHypothesis[];
  applied_at: string; reason: 'new_preview' | 'explicit_continuation';
}
export interface VeSourceCostPolicy { version: 1; website_discovery: 'existing_only' }

const text = (value: string) => value.toLowerCase().replace(/ё/g, 'е');
/** A sector named fintech includes payment providers, not only that subtype.
 * Manual legacy audiences are never reinterpreted by this correction. */
export function isVeBroadFintechAudience(h: VeSourceAudienceHypothesis): boolean {
  const scope = readVeAudienceScope(h.audience_scope);
  return scope ? scope.kind === 'sector' && scope.any_of.some((value) => /финтех|fintech/.test(text(value)))
    : h.broad === true && h.origin !== 'manual' && /финтех|fintech/.test(text(h.title));
}
export function audienceHypothesisForCollection(h: VeSourceAudienceHypothesis): VeSourceAudienceHypothesis {
  const scope = readVeAudienceScope(h.audience_scope);
  return scope ? { ...h, audience_scope: scope, description: veAudienceScopeText(scope),
    broad: scope.kind === 'sector' && scope.required.length === 0 } : h;
}
function audienceHash(hypotheses: VeSourceAudienceHypothesis[]): string {
  return createHash('sha256').update(JSON.stringify(hypotheses.map((h) => [h.id, h.title, h.description ?? null,
    h.broad ?? null, h.origin ?? null, h.audience_scope ? veAudienceScopeKey(h.audience_scope) : null]))).digest('hex');
}
export function createVeCollectionAudienceSnapshot(hypotheses: VeSourceAudienceHypothesis[], reason: VeCollectionAudienceSnapshot['reason'], at: string): VeCollectionAudienceSnapshot {
  if (!hypotheses.length || hypotheses.some((h) => !h.id || !h.title || h.status === 'rejected')) throw new Error('Invalid collection audience');
  const frozen = hypotheses.map((h) => audienceHypothesisForCollection({ id: h.id, title: h.title, description: h.description ?? null,
    status: h.status, ...(h.broad !== undefined ? { broad: h.broad } : {}), ...(h.origin ? { origin: h.origin } : {}),
    ...(h.audience_scope !== undefined ? { audience_scope: h.audience_scope ? structuredClone(h.audience_scope) : null } : {}) }));
  return { version: 1, hash: audienceHash(frozen), hypotheses: frozen, applied_at: at, reason };
}
export function readVeCollectionAudienceSnapshot(value: unknown): VeCollectionAudienceSnapshot | null {
  if (value === undefined || value === null) return null;
  const snapshot = value as VeCollectionAudienceSnapshot;
  if (snapshot.version !== 1 || !Array.isArray(snapshot.hypotheses) || !snapshot.hypotheses.length
    || !['new_preview', 'explicit_continuation'].includes(snapshot.reason) || typeof snapshot.applied_at !== 'string'
    || snapshot.hypotheses.some((h) => !h || !h.id || !h.title || h.status === 'rejected')) throw new Error('Invalid collection audience checkpoint');
  snapshot.hypotheses.forEach((h) => readVeAudienceScope(h.audience_scope));
  if (snapshot.hash !== audienceHash(snapshot.hypotheses)) throw new Error('Collection audience checkpoint hash mismatch');
  return snapshot;
}
export function readVeSourceCostPolicy(value: unknown): VeSourceCostPolicy | null {
  if (value === undefined || value === null) return null;
  const policy = value as VeSourceCostPolicy;
  if (policy.version !== 1 || policy.website_discovery !== 'existing_only') throw new Error('Unknown collection cost policy');
  return policy;
}

/** Cost is independent of how the audience is named or a source specialized. */
export function veSourceDiscoveryIsExistingOnly(info: { cost_policy?: unknown; niche_source_profile?: unknown; source_selection?: unknown; search_policy?: { phase?: string } }): boolean {
  return !!readVeSourceCostPolicy(info.cost_policy) || !!info.niche_source_profile || !!info.source_selection || info.search_policy?.phase === 'existing';
}

interface RefreshableInfo {
  collection_mode?: string; audience_snapshot?: unknown; audience_scope_refresh_requested?: boolean;
  hypotheses?: VeSourceAudienceHypothesis[]; refill?: boolean; campaign_id?: string; supply_batch_id?: string;
  construct?: { status?: string }; preview_pipeline?: { batches: unknown[] };
  adaptive_collection?: { pending?: unknown }; tasks?: Array<{ status?: string; source?: string; task?: VeCollectTask }>;
  company_name_recovery?: unknown; validation_retry?: boolean; relevance_review_requested?: boolean;
  saved_email_recovery?: { batch?: unknown };
}
export function canRefreshVeAudienceSources(info: RefreshableInfo): boolean {
  return info.collection_mode === 'preview' && !info.refill && !info.campaign_id && !info.supply_batch_id
    && !info.audience_snapshot && (!info.construct || info.construct.status === 'done') && !info.preview_pipeline?.batches.length && !info.adaptive_collection?.pending
    && !info.company_name_recovery && !info.saved_email_recovery?.batch && !info.validation_retry && !info.relevance_review_requested
    && !info.tasks?.some((task) => task.status === 'dispatched' || task.status === 'pending');
}
export function needsLegacyFintechAudienceRefresh(info: RefreshableInfo): boolean {
  if (!canRefreshVeAudienceSources(info) || info.hypotheses?.length !== 1 || !isVeBroadFintechAudience(info.hypotheses[0])
    || !info.tasks?.length || info.tasks.some((state) => !state.task)) return false;
  const old = info.tasks.map((state) => state.task!);
  const next = normalizeVeAudienceSourcePlan({ tasks: old }, info.hypotheses).plan.tasks;
  return next.some((task, index) => ['companies_directory', 'yandex_maps'].includes(task.source)
    && veSourceStrategyKey(task) !== veSourceStrategyKey(old[index]));
}
/** Every alternative must share a niche before it can specialize the entire
 * plan. Title words or one PSP branch cannot override a mixed sector scope. */
export function veAudienceNicheProfile(hypotheses: VeSourceAudienceHypothesis[]): VeNicheSourceProfile | null {
  // Legacy specialty rewrites replace full source queries (including hiring
  // roles). Explicit mandatory conditions must keep the scoped planner's query.
  if (hypotheses.some((h) => readVeAudienceScope(h.audience_scope)?.required.length)) return null;
  if (hypotheses.some(isVeBroadFintechAudience)) return null;
  const alternatives = hypotheses.flatMap((h) => {
    const scope = readVeAudienceScope(h.audience_scope);
    return scope ? scope.any_of.map((title) => ({ title })) : [h];
  });
  return detectVeNicheSourceProfile(alternatives);
}
const FINTECH_TERMS = ['финтех', 'fintech', 'финансовые технологии', 'финанс', 'financial', 'платеж', 'платёж', 'pay', 'эквайр', 'процессинг', 'скоринг', 'scoring'];
/** Pure, bounded plan comparison/execution path. No new tasks, limits, paid
 * tools or queries are appended; one existing directory branch retains PSP
 * identity lookup when another directory branch can cover the wider sector. */
export function normalizeVeAudienceSourcePlan(plan: VeSourcePlan, hypotheses: VeSourceAudienceHypothesis[]): {
  plan: VeSourcePlan; profile: VeNicheSourceProfile | null; decision: 'sector_fintech' | 'niche' | 'unchanged';
} {
  const scope = hypotheses.length === 1 ? readVeAudienceScope(hypotheses[0].audience_scope) : null;
  const fintech = hypotheses.length === 1 && isVeBroadFintechAudience(hypotheses[0])
    && (!scope || (scope.required.length === 0 && scope.any_of.every((title) => /финтех|fintech/.test(text(title))
      || detectVeNicheSourceProfile([{ title }]) === 'payments')));
  if (fintech) {
    const restrictedDirectories = plan.tasks.filter((task) => task.source === 'companies_directory' && task.directory_filters?.nameTerms?.length).length;
    let directoryIndex = 0;
    const mapsByGeo = new Map<string, { queries: string[]; offset: number }>();
    for (const task of plan.tasks) if (task.source === 'yandex_maps' && task.maps_query?.queries.length) {
      const geo = task.maps_query.geo ?? '';
      const old = mapsByGeo.get(geo) ?? { queries: [], offset: 0 };
      old.queries.push(...task.maps_query.queries);
      mapsByGeo.set(geo, old);
    }
    for (const group of mapsByGeo.values()) group.queries = [...new Set(['финансовые технологии', ...group.queries, 'финтех'])];
    const tasks = plan.tasks.map((task) => {
      if (task.source === 'companies_directory' && task.directory_filters?.nameTerms?.length) {
        // One existing PSP branch retains all its terms/identity lookup. A
        // single directory or a generic sector slice is never narrowed.
        if (restrictedDirectories < 2 || directoryIndex++ === 0) return task;
        const filters = { ...task.directory_filters, nameTerms: [...FINTECH_TERMS] };
        delete filters.identityCatalog;
        return { ...task, directory_filters: filters, rationale: 'Финтех-сектор по профильным названиям; ограничения гипотезы сохранены.' };
      }
      if (task.source === 'yandex_maps' && task.maps_query?.queries.length) {
        const group = mapsByGeo.get(task.maps_query.geo ?? '')!;
        const queries = group.queries.slice(group.offset, group.offset + task.maps_query.queries.length);
        group.offset += queries.length;
        return queries.length ? { ...task, maps_query: { ...task.maps_query, queries } } : task;
      }
      return task;
    });
    return { plan: { ...plan, tasks }, profile: null, decision: 'sector_fintech' };
  }
  const profile = veAudienceNicheProfile(hypotheses);
  return { plan: profile ? { ...plan, tasks: plan.tasks.map((task) => normalizeVeNicheSourceTask(task, profile)) } : plan,
    profile, decision: profile ? 'niche' : 'unchanged' };
}

/** Follow the actual approved launch lineage, never today's edited hypothesis.
 * Legacy approved previews return null and retain their existing supply path. */
export async function loadVeApprovedSupplyAudience(db: SupabaseClient, input: {
  projectId: string; hypothesisId: string; batchId: string; baseId: string;
}): Promise<VeCollectionAudienceSnapshot | null> {
  const { data: batch, error: batchError } = await db.from('ve_contact_supply_batches')
    .select('plan_id,base_id').eq('id', input.batchId).maybeSingle();
  if (batchError || !batch || batch.base_id !== input.baseId || !batch.plan_id) throw new Error('Supply audience batch is unavailable');
  const { data: plan, error: planError } = await db.from('ve_contact_supply_plans')
    .select('project_id,hypothesis_id,item_id').eq('id', batch.plan_id).maybeSingle();
  if (planError || !plan || plan.project_id !== input.projectId || plan.hypothesis_id !== input.hypothesisId || !plan.item_id) throw new Error('Supply audience approval is unavailable');
  const { data: item, error: itemError } = await db.from('ve_launch_queue_items')
    .select('base_id,project_id,hypothesis_id').eq('id', plan.item_id).maybeSingle();
  if (itemError || !item || !item.base_id || item.project_id !== input.projectId || item.hypothesis_id !== input.hypothesisId) throw new Error('Supply audience launch is unavailable');
  const { data: source, error: sourceError } = await db.from('ve_bases')
    .select('id,project_id,hypothesis_id,audience_snapshot:collect_info->audience_snapshot,cost_policy:collect_info->cost_policy')
    .eq('id', item.base_id).maybeSingle();
  if (sourceError || !source || source.project_id !== input.projectId || source.hypothesis_id !== input.hypothesisId) throw new Error('Supply source audience is unavailable');
  const snapshot = readVeCollectionAudienceSnapshot(source.audience_snapshot);
  if (snapshot && (snapshot.hypotheses.length !== 1 || snapshot.hypotheses[0].id !== input.hypothesisId
    || !readVeSourceCostPolicy(source.cost_policy))) throw new Error('Supply source audience does not match approval');
  return snapshot ? structuredClone(snapshot) : null;
}
