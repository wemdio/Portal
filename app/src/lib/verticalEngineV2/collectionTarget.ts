/** Validated-recipient targets are distinct from candidate/cost safety caps. */
export const VE_PREVIEW_READY_TARGET = 1_000;
export const VE_COLLECTION_MAX_CANDIDATES = 10_000;
export const VE_COLLECTION_MAX_ROUNDS = 5;
export interface VeRemainingReadyEstimate {
  contacts: number;
  as_of: string;
  scope: string;
  confidence: 'low';
}

/** Observed-yield scenario, not an inventory count or confidence interval. */
export function estimateRemainingReady(input: {
  population: number | null; candidatesProcessed: number; readyRows: number; eligible: boolean; asOf: string;
}): VeRemainingReadyEstimate | null {
  if (!input.eligible || !Number.isSafeInteger(input.population) || input.population === null
    || input.candidatesProcessed < 100 || input.population < input.candidatesProcessed || input.readyRows <= 0) return null;
  return {
    contacts: Math.round((input.population - input.candidatesProcessed) * input.readyRows / input.candidatesProcessed),
    as_of: input.asOf, confidence: 'low',
    scope: 'Один реестровый срез при сохранении наблюдаемого выхода после проверок; сценарий, не подтверждённый остаток',
  };
}
export type VeCollectionMode = 'preview' | 'supply';
export interface VeCollectionTargetProgress {
  mode: VeCollectionMode;
  ready_target: number;
  ready_rows: number;
  candidates_processed: number;
  round: number;
  max_rounds: number;
  max_candidates: number;
  status: 'collecting' | 'target_reached' | 'exhausted' | 'limited' | 'error';
  reason?: string;
}

export function createCollectionTarget(mode: VeCollectionMode, readyTarget?: number): VeCollectionTargetProgress {
  if (mode !== 'preview' && mode !== 'supply') throw new Error('Unknown collection_mode');
  const target = mode === 'preview' ? VE_PREVIEW_READY_TARGET : readyTarget;
  if (!Number.isSafeInteger(target) || (target ?? 0) < 1 || (target ?? 0) > VE_COLLECTION_MAX_CANDIDATES) {
    throw new Error('ready_target must be an integer between 1 and 10000');
  }
  return {
    mode, ready_target: target!, ready_rows: 0, candidates_processed: 0,
    round: 1, max_rounds: VE_COLLECTION_MAX_ROUNDS, max_candidates: VE_COLLECTION_MAX_CANDIDATES, status: 'collecting',
  };
}

export function collectionRoundLimit(progress: VeCollectionTargetProgress): number {
  const missing = Math.max(1, progress.ready_target - progress.ready_rows);
  const observedYield = progress.candidates_processed > 0
    ? progress.ready_rows / progress.candidates_processed : 0.5;
  const requested = Math.ceil(missing / Math.max(0.05, observedYield));
  return Math.max(0, Math.min(
    progress.round === 1 ? 2_000 : 5_000,
    progress.max_candidates - progress.candidates_processed,
    requested,
  ));
}

export function finishCollectionRound(
  progress: VeCollectionTargetProgress,
  result: { candidates: number; readyRows: number; exhausted: boolean; canContinue: boolean; error: string | null },
): VeCollectionTargetProgress {
  const next = {
    ...progress, ready_rows: result.readyRows,
    candidates_processed: progress.candidates_processed + result.candidates,
  };
  delete next.reason;
  if (result.error) return { ...next, status: 'error', reason: result.error };
  if (result.readyRows >= progress.ready_target) return { ...next, status: 'target_reached' };
  if (result.exhausted) return { ...next, status: 'exhausted', reason: 'Источники выбранного плана исчерпаны' };
  if (next.candidates_processed >= next.max_candidates || next.round >= next.max_rounds) {
    return { ...next, status: 'limited', reason: 'Достигнут защитный предел кандидатов или раундов; цель ещё не набрана' };
  }
  if (!result.canContinue || result.candidates === 0) {
    return { ...next, status: 'limited', reason: 'Нет подтверждённого продолжения источников; исчерпание рынка не доказано' };
  }
  return { ...next, round: next.round + 1, status: 'collecting' };
}
