import { isVeTransientProviderError } from './collectionErrors';

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
  /** Новых компаний, на которые придутся эти контакты; рядом с контактами. */
  companies?: number;
  /** Непросмотренных компаний, оставшихся в измеренном срезе источника. */
  remaining_companies?: number;
  as_of: string;
  scope: string;
  confidence: 'low';
  /** Collector provenance. Absent on legacy estimates. */
  population_as_of?: string;
  source_population?: number;
  candidates_processed?: number;
  ready_rows?: number;
  /** Сколько из обработанных компаний входит в измеренный срез. */
  processed_in_population?: number;
  ready_companies?: number;
}

export interface VeObservedContactYield {
  candidates: number;
  ready: number;
  contacts_per_candidate: number;
  as_of: string;
  /** Компаний с готовым контактом. Absent on legacy observations. */
  ready_companies?: number;
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
  /**
   * 'plan_union' — объединение реестровых срезов плана тем же условием, что и
   * выборка (ve_directory_plan_population). Старые оценки без поля считались
   * другим условием и пересчитываются при следующей партии.
   */
  population_method?: 'plan_union';
  /** Компаний среза, ещё не взятых другими базами проекта: основа прогноза. */
  available_companies?: number | null;
  /** Компаний в каждом реестровом срезе плана, по порядку задач. */
  slice_companies?: number[];
  /** Источники плана без размера (карты, вакансии): в прогноз не входят. */
  unsized_sources?: string[];
  note?: string;
  estimate_reason?: string;
  observed_yield?: VeObservedContactYield | null;
  remaining_ready_estimate?: VeRemainingReadyEstimate | null;
}

export const VE_SOURCE_POPULATION_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const VE_REMAINING_SCOPE = 'Считаются компании реестра под условия гипотезы, без повторов и без компаний других баз проекта. '
  + 'Это прогноз по текущему выходу, а не гарантированный остаток.';

/** Observed-yield scenario, not an inventory count or confidence interval. */
export function estimateRemainingReady(input: {
  population: number | null; candidatesProcessed: number; readyRows: number; eligible: boolean; asOf: string;
  populationAsOf?: string;
  /** Компании среза, уже просмотренные базой. Без поля — все обработанные. */
  processedInPopulation?: number;
  /** Компаний с готовым контактом: прогноз в компаниях рядом с контактами. */
  readyCompanies?: number;
  scope?: string;
}): VeRemainingReadyEstimate | null {
  const seen = input.processedInPopulation ?? input.candidatesProcessed;
  if (!input.eligible || !Number.isSafeInteger(input.population) || input.population === null
    || !Number.isSafeInteger(input.candidatesProcessed) || input.candidatesProcessed < 100
    || !Number.isSafeInteger(seen) || seen < 0 || input.population < seen
    || !Number.isSafeInteger(input.readyRows) || input.readyRows <= 0
    || !Number.isFinite(Date.parse(input.asOf))) return null;
  // Остаток — компании, на которые база ещё не смотрела, а выход — готовые
  // контакты на обработанную компанию: охват, а не лишние адреса тех же компаний.
  const remaining = input.population - seen;
  const contacts = Math.round(remaining * input.readyRows / input.candidatesProcessed);
  if (!Number.isSafeInteger(contacts) || contacts < 0) return null;
  const readyCompanies = Number.isSafeInteger(input.readyCompanies) && input.readyCompanies! >= 0 ? input.readyCompanies : undefined;
  return {
    contacts,
    ...(readyCompanies !== undefined ? { companies: Math.round(remaining * readyCompanies / input.candidatesProcessed) } : {}),
    remaining_companies: remaining,
    as_of: input.asOf, confidence: 'low',
    scope: input.scope ?? 'Один реестровый срез при сохранении наблюдаемого выхода после проверок; сценарий, не подтверждённый остаток',
    ...(input.populationAsOf ? {
      population_as_of: input.populationAsOf, source_population: input.population,
      candidates_processed: input.candidatesProcessed, ready_rows: input.readyRows,
      ...(input.processedInPopulation !== undefined ? { processed_in_population: input.processedInPopulation } : {}),
      ...(readyCompanies !== undefined ? { ready_companies: readyCompanies } : {}),
    } : {}),
  };
}

/** Размер среза, по которому можно прогнозировать: посчитан условием выборки. */
export function veEstimatePopulation(estimate: VeCollectionEstimate | null | undefined): number | null {
  if (!estimate || estimate.version !== 2 || estimate.population_method !== 'plan_union'
    || estimate.population_matches_source !== true) return null;
  const value = estimate.available_companies ?? estimate.unique_companies;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Прогноз пересчитывается на каждой партии по всем обработанным компаниям.
 * Раньше он считался только на полностью проверенной партии, а база почти
 * всегда заканчивается на оборванной — число не появлялось никогда (68 баз из
 * 83 на 22.09.2026). UI polling never buys new data.
 */
export function updateCollectionEstimate(estimate: VeCollectionEstimate, input: {
  /** Все обработанные базой компании: знаменатель выхода. */
  candidates: number;
  /** Из них компании реестра (с ИНН): они уже вычтены из остатка среза. */
  sourceCandidates: number;
  /** Готовые контакты в единицах цели: лишние адреса одной компании рынок не расширяют. */
  ready: number;
  readyCompanies: number;
  /** Последняя партия проверена полностью. Незавершённая оценку не отменяет. */
  complete: boolean;
  asOf: string;
}): VeCollectionEstimate {
  const validCounts = Number.isSafeInteger(input.candidates) && input.candidates > 0
    && Number.isSafeInteger(input.ready) && input.ready >= 0;
  const observed = validCounts ? {
    candidates: input.candidates, ready: input.ready, contacts_per_candidate: input.ready / input.candidates, as_of: input.asOf,
    ...(Number.isSafeInteger(input.readyCompanies) && input.readyCompanies >= 0 ? { ready_companies: input.readyCompanies } : {}),
  } : null;
  const population = veEstimatePopulation(estimate);
  const age = Date.parse(input.asOf) - Date.parse(estimate.population_as_of ?? '');
  const reason = population === null ? estimate.note ?? 'Размер сопоставимого источника пока неизвестен.'
    : !Number.isFinite(age) || age < 0 || age > VE_SOURCE_POPULATION_MAX_AGE_MS
      ? 'Счётчик источника требует обновления при следующей партии.'
      : !validCounts || input.candidates < 100 ? 'Для оценки нужно проверить не менее 100 компаний.'
        : input.ready === 0 ? 'Пока нет готовых контактов для оценки выхода.'
          : population < input.sourceCandidates ? 'Счётчик источника меньше обработанной выборки; требуется сверка.' : null;
  const scope = [VE_REMAINING_SCOPE,
    estimate.unsized_sources?.length ? `В прогноз не входят источники без размера рынка: ${estimate.unsized_sources.join(', ')}.` : '',
    input.complete ? '' : 'Последняя партия проверена не полностью, поэтому прогноз может быть занижен.',
  ].filter(Boolean).join(' ');
  return {
    ...estimate, observed_yield: observed,
    remaining_ready_estimate: reason ? null : estimateRemainingReady({
      population, candidatesProcessed: input.candidates, processedInPopulation: input.sourceCandidates,
      readyRows: input.ready, readyCompanies: input.readyCompanies,
      eligible: true, asOf: input.asOf, populationAsOf: estimate.population_as_of, scope,
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
  // Готовые контакты уже проверены: временный сбой поставщика после набранной
  // цели не делает базу упавшей. 23.09.2026 база 6b5bf9e8 с 718 готовыми из 500
  // ушла в failed на «Serper transient» и не дошла до «цель достигнута».
  const reached = result.readyRows >= progress.ready_target;
  if (result.error && !(reached && isVeTransientProviderError(result.error))) return { ...next, status: 'error', reason: result.error };
  if (reached) return { ...next, status: 'target_reached' };
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
  // A recognized idle round has its own bounded retry below. A single empty
  // page from a live source must not bypass that allowance.
  if (result.candidates === 0 && !result.validationRetry && !result.idle) {
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
