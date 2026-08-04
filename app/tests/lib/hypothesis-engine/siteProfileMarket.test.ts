/** @jest-environment node */

/**
 * Маркет-локализация стадии site_profile (Пункт 2 EN-пайплайна):
 *
 *   runSiteProfileStage — выбирает промпт по he_projects.market:
 *                         'us' → EN-промпт (профиль и извлечение кейсов),
 *                         отсутствующий/'ru' market → RU-промпт (обратная
 *                         совместимость, RU-поведение не меняется);
 *   CASE_PAGE_PATHS     — слепой перебор кейс-страниц дополнен EN-путями
 *                         (/case-studies, /testimonials, /customers, …);
 *                         EN-пути добавлены всегда, RU-пути сохранены.
 */

jest.mock('server-only', () => ({}));

const mockCallLLM = jest.fn();
jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: (...args: unknown[]) => mockCallLLM(...args),
  getHeModel: () => 'test-model',
}));

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { CASE_PAGE_PATHS, runSiteProfileStage } from '@/lib/hypothesisEngine/stages/siteProfile';
import type { HeJob } from '@/lib/hypothesisEngine/types';

const PROFILE_DATA = {
  company_name: 'Client',
  product_summary: 'Sells CRM software to dental clinics.',
  usp: ['Fast onboarding'],
  price_tier: 'medium',
  deal_cycle: 'self-service',
  target_audience: 'dental clinics',
  current_clients: [],
  cases: [],
  geo: 'US',
  business_model: 'SaaS',
};

const PROJECT_US = {
  id: 'p-us',
  name: 'US client',
  website_url: 'https://client.com',
  brief: null,
  status: 'draft',
  market: 'us',
};

/** Проект без колонки market (старая строка) — должен вести себя как RU. */
const PROJECT_RU = {
  id: 'p-ru',
  name: 'RU client',
  website_url: 'https://client.ru',
  brief: null,
  status: 'draft',
};

function makeJob(projectId: string): HeJob {
  return {
    id: 'job-1',
    project_id: projectId,
    stage: 'site_profile',
    status: 'running',
    payload: {},
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-03T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-03T00:00:00Z',
    updated_at: '2026-08-03T00:00:00Z',
  };
}

/** system-промпт n-ного LLM-вызова (0 — профиль, 1 — извлечение кейсов). */
function systemOf(callIndex: number): string {
  const messages = mockCallLLM.mock.calls[callIndex][0] as Array<{ role: string; content: string }>;
  return messages[0].content;
}

/** Прогон стадии с моками: fetchText короткий (< MIN_PAGE_CHARS) → кейс-страницы не собираются. */
async function runStage(project: Record<string, unknown>) {
  const db = createMockSupabase({ tables: { he_projects: [project] } });
  mockCallLLM
    .mockResolvedValueOnce({ data: PROFILE_DATA, tokensUsed: 10, costUsd: 0.01 })
    .mockResolvedValueOnce({ data: { cases: [] }, tokensUsed: 5, costUsd: 0.005 });
  const out = await runSiteProfileStage(makeJob(project.id as string), {
    supabase: db as unknown as SupabaseClient,
    fetchText: async () => 'Client sells CRM software to dental clinics.',
  });
  return { db, out };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('runSiteProfileStage — выбор промпта по market', () => {
  it("market='us' → EN-промпт и для профиля, и для извлечения кейсов", async () => {
    const { out } = await runStage(PROJECT_US);

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(systemOf(0)).toContain('Answer strictly in English');
    expect(systemOf(0)).not.toContain('Отвечай строго на русском');
    expect(systemOf(1)).toContain('Answer strictly in English');
    expect(systemOf(1)).not.toContain('Отвечай строго на русском');
    expect(out.result).toEqual(PROFILE_DATA);
    expect(out.tokensUsed).toBe(15);
  });

  it('без market (старая строка) → RU-промпт, поведение не изменилось', async () => {
    const { out } = await runStage(PROJECT_RU);

    expect(mockCallLLM).toHaveBeenCalledTimes(2);
    expect(systemOf(0)).toContain('Отвечай строго на русском');
    expect(systemOf(1)).toContain('Отвечай строго на русском');
    expect(out.result).toEqual(PROFILE_DATA);
  });

  it("market='ru' → RU-промпт", async () => {
    await runStage({ ...PROJECT_RU, market: 'ru' });
    expect(systemOf(0)).toContain('Отвечай строго на русском');
  });
});

describe('CASE_PAGE_PATHS — EN-пути кейс-страниц', () => {
  it.each(['/case-studies', '/cases', '/testimonials', '/customers', '/reviews', '/projects'])(
    'содержит EN-путь %s',
    (path) => {
      expect(CASE_PAGE_PATHS).toContain(path);
    },
  );

  it.each(['/kejsy', '/otzyvy', '/clients', '/portfolio', '/works'])(
    'RU-путь %s сохранён',
    (path) => {
      expect(CASE_PAGE_PATHS).toContain(path);
    },
  );
});
