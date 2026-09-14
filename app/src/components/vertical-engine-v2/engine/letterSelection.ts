import type { VeTemplate } from '@/lib/verticalEngineV2/types';
import type { VeOutreachPreparation } from '@/lib/verticalEngineV2/outreachSetup';
import type { VeBaseSummary } from './api';

/** Display history for this exact hypothesis without rebinding preparation/launch. */
export function selectHypothesisLetters<T extends Pick<VeTemplate, 'id' | 'base_id' | 'status' | 'letters' | 'created_at'>>(
  hypothesisId: string,
  preparation: VeOutreachPreparation | undefined,
  bases: readonly Pick<VeBaseSummary, 'id' | 'hypothesis_id' | 'collect_info'>[],
  templates: readonly T[],
): { template: T | null; previous: boolean } {
  const baseIds = new Set(bases.filter(base => base.hypothesis_id === hypothesisId
    && base.collect_info?.collection_mode !== 'supply').map(base => base.id));
  const candidates = templates.filter(template => baseIds.has(template.base_id)
    && template.status === 'ready' && Array.isArray(template.letters) && template.letters.length > 0)
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  const current = candidates.find(template => template.id === preparation?.template_id
    && template.base_id === preparation.base_id);
  return { template: current ?? candidates[0] ?? null, previous: !current && candidates.length > 0 };
}
