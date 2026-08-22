/** @jest-environment node */

/**
 * Повторный прогон base_collect по уже завершённой базе.
 *
 * Честный провал сборки (напр. ноль строк) ставит ve_bases в 'failed' и бросает
 * ошибку — воркер повторяет ту же джобу до MAX_ATTEMPTS, и каждая попытка
 * спотыкается о guard «status != collecting», затирая настоящую причину своим
 * сообщением. Поэтому уже завершённая сборка (analyzing/analyzed/failed) —
 * no-op, а не ошибка: причина остаётся в ve_bases.error. База, которая сборку
 * не начинала ('uploaded'), по-прежнему ошибка — это неправильная база.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from '@/lib/verticalEngineV2/types';

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
}));

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getVeModel: jest.fn(() => 'test-bulk-model'),
}));

import { runBaseCollectStage } from '@/lib/verticalEngineV2/stages/baseCollect';

const PROJECT = { id: 'p1', name: 'P', created_by: 'user-1' };
const VERTICAL = {
  id: 'v1',
  project_id: 'p1',
  name: 'HR-агентства',
  summary: 'Подбор персонала',
  synonyms: [],
  potential_pct: 50,
  rank: 1,
};

function makeBase(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'b1',
    project_id: 'p1',
    vertical_id: 'v1',
    filename: 'auto: HR-агентства',
    row_count: 0,
    columns: [],
    sample_rows: [],
    data: [],
    status: 'collecting',
    source: 'auto',
    collect_info: null,
    error: null,
    ...overrides,
  };
}

function makeJob(): VeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage: 'base_collect',
    status: 'running',
    payload: { base_id: 'b1' },
    result: null,
    attempts: 2,
    error: null,
    started_at: '2026-08-21T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-21T00:00:00Z',
    updated_at: '2026-08-21T00:00:00Z',
  };
}

function seed(baseOverrides: Record<string, unknown>): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      ve_bases: [makeBase(baseOverrides)],
      ve_verticals: [VERTICAL],
      ve_projects: [PROJECT],
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('base_collect — уже завершённая база', () => {
  it.each(['failed', 'analyzed', 'analyzing'])(
    'does not retry a base whose collection already finished (%s)',
    async (status) => {
      const mockDb = seed({ status, error: 'ноль строк: сегмент исчерпан' });

      await expect(
        runBaseCollectStage(makeJob(), { supabase: mockDb as unknown as SupabaseClient }),
      ).resolves.toMatchObject({
        result: { base_id: 'b1', skipped: 'already_finished', base_status: status },
      });

      expect(mockDb.mutations).toEqual([]);
      expect(mockDb.getRows('ve_bases')[0].error).toBe('ноль строк: сегмент исчерпан');
    },
  );

  it('still rejects a base that never started collecting', async () => {
    const mockDb = seed({ status: 'uploaded' });

    await expect(
      runBaseCollectStage(makeJob(), { supabase: mockDb as unknown as SupabaseClient }),
    ).rejects.toThrow(/status='uploaded'/);
  });

  it('still rejects a base that was uploaded by hand', async () => {
    const mockDb = seed({ source: 'upload', status: 'uploaded' });

    await expect(
      runBaseCollectStage(makeJob(), { supabase: mockDb as unknown as SupabaseClient }),
    ).rejects.toThrow(/source='upload'/);
  });
});
