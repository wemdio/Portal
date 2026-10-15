import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';
import type { VeBaseSummary, VeJobSummary } from './api';

/** Checkboxes choose the next bulk preparation, never the visibility of saved work. */
export function selectPreparationHypotheses<T extends { id: string }>(
  hypotheses: readonly T[], selectedIds: readonly string[],
  preparations: readonly VeOutreachPreparation[],
  bases: readonly Pick<VeBaseSummary, 'hypothesis_id' | 'collect_info'>[],
): T[] {
  const visibleIds = new Set([...selectedIds, ...preparations.map((item) => item.hypothesis_id),
    ...bases.filter((item) => item.collect_info?.collection_mode !== 'supply')
      .map((item) => item.hypothesis_id)]);
  return hypotheses.filter((item) => visibleIds.has(item.id));
}

/** A legacy direct worker may precede its preparation row. Never adopt a
 * historical neighbour or guess between multiple active previews. */
export function selectHypothesisPreparationBase(
  hypothesisId: string, preparation: VeOutreachPreparation | undefined,
  bases: readonly VeBaseSummary[], jobs: readonly VeJobSummary[],
): { base: VeBaseSummary | undefined; canPauseOrphan: boolean } {
  const saved = bases.filter((base) => base.hypothesis_id === hypothesisId && base.collect_info?.collection_mode !== 'supply');
  if (preparation?.base_id) return { base: saved.find((base) => base.id === preparation.base_id), canPauseOrphan: false };
  const active = saved.filter((base) => base.source === 'auto' && base.collect_info?.collection_mode === 'preview'
    && (base.collection_continuation?.code === 'already_running' || jobs.some((job) => job.payload?.base_id === base.id
      && ['pending', 'running'].includes(job.status) && ['base_collect', 'base_analyze', 'template', 'base_reproject_contacts'].includes(job.stage))));
  return { base: active[0] ?? saved[0], canPauseOrphan: !preparation && active.length === 1 };
}

/** Display history for this exact hypothesis without rebinding preparation/launch. */
export function selectHypothesisLetters<T extends Pick<VeTemplate, 'id' | 'base_id' | 'status' | 'letters' | 'created_at'>>(
  hypothesisId: string,
  preparation: VeOutreachPreparation | undefined,
  bases: readonly Pick<VeBaseSummary, 'id' | 'hypothesis_id' | 'collect_info'>[],
  templates: readonly T[],
  preferredBaseId?: string,
): { template: T | null; previous: boolean } {
  const baseIds = new Set(bases.filter(base => base.hypothesis_id === hypothesisId
    && base.collect_info?.collection_mode !== 'supply'
    && (!preferredBaseId || base.id === preferredBaseId)).map(base => base.id));
  const candidates = templates.filter(template => baseIds.has(template.base_id)
    && template.status === 'ready' && Array.isArray(template.letters) && template.letters.length > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const current = candidates.find(template => template.id === preparation?.template_id
    && template.base_id === preparation.base_id);
  return { template: current ?? candidates[0] ?? null, previous: !current && candidates.length > 0 };
}
