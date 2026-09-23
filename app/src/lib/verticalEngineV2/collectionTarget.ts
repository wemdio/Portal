/** Validated-recipient targets are distinct from candidate/cost safety caps. */
export const VE_PREVIEW_READY_TARGET = 500;
/** Small first cohort publishes checked contacts before the full preview. */
export const VE_PREVIEW_FIRST_CANDIDATES = 100;
export const VE_COLLECTION_MAX_CANDIDATES = 10_000;
export const VE_COLLECTION_MAX_ROUNDS = 5;
/**
 * Бюджет раундов сборки — защита от бесконечного цикла, а не цель. Раунд
 * расходует его, только если отправил в проверку новые для базы компании:
 * холостой (пустой или из уже проверенных) бюджет не тратит, но таких подряд
 * допускается не больше VE_COLLECTION_MAX_IDLE_ROUNDS. «Продолжить подготовку»
 * даёт новый бюджет от текущего раунда.
 */
export const VE_COLLECTION_ROUND_BUDGET = 100;
export const VE_COLLECTION_MAX_IDLE_ROUNDS = 5;
/** Санитарный потолок сохранённого предела: больше не бывает даже после продолжений. */
export const VE_COLLECTION_ROUND_CEILING = 10_000;

/** Сохранённый предел раундов базы; меньше бюджета (старые 5) или испорченный — бюджет. */
export function veCollectionMaxRounds(stored: unknown): number {
  return typeof stored === 'number' && Number.isSafeInteger(stored)
    && stored > VE_COLLECTION_ROUND_BUDGET && stored <= VE_COLLECTION_ROUND_CEILING ? stored : VE_COLLECTION_ROUND_BUDGET;
}
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
  /** Persisted per run so a redeploy never shrinks an in-flight constructor's input. */
  first_round_candidates?: number;
  /** Холостых раундов подряд: без новых для базы компаний. */
  idle_streak?: number;
  /** Компаний в готовой базе. */
  ready_companies?: number;
  /** Адресов в готовой базе — только когда в цель (ready_rows) засчитаны не все. */
  ready_contacts?: number;
  /** Сколько адресов одной компании засчитывается в цель; рядом с ready_contacts. */
  counted_per_company?: number;
  status: 'collecting' | 'target_reached' | 'exhausted' | 'limited' | 'error';
  reason?: string;
}

/**
 * Состав готовой базы рядом с засчитанными в цель контактами (ready_rows).
 * Число адресов пишется, только когда оно больше засчитанного: иначе оно
 * совпадает с ready_rows и старые поля не должны его пережить.
 */
export function withVeTargetComposition(
  progress: VeCollectionTargetProgress,
  count: { counted: number; companies: number; perCompany: number | null }, contacts: number,
): VeCollectionTargetProgress {
  const next: VeCollectionTargetProgress = { ...progress, ready_companies: count.companies };
  delete next.ready_contacts;
  delete next.counted_per_company;
  if (contacts > count.counted && count.perCompany !== null) {
    next.ready_contacts = contacts;
    next.counted_per_company = count.perCompany;
  }
  return next;
}

export function createCollectionTarget(mode: VeCollectionMode, readyTarget?: number): VeCollectionTargetProgress {
  if (mode !== 'preview' && mode !== 'supply') throw new Error('Unknown collection_mode');
  const target = mode === 'preview' ? VE_PREVIEW_READY_TARGET : readyTarget;
  if (!Number.isSafeInteger(target) || (target ?? 0) < 1 || (target ?? 0) > VE_COLLECTION_MAX_CANDIDATES) {
    throw new Error('ready_target must be an integer between 1 and 10000');
  }
  return {
    mode, ready_target: target!, ready_rows: 0, candidates_processed: 0,
    first_round_candidates: mode === 'preview' ? VE_PREVIEW_FIRST_CANDIDATES : 2_000,
    round: 1, max_rounds: VE_COLLECTION_MAX_ROUNDS, max_candidates: VE_COLLECTION_MAX_CANDIDATES, status: 'collecting',
  };
}

export function collectionRoundLimit(progress: VeCollectionTargetProgress): number {
  const missing = Math.max(1, progress.ready_target - progress.ready_rows);
  const observedYield = progress.candidates_processed > 0
    ? progress.ready_rows / progress.candidates_processed : 0.5;
  const requested = Math.ceil(missing / Math.max(0.05, observedYield));
  return Math.max(0, Math.min(
    progress.round === 1 ? progress.first_round_candidates ?? 2_000 : 5_000,
    progress.max_candidates - progress.candidates_processed,
    requested,
  ));
}

export function finishCollectionRound(
  progress: VeCollectionTargetProgress,
  result: {
    candidates: number; readyRows: number; exhausted: boolean; canContinue: boolean; error: string | null; validationRetry?: boolean;
    /** Раунд не отправил ни одной новой для базы компании (или был пустым). */
    idle?: boolean;
  },
): VeCollectionTargetProgress {
  const next = {
    ...progress, ready_rows: result.readyRows,
    candidates_processed: progress.candidates_processed + result.candidates,
  };
  delete next.reason;
  delete next.idle_streak;
  const idleStreak = result.idle ? (Number.isSafeInteger(progress.idle_streak) ? Math.max(0, progress.idle_streak!) : 0) + 1 : 0;
  if (idleStreak) next.idle_streak = idleStreak;
  if (result.error) return { ...next, status: 'error', reason: result.error };
  if (result.readyRows >= progress.ready_target) return { ...next, status: 'target_reached' };
  if (result.exhausted) return { ...next, status: 'exhausted', reason: 'Источники выбранного плана исчерпаны' };
  // Холостой раунд бюджет раундов не расходует (см. VE_COLLECTION_ROUND_BUDGET).
  if (next.candidates_processed >= next.max_candidates || (!result.idle && next.round >= next.max_rounds)) {
    return { ...next, status: 'limited', reason: 'Достигнут защитный предел кандидатов или раундов; цель ещё не набрана' };
  }
  if (!result.canContinue) {
    return { ...next, status: 'limited', reason: 'Нет подтверждённого продолжения источников; исчерпание рынка не доказано' };
  }
  // Две разные остановки выдавали один текст. Здесь источник ЖИВ (canContinue),
  // но раунд не дал ни одного кандидата — и карточка всё равно сообщала, что
  // продолжать нечем, при задаче done и exhausted=false. Причина обязана
  // совпадать с состоянием задач, иначе по ней нельзя решить, продолжать ли.
  if (result.candidates === 0 && !result.validationRetry) {
    return { ...next, status: 'limited', reason: 'Партия вышла пустой: источники плана ещё не отмечены исчерпанными, '
      + 'но за раунд не набралось ни одного кандидата. Это остановка по пустому раунду, а не доказательство, '
      + 'что подходящие компании кончились' };
  }
  if (idleStreak >= VE_COLLECTION_MAX_IDLE_ROUNDS) {
    return { ...next, status: 'limited', reason: `${idleStreak} проходов подряд не принесли ни одной новой компании: `
      + 'источники отдают только уже проверенные. Сбор остановлен, чтобы не ходить по кругу; это не доказательство, '
      + 'что подходящие компании кончились' };
  }
  const maxRounds = result.idle ? Math.min(VE_COLLECTION_ROUND_CEILING, next.max_rounds + 1) : next.max_rounds;
  return { ...next, round: next.round + 1, max_rounds: maxRounds, status: 'collecting' };
}
