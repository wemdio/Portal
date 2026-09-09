import type { SupabaseClient } from '@supabase/supabase-js';
import { getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { prepareSegmentationAudience } from './segmentationAudit';
import type { VeBase } from './types';
import { estimateRemainingReady, VE_SOURCE_POPULATION_MAX_AGE_MS, type VeCollectionEstimate, type VeObservedContactYield, type VeRemainingReadyEstimate } from './collectionTarget';

export type VeAudienceBase = Pick<VeBase, 'id' | 'project_id' | 'hypothesis_id' | 'data' | 'columns' | 'source' | 'status' | 'updated_at'> & {
  collect_info?: { collection_mode?: string; estimate?: VeCollectionEstimate | null } | null;
};

export interface VeBaseAudienceSummary {
  base_id: string;
  hypothesis_id: string | null;
  /** Current usable contacts after every exclusion whose scope is known. */
  ready: number;
  checked_ready: number;
  excluded_blocked: number;
  /** Already allocated to campaigns, including uncertain provider attempts. */
  excluded_used: number;
  client_exclusions_applied: boolean;
  observed_yield: VeObservedContactYield | null;
  estimate: VeRemainingReadyEstimate | null;
  estimate_reason: string | null;
  updated_at: string;
  measured_at: string;
}

const validCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Pure read projection. Does not generate a plan, approve, enqueue or contact a provider. */
export function buildVeBaseAudienceSummary(base: VeAudienceBase, context: {
  blocked?: ReadonlySet<string>; allocated?: ReadonlySet<string>; clientExclusionsApplied?: boolean; now?: Date;
} = {}): VeBaseAudienceSummary {
  const now = context.now ?? new Date();
  const audience = prepareSegmentationAudience({
    rows: Array.isArray(base.data) ? base.data : [], columns: base.columns ?? [], source: base.source,
  });
  let blocked = 0;
  let allocated = 0;
  for (const lead of audience.leads) {
    const email = lead.email.trim().toLowerCase();
    if (context.blocked?.has(email)) blocked += 1;
    else if (context.allocated?.has(email)) allocated += 1;
  }
  const info = base.collect_info?.estimate;
  const observed = info?.observed_yield;
  const validObserved = info?.version === 2 && observed && validCount(observed.candidates) && observed.candidates > 0
    && validCount(observed.ready) && Number.isFinite(observed.contacts_per_candidate)
    && observed.contacts_per_candidate === observed.ready / observed.candidates
    && Number.isFinite(Date.parse(observed.as_of)) && Date.parse(observed.as_of) <= now.getTime() ? observed : null;
  const forecast = info?.remaining_ready_estimate;
  const age = now.getTime() - Date.parse(forecast?.population_as_of ?? '');
  const expected = validObserved ? estimateRemainingReady({
    population: info?.unique_companies ?? null, candidatesProcessed: validObserved.candidates, readyRows: validObserved.ready,
    eligible: true, asOf: validObserved.as_of, populationAsOf: info?.population_as_of,
  }) : null;
  let estimate = info?.version === 2 && info.population_matches_source && validObserved && forecast
    && validCount(forecast.contacts) && validCount(forecast.source_population)
    && forecast.contacts === expected?.contacts && forecast.source_population === info.unique_companies
    && forecast.population_as_of === info.population_as_of && forecast.confidence === 'low'
    && forecast.candidates_processed === validObserved.candidates && forecast.ready_rows === validObserved.ready
    && forecast.as_of === validObserved.as_of && typeof forecast.scope === 'string'
    && Number.isFinite(age) && age >= 0 && age <= VE_SOURCE_POPULATION_MAX_AGE_MS ? forecast : null;
  let reason = estimate ? null : info?.estimate_reason ?? info?.note
    ?? (forecast ? 'Счётчик источника требует обновления при следующей партии.' : 'Пока недостаточно данных для оценки дополнительного объёма.');
  // The measured source population has no client blocklist/campaign predicate.
  // Known client exclusions cannot be silently ignored in a remaining forecast.
  if ((context.blocked?.size ?? 0) > 0 || (context.allocated?.size ?? 0) > 0) {
    estimate = null;
    reason = 'Готовый запас пересчитан с исключениями. Для прогноза остатка нужно сверить источник с блокировками и ранее распределёнными контактами.';
  }
  return {
    base_id: base.id, hypothesis_id: base.hypothesis_id,
    ready: audience.leads.length - blocked - allocated, checked_ready: audience.leads.length,
    excluded_blocked: blocked, excluded_used: allocated, client_exclusions_applied: context.clientExclusionsApplied === true,
    observed_yield: validObserved, estimate, estimate_reason: reason,
    updated_at: base.updated_at, measured_at: now.toISOString(),
  };
}

/** A base can be reviewed before either a final template or approval exists. */
export async function loadVeBaseAudienceSummary(db: SupabaseClient, instantlyDb: SupabaseClient | null, input: {
  baseId: string; presetId?: string | null; now?: Date;
}): Promise<VeBaseAudienceSummary> {
  const { data: raw, error } = await db.from('ve_bases')
    .select('id, project_id, hypothesis_id, data, columns, source, status, updated_at, collect_info->estimate')
    .eq('id', input.baseId).maybeSingle();
  if (error || !raw) throw new Error('Не удалось загрузить состав базы');
  const base = { ...raw, collect_info: { estimate: raw.estimate
    ?? (raw as unknown as VeAudienceBase).collect_info?.estimate } } as VeAudienceBase;
  const { data: project, error: projectError } = await db.from('ve_projects')
    .select('launch_preset_id').eq('id', base.project_id).maybeSingle();
  if (projectError || !project) throw new Error('Не удалось определить настройки клиента');
  if (project.launch_preset_id && input.presetId && project.launch_preset_id !== input.presetId) {
    throw new Error('Выбранный клиент не совпадает с настройками запущенного проекта');
  }
  const presetId = project.launch_preset_id || input.presetId;
  let blocked: Set<string> | undefined;
  if (presetId) {
    if (!instantlyDb) throw new Error('Не удалось проверить исключения клиента');
    const { data: preset, error: presetError } = await instantlyDb.from('client_campaign_presets')
      .select('client_user_id').eq('id', presetId).maybeSingle();
    if (presetError || !preset?.client_user_id) throw new Error('Настройки выбранного клиента недоступны');
    blocked = await getBlockedEmailSet(instantlyDb, preset.client_user_id);
  }
  const rows = await readContactDeliveryPages<{ email_normalized: string }>('base audience allocated contacts', (from, to) => db
    .from('ve_contact_delivery_rows').select('email_normalized', { count: 'exact' }).eq('ve_project_id', base.project_id)
    .order('id').range(from, to));
  return buildVeBaseAudienceSummary(base, {
    blocked, allocated: new Set(rows.map((row) => row.email_normalized)), clientExclusionsApplied: Boolean(presetId), now: input.now,
  });
}
