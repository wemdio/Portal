/** @jest-environment node */

/**
 * Рыночный выбор research-промптов и гейт калибровки datasetStats (market ru|us).
 *
 * Каждая из 5 research-стадий (competitors, brand_cloud, hypotheses, evidence,
 * clustering) при market='us' зовёт LLM с EN-вариантом промпта (prompts/*.en.ts)
 * и EN поисковыми запросами там, где стадия строит их сама; при 'ru' — с RU,
 * поведение прежнее. Рынок берётся из ctx.market, при его отсутствии — из
 * he_projects.market (фолбэк readProject). Калибровка по датасету (RU-кампании)
 * при market='us' пропускается: datasetStats не участвует, стадия не падает.
 */

jest.mock('server-only', () => ({}));

const mockDatasetQuery = jest.fn();
jest.mock('@/lib/instantlyDataset', () => ({
  datasetQuery: (text: string, params?: unknown[]) => mockDatasetQuery(text, params),
  isDatasetConfigured: () => true,
}));

const callLLMMock = jest.fn();
jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: (...args: unknown[]) => callLLMMock(...args),
  getHeModel: () => 'test-model',
}));

// Тяжёлый граф websiteParser/playwright не нужен: стадии получают search/fetchText из ctx.
jest.mock('@/lib/hypothesisEngine/stages/io', () => ({
  resolveSearch: (ctx: { search?: unknown }) => ctx.search,
  resolveFetchText: (ctx: { fetchText?: unknown }) => ctx.fetchText,
}));

import { createMockSupabase, type MockSupabaseClient, type Row } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LLMMessage } from '@/lib/hypothesisEngine/llm';
import type { HeMarket } from '@/lib/hypothesisEngine/market';
import type { HeJob, HeStage } from '@/lib/hypothesisEngine/types';
import type { HeStageContext } from '@/lib/hypothesisEngine/stages/shared';
import { getPortfolioProfile, getSegmentStats, getWinnerPatterns } from '@/lib/hypothesisEngine/datasetStats';
import { runCompetitorsStage } from '@/lib/hypothesisEngine/stages/competitors';
import { runBrandCloudStage } from '@/lib/hypothesisEngine/stages/brandCloud';
import { runHypothesesStage } from '@/lib/hypothesisEngine/stages/hypotheses';
import { runEvidenceStage } from '@/lib/hypothesisEngine/stages/evidence';
import { runClusteringStage } from '@/lib/hypothesisEngine/stages/clustering';

const EN_MARKER = 'Respond strictly in English';
const RU_MARKER = 'Отвечай строго на русском';

const PROFILE = { company_name: 'Acme', product_summary: 'CRM for dental clinics' };

function makeJob(stage: HeStage): HeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage,
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
  };
}

/** Строка he_projects; market отсутствует, если не задан (легаси-проект → ru). */
function projectRow(market?: string): Row {
  const row: Row = {
    id: 'p1',
    name: 'P',
    website_url: 'https://acme.com',
    brief: { site_profile: PROFILE },
  };
  if (market) row.market = market;
  return row;
}

interface StageRun {
  messages: LLMMessage[];
  search: jest.Mock;
}

function makeCtx(db: MockSupabaseClient, market: HeMarket | undefined, search: jest.Mock): HeStageContext {
  return {
    supabase: db as unknown as SupabaseClient,
    search,
    fetchText: async () => 'page text',
    ...(market ? { market } : {}),
  };
}

/** Системный промпт, с которым стадия позвала LLM. */
function systemOf(messages: LLMMessage[]): string {
  const system = messages.find((m) => m.role === 'system');
  expect(system).toBeDefined();
  return system!.content;
}

function searchQueriesOf(search: jest.Mock): string[] {
  return search.mock.calls.map((c) => String(c[0]));
}

beforeEach(() => {
  jest.clearAllMocks();
  // Дефолт: датасет отвечает пустыми строками (конкретные тесты переопределяют).
  mockDatasetQuery.mockResolvedValue([]);
});

/* ─────────────────────────── competitors ─────────────────────────── */

async function runCompetitors(opts: { ctxMarket?: HeMarket; projectMarket?: string }): Promise<StageRun> {
  const db = createMockSupabase({ tables: { he_projects: [projectRow(opts.projectMarket)] } });
  const search = jest.fn(async () => [] as Array<{ title: string; link: string }>);
  callLLMMock.mockResolvedValue({
    data: { competitors: [{ name: 'Rival', url: 'https://rival.com', why: 'same niche', geo: 'US' }] },
    tokensUsed: 1,
    costUsd: 0,
  });
  await runCompetitorsStage(makeJob('competitors'), makeCtx(db, opts.ctxMarket, search));
  expect(callLLMMock).toHaveBeenCalledTimes(1);
  return { messages: callLLMMock.mock.calls[0][0] as LLMMessage[], search };
}

describe('competitors — выбор промпта и запросов по рынку', () => {
  it('ctx.market=us → EN-промпт, запросы competitors/alternatives, без «конкуренты/аналоги»', async () => {
    const { messages, search } = await runCompetitors({ ctxMarket: 'us' });

    expect(systemOf(messages)).toContain(EN_MARKER);
    expect(systemOf(messages)).not.toContain(RU_MARKER);
    const queries = searchQueriesOf(search);
    expect(queries).toContain('Acme competitors');
    expect(queries).toContain('Acme alternatives');
    expect(queries.some((q) => q.includes('конкуренты') || q.includes('аналоги'))).toBe(false);
  });

  it('ctx.market=ru → RU-промпт и RU-запросы (поведение прежнее)', async () => {
    const { messages, search } = await runCompetitors({ ctxMarket: 'ru' });

    expect(systemOf(messages)).toContain(RU_MARKER);
    expect(searchQueriesOf(search)).toContain('Acme конкуренты');
    expect(searchQueriesOf(search)).toContain('Acme аналоги альтернативы');
  });

  it('без ctx.market — фолбэк на he_projects.market: us → EN, без колонки → RU', async () => {
    const us = await runCompetitors({ projectMarket: 'us' });
    expect(systemOf(us.messages)).toContain(EN_MARKER);

    jest.clearAllMocks();
    const legacy = await runCompetitors({});
    expect(systemOf(legacy.messages)).toContain(RU_MARKER);
    expect(searchQueriesOf(legacy.search)).toContain('Acme конкуренты');
  });
});

/* ─────────────────────────── brand_cloud ─────────────────────────── */

async function runBrandCloud(opts: { ctxMarket?: HeMarket; projectMarket?: string }): Promise<StageRun> {
  const db = createMockSupabase({ tables: { he_projects: [projectRow(opts.projectMarket)] } });
  const search = jest.fn(async () => [] as Array<{ title: string; link: string }>);
  callLLMMock.mockResolvedValue({ data: { entities: [] }, tokensUsed: 1, costUsd: 0 });
  await runBrandCloudStage(makeJob('brand_cloud'), makeCtx(db, opts.ctxMarket, search));
  expect(callLLMMock).toHaveBeenCalledTimes(1);
  return { messages: callLLMMock.mock.calls[0][0] as LLMMessage[], search };
}

describe('brand_cloud — выбор промпта и кейс-паттернов по рынку', () => {
  it('ctx.market=us → EN-промпт, поиск «case studies clients reviews»', async () => {
    const { messages, search } = await runBrandCloud({ ctxMarket: 'us' });

    expect(systemOf(messages)).toContain(EN_MARKER);
    expect(searchQueriesOf(search)).toContain('"Acme" case studies clients reviews');
    expect(searchQueriesOf(search).some((q) => q.includes('кейсы'))).toBe(false);
  });

  it('ctx.market=ru → RU-промпт, поиск «кейсы клиенты отзывы» (поведение прежнее)', async () => {
    const { messages, search } = await runBrandCloud({ ctxMarket: 'ru' });

    expect(systemOf(messages)).toContain(RU_MARKER);
    expect(searchQueriesOf(search)).toContain('"Acme" кейсы клиенты отзывы');
  });

  it('без ctx.market — фолбэк на he_projects.market', async () => {
    const us = await runBrandCloud({ projectMarket: 'us' });
    expect(systemOf(us.messages)).toContain(EN_MARKER);

    jest.clearAllMocks();
    const legacy = await runBrandCloud({});
    expect(systemOf(legacy.messages)).toContain(RU_MARKER);
  });
});

/* ─────────────────────────── hypotheses ─────────────────────────── */

const HY_POTHESES_LLM = {
  data: {
    hypotheses: [
      { tier: 1, title: 'Dental clinics', description: 'd', fit_rationale: 'f', rationale: 'r', potential_pct: 60, search_queries: ['q'] },
    ],
  },
  tokensUsed: 1,
  costUsd: 0,
};

async function runHypotheses(opts: { ctxMarket?: HeMarket; projectMarket?: string }): Promise<StageRun> {
  const db = createMockSupabase({
    tables: { he_projects: [projectRow(opts.projectMarket)], he_hypotheses: [] },
  });
  const search = jest.fn(async () => [] as Array<{ title: string; link: string }>);
  callLLMMock.mockResolvedValue(HY_POTHESES_LLM);
  await runHypothesesStage(makeJob('hypotheses'), makeCtx(db, opts.ctxMarket, search));
  expect(callLLMMock).toHaveBeenCalledTimes(1);
  return { messages: callLLMMock.mock.calls[0][0] as LLMMessage[], search };
}

describe('hypotheses — выбор промпта по рынку и гейт калибровки', () => {
  it('ctx.market=us → EN-промпт: экономика в USD, geo-transfer из US; датасет не участвует', async () => {
    const { messages } = await runHypotheses({ ctxMarket: 'us' });

    const system = systemOf(messages);
    expect(system).toContain(EN_MARKER);
    expect(system).toContain('USD');
    expect(system).not.toContain('₽');
    expect(system).toContain('works in the US');
    expect(system).toContain('EU/LatAm');
    // Калибровка по RU-датасету пропущена: ни одного запроса к instantly_dataset.
    expect(mockDatasetQuery).not.toHaveBeenCalled();
  });

  it('ctx.market=ru → RU-промпт (₽, РФ→СНГ), калибровка датасета работает как раньше', async () => {
    const { messages } = await runHypotheses({ ctxMarket: 'ru' });

    const system = systemOf(messages);
    expect(system).toContain(RU_MARKER);
    expect(system).toContain('₽');
    expect(mockDatasetQuery).toHaveBeenCalled();
  });

  it('без ctx.market — фолбэк на he_projects.market', async () => {
    const us = await runHypotheses({ projectMarket: 'us' });
    expect(systemOf(us.messages)).toContain(EN_MARKER);
    expect(mockDatasetQuery).not.toHaveBeenCalled();

    jest.clearAllMocks();
    const legacy = await runHypotheses({});
    expect(systemOf(legacy.messages)).toContain(RU_MARKER);
    expect(mockDatasetQuery).toHaveBeenCalled();
  });
});

/* ─────────────────────────── evidence ─────────────────────────── */

const EVIDENCE_CANDIDATE = {
  tier: 2,
  title: 'Dental clinics',
  description: 'd',
  fit_rationale: 'f',
  rationale: 'r',
  potential_pct: 40,
  search_queries: [], // пусто — стадия обязана собрать fallback-запрос по рынку
};

async function runEvidence(opts: { ctxMarket?: HeMarket; projectMarket?: string }): Promise<StageRun> {
  const db = createMockSupabase({
    tables: {
      he_projects: [projectRow(opts.projectMarket)],
      he_jobs: [
        {
          id: 'j-hyp',
          project_id: 'p1',
          stage: 'hypotheses',
          status: 'done',
          result: { candidates: [EVIDENCE_CANDIDATE] },
          created_at: '2026-08-02T00:00:00Z',
        },
      ],
      he_hypotheses: [],
    },
  });
  const search = jest.fn(async () => [] as Array<{ title: string; link: string }>);
  callLLMMock.mockResolvedValue({
    data: { verdict: 'keep', merge_with_title: null, reason: 'ok', fit_rationale: 'f', evidence: [], potential_pct: 50 },
    tokensUsed: 1,
    costUsd: 0,
  });
  await runEvidenceStage(makeJob('evidence'), makeCtx(db, opts.ctxMarket, search));
  expect(callLLMMock).toHaveBeenCalledTimes(1);
  return { messages: callLLMMock.mock.calls[0][0] as LLMMessage[], search };
}

describe('evidence — выбор промпта и fallback-запросов по рынку', () => {
  it('ctx.market=us → EN-промпт, fallback-запрос EN; датасет не участвует', async () => {
    const { messages, search } = await runEvidence({ ctxMarket: 'us' });

    expect(systemOf(messages)).toContain(EN_MARKER);
    expect(searchQueriesOf(search)).toContain('Dental clinics market size');
    expect(searchQueriesOf(search).some((q) => q.includes('рынок объём'))).toBe(false);
    expect(mockDatasetQuery).not.toHaveBeenCalled();
  });

  it('ctx.market=ru → RU-промпт, fallback-запрос «рынок объём» (поведение прежнее)', async () => {
    const { messages, search } = await runEvidence({ ctxMarket: 'ru' });

    expect(systemOf(messages)).toContain(RU_MARKER);
    expect(searchQueriesOf(search)).toContain('Dental clinics рынок объём');
    expect(mockDatasetQuery).toHaveBeenCalled();
  });

  it('без ctx.market — фолбэк на he_projects.market', async () => {
    const us = await runEvidence({ projectMarket: 'us' });
    expect(systemOf(us.messages)).toContain(EN_MARKER);

    jest.clearAllMocks();
    const legacy = await runEvidence({});
    expect(systemOf(legacy.messages)).toContain(RU_MARKER);
  });
});

/* ─────────────────────────── clustering ─────────────────────────── */

const HYPOTHESIS_ROW = {
  id: 'h1',
  project_id: 'p1',
  vertical_id: null,
  tier: 1,
  title: 'Dental clinics',
  description: 'd',
  fit_rationale: 'f',
  evidence: [],
  potential_pct: 60,
  status: 'proposed',
  created_at: '2026-08-02T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
};

async function runClustering(opts: { ctxMarket?: HeMarket; projectMarket?: string }): Promise<StageRun> {
  const db = createMockSupabase({
    tables: {
      he_projects: [projectRow(opts.projectMarket)],
      he_hypotheses: [HYPOTHESIS_ROW],
    },
  });
  const search = jest.fn(async () => [] as Array<{ title: string; link: string }>);
  callLLMMock.mockResolvedValue({
    data: { verticals: [{ name: 'Dental clinics', summary: 's', synonyms: ['dentists'], member_titles: ['Dental clinics'] }] },
    tokensUsed: 1,
    costUsd: 0,
  });
  await runClusteringStage(makeJob('clustering'), makeCtx(db, opts.ctxMarket, search));
  expect(callLLMMock).toHaveBeenCalledTimes(1);
  return { messages: callLLMMock.mock.calls[0][0] as LLMMessage[], search };
}

describe('clustering — выбор промпта по рынку', () => {
  it('ctx.market=us → EN-промпт: имена вертикалей на английском', async () => {
    const { messages } = await runClustering({ ctxMarket: 'us' });

    const system = systemOf(messages);
    expect(system).toContain(EN_MARKER);
    expect(system).toContain('English');
    expect(system).toContain('Use-case vertical');
  });

  it('ctx.market=ru → RU-промпт (поведение прежнее)', async () => {
    const { messages } = await runClustering({ ctxMarket: 'ru' });

    const system = systemOf(messages);
    expect(system).toContain(RU_MARKER);
    expect(system).toContain('Сценарная вертикаль');
  });

  it('без ctx.market — фолбэк на he_projects.market', async () => {
    const us = await runClustering({ projectMarket: 'us' });
    expect(systemOf(us.messages)).toContain(EN_MARKER);

    jest.clearAllMocks();
    const legacy = await runClustering({});
    expect(systemOf(legacy.messages)).toContain(RU_MARKER);
  });
});

/* ─────────────────── datasetStats — рыночный гейт ─────────────────── */

describe('datasetStats — рыночный гейт (market=us → калибровка пропускается)', () => {
  it('getPortfolioProfile({market:us}) → [] без запросов к датасету, с логом', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const res = await getPortfolioProfile({ market: 'us' });

      expect(res).toEqual([]);
      expect(mockDatasetQuery).not.toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('market=us'));
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('getSegmentStats(..., {market:us}) → нейтральный результат с note, без запросов, не падает', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const res = await getSegmentStats('Dental clinics', ['dentists'], { market: 'us' });

      expect(mockDatasetQuery).not.toHaveBeenCalled();
      expect(res).toEqual({
        matched_segments: [],
        campaigns: 0,
        sent: 0,
        replies: 0,
        reply_pct: null,
        baseline_pct: null,
        top_subjects: [],
        note: expect.stringContaining('market=us'),
      });
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('getWinnerPatterns(..., {market:us}) → [] без запросов', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const res = await getWinnerPatterns(['dental'], 5, { market: 'us' });

      expect(res).toEqual([]);
      expect(mockDatasetQuery).not.toHaveBeenCalled();
    } finally {
      infoSpy.mockRestore();
    }
  });

  it('без market (дефолт ru) — поведение прежнее: запросы к датасету идут', async () => {
    mockDatasetQuery.mockResolvedValue([]);

    await getPortfolioProfile();
    await getSegmentStats('Логистика', ['logistics']);
    await getWinnerPatterns(['auto']);

    expect(mockDatasetQuery).toHaveBeenCalled();
  });
});
