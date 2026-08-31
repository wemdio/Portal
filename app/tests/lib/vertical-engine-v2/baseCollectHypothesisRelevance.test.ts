/** @jest-environment node */

/**
 * Base-per-hypothesis wiring for the final relevance gate.
 *
 * The source plan already uses the base's hypothesis. The final quality gate
 * must use that same row as well; otherwise a broad vertical can let a nearby
 * but wrong niche through immediately before launch.
 */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from '@/lib/verticalEngineV2/types';

const mockCallLLM = jest.fn();

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
}));

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: (...args: unknown[]) => mockCallLLM(...args),
  getVeModel: () => 'test-gate-model',
}));

import {
  runBaseCollectStage,
  type VeCollectInfo,
  type VeUnifiedRow,
} from '@/lib/verticalEngineV2/stages/baseCollect';

const PROJECT_ID = 'project-hypothesis-gate';
const VERTICAL_ID = 'vertical-private-healthcare';

const HYPOTHESES = [
  {
    id: 'hyp-clinics',
    project_id: PROJECT_ID,
    vertical_id: VERTICAL_ID,
    title: 'Сети частных клиник',
    description: 'Городские многопрофильные клиники с несколькими филиалами',
    tier: 1,
    status: 'accepted',
  },
  {
    id: 'hyp-pharma',
    project_id: PROJECT_ID,
    vertical_id: VERTICAL_ID,
    title: 'Производители лекарств',
    description: 'Фармацевтические производственные предприятия',
    tier: 2,
    status: 'accepted',
  },
];

const VERTICAL = {
  id: VERTICAL_ID,
  project_id: PROJECT_ID,
  name: 'Частная медицина',
  summary: 'Коммерческие медицинские организации России',
  synonyms: ['частные клиники'],
  potential_pct: 55,
  rank: 1,
};

const HARVEST_ROW: VeUnifiedRow = {
  company: 'ООО Проверяемая компания',
  website: 'company.example',
  email: 'hello@company.example',
  phone: '',
  vacancy_title: '',
  address: 'Москва',
  category: '86.90.4',
  employees: '50',
  revenue: '100000000',
  inn: '7700000001',
  source_detail: 'реестр',
};

function collectInfo(hypothesisId: string): VeCollectInfo {
  const task = {
    source: 'companies_directory' as const,
    rationale: 'Точный срез реестра под гипотезу',
    directory_filters: { okvedCodes: ['86.2'], includeIp: false },
  };
  const hypothesis = HYPOTHESES.find((row) => row.id === hypothesisId)!;
  return {
    limit: 100,
    plan: { tasks: [task] },
    hypotheses: [{ id: hypothesis.id, title: hypothesis.title, status: hypothesis.status }],
    tasks: [
      {
        source: task.source,
        status: 'done',
        child_job_id: null,
        rows: 1,
        task,
        harvest: [HARVEST_ROW],
      },
    ],
    // Isolate the final quality gate: constructor behavior has its own tests.
    construct: { bc_job_id: 'constructor-complete', status: 'done' },
  };
}

function makeJob(baseId: string, hypothesisId: string): VeJob {
  return {
    id: `job-${baseId}`,
    project_id: PROJECT_ID,
    stage: 'base_collect',
    status: 'running',
    payload: { base_id: baseId, hypothesis_id: hypothesisId, limit: 100 },
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-30T08:00:00.000Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-30T08:00:00.000Z',
    updated_at: '2026-08-30T08:00:00.000Z',
  };
}

function promptFromOnlyLlmCall(): string {
  expect(mockCallLLM).toHaveBeenCalledTimes(1);
  const messages = mockCallLLM.mock.calls[0][0] as Array<{ role: string; content: string }>;
  return messages.map((message) => message.content).join('\n');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockCallLLM.mockResolvedValue({
    data: { irrelevant: [] },
    tokensUsed: 9,
    costUsd: 0.001,
  });
});

describe('base_collect relevance gate — exact base hypothesis', () => {
  it.each([
    ['hyp-clinics', 'Сети частных клиник', 'Производители лекарств'],
    ['hyp-pharma', 'Производители лекарств', 'Сети частных клиник'],
  ])(
    'uses %s for its own base instead of another hypothesis in the vertical',
    async (hypothesisId, expectedTitle, otherTitle) => {
      const baseId = `base-${hypothesisId}`;
      const db = createMockSupabase({
        tables: {
          ve_projects: [
            {
              id: PROJECT_ID,
              created_by: 'user-1',
              name: 'VBI',
              market: 'ru',
            },
          ],
          ve_verticals: [VERTICAL],
          ve_hypotheses: HYPOTHESES,
          ve_bases: [
            {
              id: baseId,
              project_id: PROJECT_ID,
              vertical_id: VERTICAL_ID,
              hypothesis_id: hypothesisId,
              filename: `auto: Частная медицина — ${expectedTitle}`,
              row_count: 0,
              columns: [],
              sample_rows: [],
              data: [],
              status: 'collecting',
              source: 'auto',
              collect_info: collectInfo(hypothesisId),
            },
          ],
          ve_jobs: [],
        },
      });

      await runBaseCollectStage(makeJob(baseId, hypothesisId), {
        supabase: db as unknown as SupabaseClient,
      });

      const prompt = promptFromOnlyLlmCall();
      expect(prompt).toContain(expectedTitle);
      expect(prompt).not.toContain(otherTitle);
      expect(prompt).toContain(
        HYPOTHESES.find((hypothesis) => hypothesis.id === hypothesisId)!.description,
      );
    },
  );

  it('fails closed when a base is bound to a hypothesis whose context cannot be loaded', async () => {
    const hypothesisId = 'hyp-missing';
    const baseId = 'base-hyp-missing';
    const info = collectInfo('hyp-clinics');
    info.hypotheses = [{ id: hypothesisId, title: 'Недоступная гипотеза', status: 'accepted' }];
    const db = createMockSupabase({
      tables: {
        ve_projects: [{
          id: PROJECT_ID,
          created_by: 'user-1',
          name: 'VBI',
          market: 'ru',
        }],
        ve_verticals: [VERTICAL],
        ve_hypotheses: [],
        ve_bases: [{
          id: baseId,
          project_id: PROJECT_ID,
          vertical_id: VERTICAL_ID,
          hypothesis_id: hypothesisId,
          filename: 'auto: Частная медицина — Недоступная гипотеза',
          row_count: 0,
          columns: [],
          sample_rows: [],
          data: [],
          status: 'collecting',
          source: 'auto',
          collect_info: info,
        }],
        ve_jobs: [],
      },
    });

    await runBaseCollectStage(makeJob(baseId, hypothesisId), {
      supabase: db as unknown as SupabaseClient,
    });

    expect(mockCallLLM).not.toHaveBeenCalled();
    const finalPatch = db.updates.filter((update) => update.table === 've_bases').at(-1)?.patch;
    expect(finalPatch?.data).toEqual([
      expect.objectContaining({
        company: HARVEST_ROW.company,
        _relevance_unchecked: true,
      }),
    ]);
    expect((finalPatch?.collect_info as VeCollectInfo).stats).toMatchObject({
      relevance_unchecked: 1,
      relevance_coverage_complete: false,
    });
  });
});
