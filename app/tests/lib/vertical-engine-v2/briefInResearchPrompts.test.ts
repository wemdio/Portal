/** @jest-environment node */

/**
 * Бриф клиента как второй источник ресёрча.
 *
 * Сайт остаётся основой профиля, но бриф закрывает то, чего на сайте не
 * бывает (цикл сделки, средний чек, возражения, кто ЛПР) — и спасает клиентов
 * без рабочего сайта. Поэтому обе стадии, где решается «кому продаём»,
 * обязаны видеть бриф: site_profile и hypotheses.
 */

jest.mock('server-only', () => ({}));

const mockCallLLM = jest.fn();
jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: (...args: unknown[]) => mockCallLLM(...args),
  callLLMText: (...args: unknown[]) => mockCallLLM(...args),
  getVeModel: () => 'test-model',
  setVeActiveJobSignal: () => {},
}));

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

import { runSiteProfileStage } from '@/lib/verticalEngineV2/stages/siteProfile';
import { runHypothesesStage } from '@/lib/verticalEngineV2/stages/hypotheses';
import type { VeJob } from '@/lib/verticalEngineV2/types';

const CLIENT_BRIEF = {
  fields: {
    company_description: 'Консалтинг по ВЭД для владельцев товарного бизнеса',
    deal_cycle: 'от 3 до 6 недель от первого касания до оплаты',
    avg_check: 'пакеты 5 / 10 / 25 млн ₽',
    target_audience: 'Собственники и генеральные директора компаний, зависящих от импорта',
    common_questions: '«Не вырастет ли себестоимость при переходе на белую схему?»',
  },
  missing: ['special_offer', 'lead_magnets'],
  file_name: 'amb.docx',
  uploaded_at: '2026-08-22T10:00:00.000Z',
};

const PROFILE_DATA = {
  company_name: 'Фомичева',
  product_summary: 'Системный консалтинг по ВЭД.',
  usp: ['Белые схемы'],
  price_tier: 'high',
  deal_cycle: '',
  target_audience: 'импортёры',
  current_clients: [],
  cases: [],
  geo: 'RU',
  business_model: 'b2b-услуги',
};

function project(brief: Record<string, unknown> | null) {
  return {
    id: 'p1',
    created_by: 'user-1',
    name: 'АМБ',
    website_url: 'https://amb.example/',
    brief,
    status: 'draft',
    market: 'ru',
  };
}

function makeJob(stage: VeJob['stage']): VeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage,
    status: 'running',
    payload: {},
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-22T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-22T00:00:00Z',
    updated_at: '2026-08-22T00:00:00Z',
  };
}

/** user-промпт n-ного LLM-вызова. */
function userOf(callIndex: number): string {
  const messages = mockCallLLM.mock.calls[callIndex][0] as Array<{ role: string; content: string }>;
  return messages.map((m) => m.content).join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('site_profile получает бриф', () => {
  async function runSiteProfile(brief: Record<string, unknown> | null) {
    const db = createMockSupabase({ tables: { ve_projects: [project(brief)] } });
    mockCallLLM
      .mockResolvedValueOnce({ data: PROFILE_DATA, tokensUsed: 10, costUsd: 0.01 })
      .mockResolvedValueOnce({ data: { cases: [] }, tokensUsed: 5, costUsd: 0.005 });
    await runSiteProfileStage(makeJob('site_profile'), {
      supabase: db as unknown as SupabaseClient,
      fetchText: async () => 'Прототип лендинга под консалтинг по ВЭД.',
    });
    return db;
  }

  it('кладёт бриф в промпт профиля, когда он загружен', async () => {
    await runSiteProfile({ client_brief: CLIENT_BRIEF });

    const prompt = userOf(0);
    expect(prompt).toContain('БРИФ КЛИЕНТА');
    expect(prompt).toContain('от 3 до 6 недель');
    expect(prompt).toContain('Собственники и генеральные директора');
  });

  it('без брифа промпт профиля не меняется', async () => {
    await runSiteProfile(null);
    expect(userOf(0)).not.toContain('БРИФ КЛИЕНТА');
  });

  it('сохраняет client_brief при перезаписи brief стадией', async () => {
    const db = await runSiteProfile({ client_brief: CLIENT_BRIEF });

    const brief = db.getRows('ve_projects')[0].brief as Record<string, unknown>;
    expect(brief.site_profile).toEqual(PROFILE_DATA);
    expect((brief.client_brief as { file_name: string }).file_name).toBe('amb.docx');
  });
});

describe('hypotheses получают бриф', () => {
  it('кладёт бриф в промпт гипотез рядом с профилем сайта', async () => {
    const db = createMockSupabase({
      tables: {
        ve_projects: [
          project({
            client_brief: CLIENT_BRIEF,
            site_profile: PROFILE_DATA,
            brand_cloud: { entities: [] },
          }),
        ],
        ve_jobs: [
          {
            id: 'j-competitors',
            project_id: 'p1',
            stage: 'competitors',
            status: 'done',
            result: { competitors: [] },
          },
          {
            id: 'j-brand',
            project_id: 'p1',
            stage: 'brand_cloud',
            status: 'done',
            result: { entities: [] },
          },
        ],
        ve_hypotheses: [],
        ve_verticals: [],
      },
    });
    mockCallLLM.mockResolvedValue({
      data: { hypotheses: [] },
      tokensUsed: 10,
      costUsd: 0.01,
    });

    await runHypothesesStage(makeJob('hypotheses'), {
      supabase: db as unknown as SupabaseClient,
    });

    const prompt = userOf(0);
    expect(prompt).toContain('БРИФ КЛИЕНТА');
    expect(prompt).toContain('пакеты 5 / 10 / 25 млн');
  });
});
