/** @jest-environment node */

/**
 * Калибровка стадии hypotheses (и разделяемые ею загрузчики):
 *
 *   aggregateMarkupHistory — чистая агрегация: частоты title по статусам,
 *                            топ-N, точный матчинг title, прочие статусы
 *                            и пустые title игнорируются;
 *   runHypothesesStage     — передаёт portfolioProfile (getPortfolioProfile,
 *                            limit 10) и markupHistory (accepted/rejected
 *                            чужих проектов) в промпт-билдер мгновенного
 *                            прохода; деградирует молча: сбой datasetStats
 *                            или he_hypotheses → поля нет, стадия доезжает.
 */

jest.mock('server-only', () => ({}));

const mockGetPortfolioProfile = jest.fn();
const mockBuildHypotheses = jest.fn((_input: unknown) => [{ role: 'user', content: 'prompt' }]);

jest.mock('@/lib/hypothesisEngine/datasetStats', () => ({
  getPortfolioProfile: (opts?: { limit?: number }) => mockGetPortfolioProfile(opts),
}));

jest.mock('@/lib/hypothesisEngine/prompts/hypotheses', () => ({
  buildHypothesesInstantMessages: (input: unknown) => mockBuildHypotheses(input),
}));

jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getHeModel: jest.fn(() => 'test-model'),
}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { callLLMWithSchema } from '@/lib/hypothesisEngine/llm';
import { aggregateMarkupHistory, runHypothesesStage } from '@/lib/hypothesisEngine/stages/hypotheses';
import type { HePortfolioEntry } from '@/lib/hypothesisEngine/datasetStats';
import type { HeJob } from '@/lib/hypothesisEngine/types';

const callLLMMock = callLLMWithSchema as unknown as jest.Mock;

const PROJECT = {
  id: 'p1',
  name: 'P',
  website_url: 'https://client.ru',
  brief: { site_profile: { company_name: 'Клиент', product_summary: 'Продукт' } },
};

const PORTFOLIO: HePortfolioEntry[] = [
  { segment: 'logistics_transport', campaigns: 12, clients: 5, sent: 50000, replies: 800, reply_pct: 1.6 },
  { segment: 'it_software_saas', campaigns: 30, clients: 11, sent: 120000, replies: 600, reply_pct: 0.5 },
];

const CANDIDATES = [
  { tier: 1, title: 'Логистика', description: 'd', fit_rationale: 'f', rationale: 'r', potential_pct: 60, search_queries: ['q1'] },
  { tier: 3, title: 'Ветклиники', description: 'd', fit_rationale: 'f', rationale: 'r', potential_pct: 25, search_queries: ['q2'] },
];

function makeJob(overrides: Partial<HeJob> = {}): HeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage: 'hypotheses',
    status: 'running',
    payload: {},
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-02T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-02T00:00:00Z',
    updated_at: '2026-08-02T00:00:00Z',
    ...overrides,
  };
}

/** Разметка других проектов + шум, который не должен протечь в калибровку. */
const HYPOTHESES_ROWS = [
  { project_id: 'p1', title: 'Своя принятая', status: 'accepted' }, // текущий проект — исключается
  { project_id: 'p1', title: 'Своя отклонённая', status: 'rejected' }, // текущий проект — исключается
  { project_id: 'p2', title: 'Логистика', status: 'accepted' },
  { project_id: 'p2', title: 'Логистика', status: 'accepted' },
  { project_id: 'p3', title: 'Логистика', status: 'accepted' }, // 3× → топ-1
  { project_id: 'p2', title: 'Фарма', status: 'accepted' },
  { project_id: 'p3', title: 'Фарма', status: 'accepted' }, // 2× → топ-2
  { project_id: 'p2', title: 'Стоматологии', status: 'rejected' },
  { project_id: 'p3', title: 'Стоматологии', status: 'rejected' }, // 2× → топ-1
  { project_id: 'p2', title: 'Тендерные площадки', status: 'rejected' }, // 1× → топ-2
  { project_id: 'p2', title: 'Черновик без вердикта', status: 'proposed' }, // игнорируется
];

function seedStage(options: { hypothesesError?: string } = {}): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      he_projects: [PROJECT],
      he_hypotheses: HYPOTHESES_ROWS,
    },
    errorTables: options.hypothesesError ? { he_hypotheses: options.hypothesesError } : undefined,
  });
}

function promptInput(): Record<string, unknown> {
  expect(mockBuildHypotheses).toHaveBeenCalledTimes(1);
  return mockBuildHypotheses.mock.calls[0][0] as unknown as Record<string, unknown>;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetPortfolioProfile.mockResolvedValue(PORTFOLIO);
  callLLMMock.mockResolvedValue({
    data: { hypotheses: CANDIDATES },
    tokensUsed: 10,
    costUsd: 0.01,
  });
});

describe('aggregateMarkupHistory', () => {
  it('считает частоты раздельно по статусам и сортирует по убыванию', () => {
    const rows = [
      { title: 'A', status: 'accepted' },
      { title: 'A', status: 'accepted' },
      { title: 'A', status: 'accepted' },
      { title: 'B', status: 'accepted' },
      { title: 'C', status: 'rejected' },
      { title: 'C', status: 'rejected' },
      { title: 'D', status: 'rejected' },
      { title: 'Черновик', status: 'proposed' }, // не accepted/rejected — игнор
      { title: '   ', status: 'accepted' }, // пустой title — игнор
      { status: 'accepted' }, // без title — игнор
    ];
    expect(aggregateMarkupHistory(rows)).toEqual({
      accepted: ['A', 'B'],
      rejected: ['C', 'D'],
    });
  });

  it('держит топ-N по частоте и отсекает хвост', () => {
    // T_k встречается k раз (k = 1..12) → в топ-10 входят T12..T3, T1/T2 отрезаны.
    const rows: Array<{ title: string; status: string }> = [];
    for (let k = 1; k <= 12; k += 1) {
      for (let i = 0; i < k; i += 1) rows.push({ title: `T${k}`, status: 'accepted' });
    }
    const { accepted } = aggregateMarkupHistory(rows);
    expect(accepted).toEqual(['T12', 'T11', 'T10', 'T9', 'T8', 'T7', 'T6', 'T5', 'T4', 'T3']);
  });

  it('точный матчинг title: регистр значим, trim склеивает пробелы по краям', () => {
    const rows = [
      { title: 'Банки', status: 'accepted' },
      { title: '  Банки  ', status: 'accepted' }, // сливается с 'Банки'
      { title: 'банки', status: 'accepted' }, // другой регистр — отдельный title
    ];
    expect(aggregateMarkupHistory(rows)).toEqual({ accepted: ['Банки', 'банки'], rejected: [] });
  });

  it('явный limit переопределяет дефолтный топ-10', () => {
    const rows = [
      { title: 'A', status: 'rejected' },
      { title: 'A', status: 'rejected' },
      { title: 'B', status: 'rejected' },
      { title: 'C', status: 'rejected' },
    ];
    expect(aggregateMarkupHistory(rows, 2).rejected).toEqual(['A', 'B']);
  });
});

describe('runHypothesesStage — калибровочные данные в промпте', () => {
  it('передаёт portfolioProfile (limit 10) и markupHistory чужих проектов в билдер', async () => {
    const db = seedStage();
    const out = await runHypothesesStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    expect(mockGetPortfolioProfile).toHaveBeenCalledWith({ limit: 10 });
    const input = promptInput();
    expect(input.portfolioProfile).toEqual(PORTFOLIO);
    expect(input.markupHistory).toEqual({
      accepted: ['Логистика', 'Фарма'],
      rejected: ['Стоматологии', 'Тендерные площадки'],
    });

    // Стадия доехала: кандидаты из LLM-ответа в результате, usage просуммирован.
    const result = out.result as { candidates: unknown[]; tier_counts: Record<string, number> };
    expect(result.candidates).toHaveLength(2);
    expect(result.tier_counts).toEqual({ '1': 1, '3': 1 });
    expect(out.tokensUsed).toBe(10);
  });

  it('сбой datasetStats → portfolioProfile нет, markupHistory на месте, стадия доезжает', async () => {
    mockGetPortfolioProfile.mockRejectedValue(new Error('dataset down'));
    const db = seedStage();
    const out = await runHypothesesStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const input = promptInput();
    expect(input.portfolioProfile).toBeUndefined();
    expect(input.markupHistory).toEqual({
      accepted: ['Логистика', 'Фарма'],
      rejected: ['Стоматологии', 'Тендерные площадки'],
    });
    expect((out.result as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('сбой чтения he_hypotheses → markupHistory нет, portfolioProfile на месте, стадия доезжает', async () => {
    const db = seedStage({ hypothesesError: 'db down' });
    const out = await runHypothesesStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const input = promptInput();
    expect(input.portfolioProfile).toEqual(PORTFOLIO);
    expect(input.markupHistory).toBeUndefined();
    expect((out.result as { candidates: unknown[] }).candidates).toHaveLength(2);
  });

  it('без разметки в других проектах → пустые списки accepted/rejected', async () => {
    const db = createMockSupabase({ tables: { he_projects: [PROJECT] } });
    await runHypothesesStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    expect(promptInput().markupHistory).toEqual({ accepted: [], rejected: [] });
  });
});
