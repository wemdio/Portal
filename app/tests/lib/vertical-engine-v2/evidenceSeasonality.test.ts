/** @jest-environment node */

/**
 * Evidence-stage owns the persisted seasonality assessment.  It may use a
 * dedicated evidence array (separate from the hypothesis' market evidence),
 * but every URL+quote still has to pass the same downloaded-source check.
 */

jest.mock('server-only', () => ({}));

const mockCallLLM = jest.fn();
const mockSearch = jest.fn();
const mockFetchText = jest.fn();
jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: (messages: unknown, schema: unknown, options: unknown) =>
    mockCallLLM(messages, schema, options),
  getVeModel: () => 'test-model',
}));

// RU portfolio calibration is unrelated to this contract and stays best-effort.
jest.mock('@/lib/verticalEngineV2/datasetStats', () => ({
  getPortfolioProfile: async () => [],
}));

jest.mock('@/lib/verticalEngineV2/scoreAnchor', () => ({
  anchorPotentialPct: async (pct: number) => ({
    applied: false,
    pct,
    note: 'not applied in seasonality contract test',
  }),
}));

// Avoid loading the website-parser graph: evidence receives both adapters in ctx.
jest.mock('@/lib/verticalEngineV2/stages/io', () => ({
  resolveSearch: (ctx: { search?: unknown }) => ctx.search,
  resolveFetchText: (ctx: { fetchText?: unknown }) => ctx.fetchText,
}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';

import { VeEvidenceVerdictSchema } from '@/lib/verticalEngineV2/schemas';
import { runEvidenceStage } from '@/lib/verticalEngineV2/stages/evidence';
import type { VeJob } from '@/lib/verticalEngineV2/types';

const PROJECT_ID = '00000000-0000-4000-8000-000000000491';
const SOURCE_URL = 'https://research.example/education-season';
const SOURCE_QUOTE = 'Основной набор учеников проходит с августа по сентябрь.';
const AVOID_SOURCE_QUOTE = 'С октября по май руководители школ не выбирают новых подрядчиков.';
const SOURCE_TEXT = `Отраслевой обзор рынка образования. ${SOURCE_QUOTE} ${AVOID_SOURCE_QUOTE}`;

const SEASONAL_EVIDENCE = {
  claim: 'Пик набора приходится на начало учебного года.',
  source_url: SOURCE_URL,
  quote: SOURCE_QUOTE,
};

const AVOID_EVIDENCE = {
  claim: 'С октября по май ЛПР школ недоступны для выбора подрядчиков.',
  source_url: SOURCE_URL,
  quote: AVOID_SOURCE_QUOTE,
};

const VERIFIED_SEASONALITY = {
  version: 1 as const,
  classification: 'seasonal' as const,
  confidence: 'high' as const,
  rationale: 'Набор и бюджеты привязаны к началу учебного года.',
  windows: [
    {
      kind: 'peak' as const,
      label: 'Набор к учебному году',
      start_mm_dd: '09-01',
      end_mm_dd: '09-30',
      lead_days: 45,
      evidence: [SEASONAL_EVIDENCE],
    },
    {
      kind: 'avoid' as const,
      label: 'Низкий сезон',
      start_mm_dd: '10-01',
      end_mm_dd: '05-31',
      evidence: [AVOID_EVIDENCE],
    },
  ],
  // This is deliberately independent from verdict.evidence below.
  evidence: [SEASONAL_EVIDENCE, AVOID_EVIDENCE],
};

const CANDIDATE = {
  tier: 1 as const,
  title: 'Частные школы и образовательные центры',
  description: 'Организации, которые набирают учеников на новый учебный год.',
  fit_rationale: 'Продукт помогает школе заполнить набор.',
  rationale: 'Прямая целевая аудитория.',
  potential_pct: 72,
  search_queries: ['частные школы сезон набора сентябрь'],
};

function makeJob(): VeJob {
  return {
    id: '00000000-0000-4000-8000-000000000492',
    project_id: PROJECT_ID,
    stage: 'evidence',
    status: 'running',
    payload: {},
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-28T10:00:00.000Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-28T10:00:00.000Z',
    updated_at: '2026-08-28T10:00:00.000Z',
  };
}

function baseVerdict(seasonality: unknown = VERIFIED_SEASONALITY): Record<string, unknown> {
  return {
    verdict: 'keep',
    merge_with_title: null,
    reason: 'Рынок и сезон подтверждены.',
    fit_rationale: CANDIDATE.fit_rationale,
    // General market evidence is allowed to be empty while dedicated
    // seasonality evidence above is independently verified.
    evidence: [],
    potential_pct: 72,
    seasonality,
  };
}

function seed(): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      ve_projects: [{
        id: PROJECT_ID,
        created_by: 'user-1',
        name: 'Образовательный продукт',
        website_url: 'https://client.example/',
        brief: {
          site_profile: {
            company_name: 'Клиент',
            product_summary: 'Маркетинговая платформа для школ.',
          },
        },
        status: 'researching',
        market: 'ru',
      }],
      ve_jobs: [{
        id: 'job-hypotheses',
        project_id: PROJECT_ID,
        stage: 'hypotheses',
        status: 'done',
        result: { candidates: [CANDIDATE] },
        created_at: '2026-08-28T09:00:00.000Z',
      }],
      ve_hypotheses: [],
    },
  });
}

async function runWithVerdict(verdict: Record<string, unknown>): Promise<MockSupabaseClient> {
  const db = seed();
  mockCallLLM.mockResolvedValueOnce({
    data: verdict,
    tokensUsed: 25,
    costUsd: 0.02,
  });

  await runEvidenceStage(makeJob(), {
    supabase: db as unknown as SupabaseClient,
    market: 'ru',
    search: mockSearch,
    fetchText: mockFetchText,
  });

  return db;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSearch.mockResolvedValue([{ title: 'Сезон набора', link: SOURCE_URL }]);
  mockFetchText.mockResolvedValue(SOURCE_TEXT);
});

describe('VeEvidenceVerdictSchema seasonality contract', () => {
  it('retains the structured RU seasonality payload', () => {
    const parsed = VeEvidenceVerdictSchema.parse(baseVerdict()) as Record<string, unknown>;

    expect(parsed.seasonality).toEqual(VERIFIED_SEASONALITY);
  });

  it.each([undefined, null])('normalizes absent/legacy %s seasonality to null', (seasonality) => {
    const verdict = baseVerdict(seasonality);
    if (seasonality === undefined) delete verdict.seasonality;

    const parsed = VeEvidenceVerdictSchema.parse(verdict) as Record<string, unknown>;
    expect(parsed.seasonality).toBeNull();
  });
});

describe('evidence-stage seasonality persistence', () => {
  it('adds bounded targeted RU seasonality research beside the market queries', async () => {
    const demandQuery = `${CANDIDATE.title} сезонность спроса Россия высокий сезон`;
    const availabilityQuery = `${CANDIDATE.title} низкий сезон доступность ЛПР отпуска Россия`;
    const procurementQuery = `${CANDIDATE.title} цикл закупок бюджеты планирование Россия`;
    mockSearch.mockImplementation(async (query: string) => {
      if (query === demandQuery) {
        // Regression: one rich query must not consume the entire seasonal
        // result/fetch budget and starve the other research lanes.
        return Array.from({ length: 6 }, (_, index) => ({
          title: `Пик спроса ${index}`,
          link: `https://research.example/demand-${index}`,
        }));
      }
      if (query === availabilityQuery) {
        return [{
          title: 'Отпуска ЛПР',
          link: 'https://research.example/availability',
        }];
      }
      if (query === procurementQuery) {
        return [{
          title: 'Цикл бюджетирования',
          link: 'https://research.example/procurement',
        }];
      }
      return [{
        title: query,
        link: 'https://research.example/market',
      }];
    });
    mockFetchText.mockResolvedValue('Нейтральный текст источника без подтверждённого сезонного вывода.');

    await runWithVerdict(baseVerdict(null));

    const queries = mockSearch.mock.calls.map((call) => String(call[0]));
    expect(queries).toEqual(expect.arrayContaining([
      demandQuery,
      availabilityQuery,
      procurementQuery,
    ]));
    expect(queries.length).toBeLessThanOrEqual(6);

    const fetchedUrls = mockFetchText.mock.calls.map((call) => String(call[0]));
    expect(fetchedUrls).toEqual(expect.arrayContaining([
      'https://research.example/demand-0',
      'https://research.example/demand-1',
      'https://research.example/availability',
      'https://research.example/procurement',
    ]));
    expect(fetchedUrls.length).toBeLessThanOrEqual(8);

    const messages = mockCallLLM.mock.calls[0][0] as Array<{ content: string }>;
    const prompt = messages.map((message) => message.content).join('\n');
    expect(prompt).toMatch(/пик спроса/i);
    expect(prompt).toMatch(/цикл закупок|бюджетирован/i);
    expect(prompt).toMatch(/доступность ЛПР|отпуск/i);
    expect(prompt).toMatch(/у КАЖДОГО объекта windows обязателен собственный массив evidence/i);
  });

  it('does not starve a seasonal URL discovered outside the market fetch quota', async () => {
    const marketQuery = CANDIDATE.search_queries[0];
    const demandQuery = `${CANDIDATE.title} сезонность спроса Россия высокий сезон`;
    const availabilityQuery = `${CANDIDATE.title} низкий сезон доступность ЛПР отпуска Россия`;
    const procurementQuery = `${CANDIDATE.title} цикл закупок бюджеты планирование Россия`;
    const marketOnlyUrl = 'https://research.example/market-first';
    const earlyOverlapUrl = 'https://research.example/overlap-early';
    const lateOverlapUrl = 'https://research.example/overlap-late';
    const procurementUrl = 'https://research.example/procurement-overlap-test';

    mockSearch.mockImplementation(async (query: string) => {
      if (query === marketQuery) {
        return [
          { title: 'Market first', link: marketOnlyUrl },
          { title: 'Selected market overlap', link: earlyOverlapUrl },
          { title: 'Late market overlap', link: lateOverlapUrl },
        ];
      }
      if (query === demandQuery) {
        return [{ title: 'Seasonal demand overlap', link: lateOverlapUrl }];
      }
      if (query === availabilityQuery) {
        return [{ title: 'Seasonal availability overlap', link: earlyOverlapUrl }];
      }
      if (query === procurementQuery) {
        return [{ title: 'Seasonal procurement', link: procurementUrl }];
      }
      return [];
    });
    mockFetchText.mockResolvedValue('Проверенный текст исследования.');

    await runWithVerdict(baseVerdict(null));

    const fetchedUrls = mockFetchText.mock.calls.map((call) => String(call[0]));
    expect(fetchedUrls).toEqual(expect.arrayContaining([
      marketOnlyUrl,
      earlyOverlapUrl,
      lateOverlapUrl,
      procurementUrl,
    ]));
    expect(fetchedUrls.filter((url) => url === earlyOverlapUrl)).toHaveLength(1);
    expect(fetchedUrls.filter((url) => url === lateOverlapUrl)).toHaveLength(1);
  });

  it('persists independently verified seasonality on ve_hypotheses', async () => {
    const db = await runWithVerdict(baseVerdict());
    const hypothesis = db.getRows('ve_hypotheses')[0];

    expect(hypothesis).toBeDefined();
    expect(hypothesis.evidence).toEqual([]);
    expect(hypothesis.seasonality).toEqual(VERIFIED_SEASONALITY);
  });

  it('persists unknown when dedicated seasonal URL/quote is unsupported', async () => {
    const hallucinated = {
      ...VERIFIED_SEASONALITY,
      windows: VERIFIED_SEASONALITY.windows.map((window) => ({
        ...window,
        evidence: [{
          claim: 'Непроверенный сезонный вывод.',
          source_url: 'https://hallucinated.example/season',
          quote: 'Непроверенная цитата про обязательный сентябрьский пик.',
        }],
      })),
      evidence: [{
        claim: 'Непроверенный сезонный вывод.',
        source_url: 'https://hallucinated.example/season',
        quote: 'Непроверенная цитата про обязательный сентябрьский пик.',
      }],
    };
    const db = await runWithVerdict(baseVerdict(hallucinated));
    const stored = db.getRows('ve_hypotheses')[0].seasonality;

    expect(stored).toEqual(expect.objectContaining({
      version: 1,
      classification: 'unknown',
      confidence: 'low',
      windows: [],
      evidence: [],
    }));
  });

  it('writes null for a legacy verdict without seasonality and still keeps the hypothesis', async () => {
    const verdict = baseVerdict();
    delete verdict.seasonality;

    const db = await runWithVerdict(verdict);
    const hypothesis = db.getRows('ve_hypotheses')[0];

    expect(hypothesis).toEqual(expect.objectContaining({
      title: CANDIDATE.title,
      status: 'proposed',
      seasonality: null,
    }));
  });
});
