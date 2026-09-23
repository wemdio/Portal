import type { SupabaseClient } from '@supabase/supabase-js';
import { getBlockedEmailSet } from '@/lib/clientBlocklist/blockedContacts';
import { readContactDeliveryPages } from './contactDeliveryInventory';
import { prepareSegmentationAudience } from './segmentationAudit';
import type { VeBase } from './types';
import {
  estimateRemainingReady,
  veEstimatePopulation,
  type VeCollectionEstimate,
  type VeCollectionTargetProgress,
  type VeObservedContactYield,
  type VeRemainingReadyEstimate,
} from './collectionTarget';

export type VeAudienceBase = Pick<VeBase, 'id' | 'project_id' | 'hypothesis_id' | 'data' | 'columns' | 'source' | 'status' | 'updated_at'> & {
  collect_info?: {
    collection_mode?: string;
    estimate?: VeCollectionEstimate | null;
    target_progress?: VeCollectionTargetProgress | null;
  } | null;
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
  /** Candidate rows acquired across the adaptive preview rounds. */
  processed_candidates: number | null;
  preview_target: number | null;
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
  const target = base.collect_info?.target_progress;
  const observed = info?.observed_yield;
  const savedObserved = info?.version === 2 && observed && validCount(observed.candidates) && observed.candidates > 0
    && validCount(observed.ready) && Number.isFinite(observed.contacts_per_candidate)
    && observed.contacts_per_candidate === observed.ready / observed.candidates
    && Number.isFinite(Date.parse(observed.as_of)) && Date.parse(observed.as_of) <= now.getTime() ? observed : null;
  const processedCandidates = validCount(target?.candidates_processed) ? target.candidates_processed : null;
  const terminalTarget = target && ['target_reached', 'exhausted', 'limited'].includes(target.status);
  // A finished target is sufficient to explain the measured preview funnel,
  // even when unresolved reserve rows make a remaining-market forecast unsafe.
  const measuredObserved = terminalTarget && processedCandidates
    ? {
      candidates: processedCandidates,
      ready: audience.leads.length,
      contacts_per_candidate: audience.leads.length / processedCandidates,
      as_of: base.updated_at,
    }
    : null;
  const validObserved = savedObserved ?? measuredObserved;
  const forecast = info?.remaining_ready_estimate;
  const population = veEstimatePopulation(info);
  // Прогноз показываем, только если он пересчитывается из сохранённых вместе с
  // ним чисел. Возраст не ограничиваем: у завершённой базы следующей партии не
  // будет, и карточка показывает дату оценки, а не прячет число.
  const expected = savedObserved && forecast ? estimateRemainingReady({
    population, candidatesProcessed: savedObserved.candidates, readyRows: savedObserved.ready,
    processedInPopulation: forecast.processed_in_population, readyCompanies: forecast.ready_companies,
    eligible: true, asOf: savedObserved.as_of, populationAsOf: info?.population_as_of,
  }) : null;
  const estimate = savedObserved && forecast && expected && validCount(forecast.contacts)
    && forecast.contacts === expected.contacts && forecast.companies === expected.companies
    && forecast.source_population === population && forecast.population_as_of === info?.population_as_of
    && forecast.confidence === 'low' && forecast.candidates_processed === savedObserved.candidates
    && forecast.ready_rows === savedObserved.ready && forecast.as_of === savedObserved.as_of
    && typeof forecast.scope === 'string' ? forecast : null;
  const legacy = info && info.population_method !== 'plan_union';
  const reason = estimate ? null
    : legacy && terminalTarget ? 'Оценка для этой базы не рассчитывалась: она собрана до исправления счётчика источника.'
      : info?.estimate_reason ?? info?.note
        ?? (terminalTarget ? 'Текущая партия завершена. Для оценки дополнительного объёма нужен новый сопоставимый срез источника.'
          : 'Пока недостаточно данных для оценки дополнительного объёма.');
  // Исключения клиента прогноз не отменяют: распределённые контакты — уже
  // собранные компании, а в прогнозе только новые. Список исключений клиента
  // применится при загрузке (client_exclusions_applied).
  return {
    base_id: base.id, hypothesis_id: base.hypothesis_id,
    ready: audience.leads.length - blocked - allocated, checked_ready: audience.leads.length,
    excluded_blocked: blocked, excluded_used: allocated, client_exclusions_applied: context.clientExclusionsApplied === true,
    processed_candidates: processedCandidates,
    preview_target: target?.mode === 'preview' && validCount(target.ready_target) ? target.ready_target : null,
    observed_yield: validObserved, estimate, estimate_reason: reason,
    updated_at: base.updated_at, measured_at: now.toISOString(),
  };
}

/** A base can be reviewed before either a final template or approval exists. */
export async function loadVeBaseAudienceSummary(db: SupabaseClient, instantlyDb: SupabaseClient | null, input: {
  baseId: string; presetId?: string | null; now?: Date;
}): Promise<VeBaseAudienceSummary> {
  const { data: raw, error } = await db.from('ve_bases')
    .select('id, project_id, hypothesis_id, data, columns, source, status, updated_at, collect_info->estimate, collect_info->target_progress')
    .eq('id', input.baseId).maybeSingle();
  if (error || !raw) throw new Error('Не удалось загрузить состав базы');
  const projected = raw as typeof raw & {
    estimate?: VeCollectionEstimate | null;
    target_progress?: VeCollectionTargetProgress | null;
  };
  const base = { ...raw, collect_info: {
    estimate: projected.estimate ?? (raw as unknown as VeAudienceBase).collect_info?.estimate,
    target_progress: projected.target_progress ?? (raw as unknown as VeAudienceBase).collect_info?.target_progress,
  } } as VeAudienceBase;
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
