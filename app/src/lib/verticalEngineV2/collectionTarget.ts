/** Validated-recipient targets are distinct from candidate/cost safety caps. */
export const VE_PREVIEW_READY_TARGET = 1_000;
export const VE_COLLECTION_MAX_CANDIDATES = 10_000;
export const VE_COLLECTION_MAX_ROUNDS = 5;
export interface VeRemainingReadyEstimate {
  contacts: number;
  as_of: string;
  scope: string;
  confidence: 'low';
  /** Collector provenance. Absent on legacy estimates. */
  population_as_of?: string;
  source_population?: number;
  candidates_processed?: number;
  ready_rows?: number;
}

export interface VeObservedContactYield {
  candidates: number;
  ready: number;
  contacts_per_candidate: number;
  as_of: string;
}

export interface VeCollectionEstimate {
  version?: 2;
  unique_companies: number | null;
  companies_with_email: number | null;
  companies_with_phone?: number | null;
  directory_rows_total?: number | null;
  population_as_of?: string;
  population_filters?: string;
  population_matches_source?: boolean;
  note?: string;
  estimate_reason?: string;
  observed_yield?: VeObservedContactYield | null;
  remaining_ready_estimate?: VeRemainingReadyEstimate | null;
}

export const VE_SOURCE_POPULATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Observed-yield scenario, not an inventory count or confidence interval. */
export function estimateRemainingReady(input: {
  population: number | null; candidatesProcessed: number; readyRows: number; eligible: boolean; asOf: string;
  populationAsOf?: string;
}): VeRemainingReadyEstimate | null {
  if (!input.eligible || !Number.isSafeInteger(input.population) || input.population === null
    || !Number.isSafeInteger(input.candidatesProcessed) || input.candidatesProcessed < 100
    || input.population < input.candidatesProcessed || !Number.isSafeInteger(input.readyRows) || input.readyRows <= 0
    || !Number.isFinite(Date.parse(input.asOf))) return null;
  const contacts = Math.round((input.population - input.candidatesProcessed) * input.readyRows / input.candidatesProcessed);
  if (!Number.isSafeInteger(contacts) || contacts < 0) return null;
  return {
    contacts,
    as_of: input.asOf, confidence: 'low',
    scope: 'Один реестровый срез при сохранении наблюдаемого выхода после проверок; сценарий, не подтверждённый остаток',
    ...(input.populationAsOf ? {
      population_as_of: input.populationAsOf, source_population: input.population,
      candidates_processed: input.candidatesProcessed, ready_rows: input.readyRows,
    } : {}),
  };
}

/** A completed cohort changes the forecast; UI polling never buys new data. */
export function updateCollectionEstimate(estimate: VeCollectionEstimate, input: {
  candidates: number; ready: number; complete: boolean; identitiesComplete: boolean;
  externalExclusions: boolean; asOf: string;
}): VeCollectionEstimate {
  const validCounts = Number.isSafeInteger(input.candidates) && input.candidates > 0
    && Number.isSafeInteger(input.ready) && input.ready >= 0;
  const observed = input.complete && validCounts ? {
    candidates: input.candidates, ready: input.ready, contacts_per_candidate: input.ready / input.candidates, as_of: input.asOf,
  } : null;
  const populationTime = Date.parse(estimate.population_as_of ?? '');
  const age = Date.parse(input.asOf) - populationTime;
  const reason = !input.complete ? 'Проверка текущей партии ещё не завершена.'
    : !input.identitiesComplete ? 'Недостаточно идентификаторов компаний для сопоставления выборки и источника.'
      : input.externalExclusions ? 'Нельзя точно вычесть пересечения с ранее собранными базами из остатка источника.'
        : estimate.version !== 2 || !estimate.population_matches_source || estimate.unique_companies === null
          ? estimate.note ?? 'Размер сопоставимого источника пока неизвестен.'
          : !Number.isFinite(age) || age < 0 || age > VE_SOURCE_POPULATION_MAX_AGE_MS
            ? 'Счётчик источника требует обновления при следующей партии.'
            : !validCounts || input.candidates < 100 ? 'Для оценки нужно проверить не менее 100 компаний.'
              : input.ready === 0 ? 'Пока нет готовых контактов для оценки выхода.'
                : estimate.unique_companies < input.candidates ? 'Счётчик источника меньше обработанной выборки; требуется сверка.' : null;
  return {
    ...estimate, observed_yield: observed,
    remaining_ready_estimate: reason ? null : estimateRemainingReady({
      population: estimate.unique_companies, candidatesProcessed: input.candidates, readyRows: input.ready,
      eligible: true, asOf: input.asOf, populationAsOf: estimate.population_as_of,
    }),
    estimate_reason: reason ?? undefined,
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
  result: { candidates: number; readyRows: number; exhausted: boolean; canContinue: boolean; error: string | null; validationRetry?: boolean },
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
  if (!result.canContinue || (result.candidates === 0 && !result.validationRetry)) {
    return { ...next, status: 'limited', reason: 'Нет подтверждённого продолжения источников; исчерпание рынка не доказано' };
  }
  return { ...next, round: next.round + 1, status: 'collecting' };
}
