/** @jest-environment node */

/**
 * Оценка остатка рынка по гипотезе: «сколько ещё соберётся».
 *
 * Замер 22.09.2026: ни у одной из 83 завершённых баз числа не было. Здесь —
 * чистые функции: прогноз по всем обработанным компаниям (а не только по
 * закрытой партии) и карточка, которая показывает его в контактах и компаниях.
 */

import { updateCollectionEstimate, type VeCollectionEstimate } from '@/lib/verticalEngineV2/collectionTarget';
import { buildVeBaseAudienceSummary, type VeAudienceBase } from '@/lib/verticalEngineV2/baseAudienceSummary';

const POPULATION_AS_OF = '2026-09-22T09:00:00.000Z';
const AS_OF = '2026-09-22T10:00:00.000Z';

// Срез «Мясопереработка» после второй очереди: объединение 10.1 с порогами
// (954) и без них — 3 380 компаний на проде. Первая очередь проверена целиком.
const meatEstimate = (): VeCollectionEstimate => ({
  version: 2, population_method: 'plan_union', population_matches_source: true,
  population_as_of: POPULATION_AS_OF, population_filters: '[]',
  unique_companies: 3_380, available_companies: 3_380, companies_with_email: 2_383, slice_companies: [954, 3_380],
});
const meatRound = { candidates: 1_000, sourceCandidates: 954, ready: 40, readyCompanies: 30, asOf: AS_OF };

describe('remaining market estimate', () => {
  it('appears after an interrupted last batch instead of waiting for a closed one', () => {
    const next = updateCollectionEstimate(meatEstimate(), { ...meatRound, complete: false });
    expect(next.estimate_reason).toBeUndefined();
    expect(next.remaining_ready_estimate).toMatchObject({
      // (3 380 − 954) × 40 / 1 000 и (3 380 − 954) × 30 / 1 000.
      contacts: 97, companies: 73, remaining_companies: 2_426, confidence: 'low',
      source_population: 3_380, candidates_processed: 1_000, processed_in_population: 954, ready_rows: 40, ready_companies: 30,
    });
    expect(next.remaining_ready_estimate?.scope).toContain('Последняя партия проверена не полностью');
    expect(next.observed_yield).toMatchObject({ candidates: 1_000, ready: 40, ready_companies: 30 });
  });

  it('forecasts only from a population counted with the collector predicate', () => {
    // Старая оценка (приблизительный ОКВЭД) пересчитывается, а не экстраполируется.
    const legacy = { ...meatEstimate(), population_method: undefined, note: 'Размер источника и выборка не совпадают по фильтрам; прогноз не рассчитан.' };
    expect(updateCollectionEstimate(legacy, { ...meatRound, complete: true })).toMatchObject({
      remaining_ready_estimate: null, estimate_reason: 'Размер источника и выборка не совпадают по фильтрам; прогноз не рассчитан.' });
    // Компаний других баз проекта в доступном остатке нет.
    const shared = updateCollectionEstimate({ ...meatEstimate(), available_companies: 3_000 }, { ...meatRound, complete: true });
    expect(shared.remaining_ready_estimate).toMatchObject({ source_population: 3_000, remaining_companies: 2_046, contacts: 82 });
    expect(shared.remaining_ready_estimate?.scope).not.toContain('не полностью');
  });

  it('shows the estimate on the card in contacts and companies, dated, also days later and after launches', () => {
    const estimate = updateCollectionEstimate(meatEstimate(), { ...meatRound, complete: true });
    const base: VeAudienceBase = {
      id: 'b1', project_id: 'p1', hypothesis_id: 'h1', source: 'auto', status: 'analyzed', updated_at: AS_OF,
      columns: ['company', 'email'],
      data: [{ company: 'Мясокомбинат Восток', email: 'info@vostok.test' }, { company: 'Колбасный завод Юг', email: 'sales@yug.test' }],
      collect_info: { collection_mode: 'preview', estimate, target_progress: {
        mode: 'preview', ready_target: 500, ready_rows: 40, candidates_processed: 1_000, round: 9, max_rounds: 100,
        max_candidates: 10_000, status: 'limited', reason: 'Источники выбранного плана исчерпаны' } },
    };
    // Завершённая база, открытая через двое суток; часть контактов уже в кампаниях.
    const summary = buildVeBaseAudienceSummary(base, {
      now: new Date('2026-09-24T12:00:00.000Z'), allocated: new Set(['info@vostok.test']),
    });
    expect(summary.estimate).toMatchObject({ contacts: 97, companies: 73, as_of: AS_OF });
    expect(summary.estimate_reason).toBeNull();
  });

  it('explains a base collected before the fix instead of blaming an unfinished batch', () => {
    const base: VeAudienceBase = {
      id: 'b1', project_id: 'p1', hypothesis_id: 'h1', source: 'auto', status: 'analyzed', updated_at: AS_OF, columns: [], data: [],
      collect_info: { estimate: { version: 2, unique_companies: 0, companies_with_email: 0, population_matches_source: false,
        estimate_reason: 'Проверка текущей партии ещё не завершена.' }, target_progress: {
        mode: 'preview', ready_target: 500, ready_rows: 0, candidates_processed: 70, round: 2, max_rounds: 100,
        max_candidates: 10_000, status: 'limited' } },
    };
    const summary = buildVeBaseAudienceSummary(base, { now: new Date('2026-09-24T12:00:00.000Z') });
    expect(summary.estimate).toBeNull();
    expect(summary.estimate_reason).toContain('собрана до исправления счётчика');
  });
});
