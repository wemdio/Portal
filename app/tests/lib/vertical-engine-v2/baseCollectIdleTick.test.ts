/** @jest-environment node */

/**
 * Холостой тик стадии base_collect: дешёвый вход и растущая пауза.
 *
 * Два контракта, проверенные здесь, стоят прода:
 *  1. Тик, который заканчивается «сборка уже завершена», НЕ читает строку
 *     ve_bases целиком. На активной базе collect_info весит 16-62 МБ, и это
 *     чтение идёт через main-rest.
 *  2. Раунд, не сдвинувший ни одного счётчика прогресса, удваивает паузу
 *     перед следующим пробуждением. 21.09.2026 база уходила в 18 подряд
 *     раундов без единого обращения к провайдеру, просыпаясь через секунду.
 */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  VE_BASE_COLLECT_PROBE_COLUMNS,
  VE_IDLE_REQUEUE_MAX_MS,
  veBaseCollectFinished,
  veIdleRequeueMs,
  veNextIdleRounds,
  veProbeCollectionMode,
  veRoundAdvanced,
} from '@/lib/verticalEngineV2/baseCollectIdle';
import { runBaseCollectStage } from '@/lib/verticalEngineV2/stages/baseCollect';
import type { VeCollectionTargetProgress } from '@/lib/verticalEngineV2/collectionTarget';
import type { VeJob } from '@/lib/verticalEngineV2/types';

describe('узкая проекция входа стадии', () => {
  it('не просит ни одной тяжёлой колонки', () => {
    for (const heavy of ['collect_info,', 'collect_info ', 'data', 'sample_rows', 'analysis']) {
      expect(VE_BASE_COLLECT_PROBE_COLUMNS.includes(heavy)).toBe(false);
    }
    // Режим нужен для ветки analyzing+preview и берётся jsonb-путём: PostgREST
    // вычисляет его в SQL, наружу едет одна строка, а не весь документ.
    expect(VE_BASE_COLLECT_PROBE_COLUMNS).toContain('collection_mode:collect_info->>collection_mode');
    expect(VE_BASE_COLLECT_PROBE_COLUMNS).toContain('status');
    expect(VE_BASE_COLLECT_PROBE_COLUMNS).toContain('source');
  });

  it('читает режим из проекции, а при её отсутствии — из документа', () => {
    expect(veProbeCollectionMode({ collection_mode: 'preview' })).toBe('preview');
    expect(veProbeCollectionMode({ collect_info: { collection_mode: 'supply' } })).toBe('supply');
    // Проекция главнее: она и есть то, что реально прочитано из БД.
    expect(veProbeCollectionMode({ collection_mode: 'preview', collect_info: { collection_mode: 'supply' } }))
      .toBe('preview');
    expect(veProbeCollectionMode({})).toBeNull();
    expect(veProbeCollectionMode({ collection_mode: '   ' })).toBeNull();
  });

  it.each(['analyzing', 'analyzed', 'failed'])('признаёт статус %s завершённым', (status) => {
    expect(veBaseCollectFinished(status)).toBe(true);
  });

  it.each(['collecting', 'pending', null, undefined, 42])('не признаёт %s завершённым', (status) => {
    expect(veBaseCollectFinished(status)).toBe(false);
  });
});

describe('завершённая база не читается целиком', () => {
  const job = (): VeJob => ({
    id: 'job-idle', project_id: 'p1', stage: 'base_collect', status: 'running',
    payload: { base_id: 'b1', hypothesis_id: 'h1' }, result: null, attempts: 0, error: null,
    started_at: '2026-09-21T00:00:00Z', tokens_used: 0, cost_usd: 0,
    created_at: '2026-09-21T00:00:00Z', updated_at: '2026-09-21T00:00:00Z',
  });

  const seed = (status: string) => createMockSupabase({
    tables: {
      ve_bases: [{
        id: 'b1', project_id: 'p1', vertical_id: 'v1', hypothesis_id: 'h1', source: 'auto',
        filename: 'auto: завершённая база', row_count: 3, columns: [], sample_rows: [], data: [],
        status, error: null,
        // Тяжёлый документ: тест провалится, если вход всё же прочитает строку
        // целиком — проекция запроса к ve_bases окажется '*'.
        collect_info: { collection_mode: 'supply', relevance_reserve: { version: 1, rows: [] } },
      }],
      ve_projects: [{ id: 'p1', name: 'P', created_by: 'user-1', market: 'ru' }],
      ve_verticals: [{ id: 'v1', project_id: 'p1', name: 'V', summary: '', synonyms: [], potential_pct: 50, rank: 1 }],
      ve_jobs: [job() as unknown as Record<string, unknown>],
    },
  });

  it.each(['analyzed', 'failed'])('статус %s отвечает по узкому чтению', async (status) => {
    const db = seed(status);
    const result = await runBaseCollectStage(job(), { supabase: db as unknown as SupabaseClient });
    expect(result.result).toEqual({ base_id: 'b1', skipped: 'already_finished', base_status: status });
    const baseReads = db.selects.filter((query) => query.table === 've_bases');
    expect(baseReads).toHaveLength(1);
    expect(baseReads[0].columns).toBe(VE_BASE_COLLECT_PROBE_COLUMNS);
  });
});

describe('пауза растёт только без продвижения', () => {
  const round = (over: Partial<VeCollectionTargetProgress> = {}): VeCollectionTargetProgress => ({
    mode: 'preview', ready_target: 500, ready_rows: 10, candidates_processed: 100,
    round: 2, max_rounds: 80, max_candidates: 10_000, status: 'collecting', ...over,
  });

  it('любой сдвинутый счётчик считается продвижением', () => {
    const previous = round({});
    expect(veRoundAdvanced(previous, round({ round: 3 }))).toBe(true);
    expect(veRoundAdvanced(previous, round({ candidates_processed: 101 }))).toBe(true);
    expect(veRoundAdvanced(previous, round({ ready_rows: 11 }))).toBe(true);
    expect(veRoundAdvanced(previous, round({}))).toBe(false);
    // Откат счётчика продвижением не считается: пауза должна расти и тут.
    expect(veRoundAdvanced(previous, round({ ready_rows: 9 }))).toBe(false);
  });

  it('терминальный раунд и первый раунд паузу не растят', () => {
    expect(veRoundAdvanced(round({}), round({ status: 'limited' }))).toBe(true);
    expect(veRoundAdvanced(undefined, round({}))).toBe(true);
  });

  it('счётчик простоя обнуляется продвижением и растёт без него', () => {
    expect(veNextIdleRounds(true, 7)).toBe(0);
    expect(veNextIdleRounds(false, 0)).toBe(1);
    expect(veNextIdleRounds(false, 7)).toBe(8);
    // Мусор из старого collect_info не должен давать отрицательную паузу.
    expect(veNextIdleRounds(false, -3)).toBe(1);
    expect(veNextIdleRounds(false, 'x')).toBe(1);
  });

  it('удваивает паузу и упирается в потолок', () => {
    expect(veIdleRequeueMs(1_000, 0)).toBe(1_000);
    expect(veIdleRequeueMs(1_000, 1)).toBe(2_000);
    expect(veIdleRequeueMs(1_000, 4)).toBe(16_000);
    expect(veIdleRequeueMs(1_000, 9)).toBe(VE_IDLE_REQUEUE_MAX_MS);
    expect(veIdleRequeueMs(30_000, 1)).toBe(60_000);
    expect(veIdleRequeueMs(30_000, 100)).toBe(VE_IDLE_REQUEUE_MAX_MS);
    // Испорченный счётчик не должен дать Infinity в run_after.
    expect(Number.isFinite(veIdleRequeueMs(1_000, Number.MAX_SAFE_INTEGER))).toBe(true);
    expect(veIdleRequeueMs(1_000, 1.5)).toBe(1_000);
  });
});
