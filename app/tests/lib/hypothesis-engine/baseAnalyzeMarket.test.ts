/** @jest-environment node */

/**
 * Маркет-локализация стадии base_analyze (EN-пайплайн):
 *
 *   runBaseAnalyzeStage — выбирает промпт профиля базы по рынку проекта:
 *                         ctx.market='us' (воркер) или he_projects.market='us'
 *                         (фолбэк) → EN-промпт; 'ru'/отсутствующий market →
 *                         RU-промпт (обратная совместимость, RU-поведение не
 *                         меняется). Баг из скрин-ревью: анализ базы
 *                         us-проекта выходил на русском.
 */

jest.mock('server-only', () => ({}));

const mockCallLLM = jest.fn();
jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: (...args: unknown[]) => mockCallLLM(...args),
  getHeModel: () => 'test-model',
}));

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { runBaseAnalyzeStage } from '@/lib/hypothesisEngine/stages/baseAnalyze';
import type { HeJob } from '@/lib/hypothesisEngine/types';
import type { HeMarket } from '@/lib/hypothesisEngine/market';

const ANALYSIS = {
  geo_distribution: [{ value: 'US', share_pct: 100 }],
  industry_distribution: [],
  company_type_distribution: [],
  title_distribution: [],
  notable_segments: ['mostly banks'],
  data_quality_notes: 'ok',
  recommended_angles: ['geo angle'],
};

const BASE_ROW = {
  id: 'b1',
  project_id: 'p1',
  vertical_id: 'v1',
  filename: 'banks.csv',
  row_count: 2,
  status: 'collecting',
  columns: ['Company', 'Website'],
  sample_rows: [
    { Company: 'Acme Bank', Website: 'acme.com' },
    { Company: 'Beta Credit', Website: 'beta.example' },
  ],
};

function makeJob(): HeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage: 'base_analyze',
    status: 'running',
    payload: { base_id: 'b1' },
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-08T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-08T00:00:00Z',
    updated_at: '2026-08-08T00:00:00Z',
  };
}

/** system-промпт первого (и единственного) LLM-вызова стадии. */
function systemPromptOf(): string {
  const messages = mockCallLLM.mock.calls[0][0] as Array<{ role: string; content: string }>;
  return messages[0].content;
}

async function runStage(opts: { project?: Record<string, unknown>; market?: HeMarket }) {
  const tables: Record<string, Array<Record<string, unknown>>> = {
    he_bases: [BASE_ROW],
    he_verticals: [{ id: 'v1', name: 'Banks' }],
  };
  // Проект кладём только когда он передан: ветка ctx.market вообще не должна
  // читать he_projects (воркер уже знает рынок).
  if (opts.project) tables.he_projects = [opts.project];
  const db = createMockSupabase({ tables });
  mockCallLLM.mockResolvedValueOnce({ data: ANALYSIS, tokensUsed: 10, costUsd: 0.01 });
  const out = await runBaseAnalyzeStage(makeJob(), {
    supabase: db as unknown as SupabaseClient,
    ...(opts.market ? { market: opts.market } : {}),
  });
  return { db, out };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runBaseAnalyzeStage — выбор промпта по market', () => {
  it("ctx.market='us' → EN-промпт (воркер знает рынок, he_projects не читается)", async () => {
    const { out } = await runStage({ market: 'us' });

    expect(mockCallLLM).toHaveBeenCalledTimes(1);
    expect(systemPromptOf()).toContain('Respond strictly in English');
    expect(systemPromptOf()).not.toContain('Отвечай строго на русском');
    expect(out.result).toEqual(ANALYSIS);
    expect(out.tokensUsed).toBe(10);
  });

  it("без ctx.market фолбэк на he_projects.market='us' → EN-промпт", async () => {
    await runStage({ project: { id: 'p1', market: 'us' } });

    expect(systemPromptOf()).toContain('Respond strictly in English');
    expect(systemPromptOf()).not.toContain('Отвечай строго на русском');
  });

  it("ctx.market='ru' → RU-промпт, поведение не изменилось", async () => {
    await runStage({ market: 'ru' });

    expect(systemPromptOf()).toContain('Отвечай строго на русском');
  });

  it('без market (старая строка проекта) → RU-промпт (обратная совместимость)', async () => {
    const { db } = await runStage({ project: { id: 'p1' } });

    expect(systemPromptOf()).toContain('Отвечай строго на русском');
    // Анализ сохраняется в he_bases независимо от языка промпта.
    expect(
      db.updates.some(
        (u) => u.table === 'he_bases' && u.patch.status === 'analyzed' && 'analysis' in u.patch,
      ),
    ).toBe(true);
  });
});
