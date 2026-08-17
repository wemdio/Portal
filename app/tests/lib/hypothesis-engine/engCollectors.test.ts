/** @jest-environment node */

/**
 * ENG-источники авто-сборки базы (пункт 4b EN-пайплайна, market='us'):
 *
 *   schema      — HeSourcePlanSchema принимает задачи pdl / funded / eng_hiring
 *                 с их фильтрами (RU-типы остаются валидными — см. sourcePlan.test.ts);
 *   PLAN        — market='us' → LLM зовётся EN-промптом планировщика источников
 *                 (ctx.market воркера, фолбэк — he_projects.market);
 *   DISPATCH    — pdl / funded / eng_hiring читаются напрямую из справочных
 *                 таблиц через ctx.supabase (БЕЗ дочерних джоб): фильтры задачи
 *                 применяются, строки мапятся в HE_AUTO_COLLECT_COLUMNS, лимит
 *                 сборки соблюдается;
 *   eng_hiring  — роль regex по vacancy_title (buildRolesRegex), страны по
 *                 country_code, свежесть published_at >= now - posted_within_days,
 *                 дедуп по компании внутри задачи (выживает самая свежая);
 *   google_maps — language/region параметризованы рынком (us → en/US);
 *   dedup       — EN-юрформы срезаются ('Acme, Inc.' vs 'ACME LLC' → одна компания);
 *   vocab       — market='us' → EN-промпт вокабуляра.
 */

jest.mock('server-only', () => ({}));

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
}));

jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getHeModel: jest.fn(() => 'test-bulk-model'),
}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { callLLMWithSchema } from '@/lib/hypothesisEngine/llm';
import type { HeMarket } from '@/lib/hypothesisEngine/market';
import { buildSourcePlanMessagesEn } from '@/lib/hypothesisEngine/prompts/sourcePlan.en';
import { buildVocabMessagesEn } from '@/lib/hypothesisEngine/prompts/vocab.en';
import { HeSourcePlanSchema } from '@/lib/hypothesisEngine/schemas';
import {
  buildRolesIlikeFilter,
  dedupUnifiedRows,
  HE_AUTO_COLLECT_COLUMNS,
  mapEngHiringRow,
  mapFundedRow,
  mapPdlRow,
  normalizeCompanyForDedup,
  runBaseCollectStage,
  type HeCollectInfo,
  type HeUnifiedRow,
} from '@/lib/hypothesisEngine/stages/baseCollect';
import { runVocabStage } from '@/lib/hypothesisEngine/stages/vocab';
import type { HeJob } from '@/lib/hypothesisEngine/types';

const searchRowsMock = searchRows as unknown as jest.Mock;
const callLLMMock = callLLMWithSchema as unknown as jest.Mock;

let mockDb: MockSupabaseClient = createMockSupabase();

const PROJECT_US = { id: 'p1', name: 'P', created_by: 'user-1', market: 'us' };
const PROJECT_RU = { id: 'p1', name: 'P', created_by: 'user-1' };
const VERTICAL = {
  id: 'v1',
  project_id: 'p1',
  name: 'Staffing agencies',
  summary: 'Recruitment and staffing',
  synonyms: ['recruitment agencies'],
  potential_pct: 50,
  rank: 1,
};

function makeBase(collectInfo: HeCollectInfo | null): Record<string, unknown> {
  return {
    id: 'b1',
    project_id: 'p1',
    vertical_id: 'v1',
    filename: 'auto: Staffing agencies',
    row_count: 0,
    columns: [],
    sample_rows: [],
    data: [],
    status: 'collecting',
    source: 'auto',
    collect_info: collectInfo,
  };
}

function makeJob(overrides: Partial<HeJob> = {}): HeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage: 'base_collect',
    status: 'running',
    payload: { base_id: 'b1' },
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-03T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-03T00:00:00Z',
    updated_at: '2026-08-03T00:00:00Z',
    ...overrides,
  };
}

function ctx(market?: HeMarket) {
  return { supabase: mockDb as unknown as SupabaseClient, ...(market ? { market } : {}) };
}

/**
 * Хендлер RPC search_pdl_companies для мока: та же семантика, что у
 * SQL-функции (in-фильтры, ilike по имени, keyset id > p_after_id, order id,
 * limit) поверх посеянной таблицы pdl_companies.
 */
function pdlRpcHandler(params: Record<string, unknown>, db: MockSupabaseClient): { data: unknown } {
  const asList = (v: unknown) => (Array.isArray(v) ? (v as string[]) : null);
  const industries = asList(params.p_industries);
  const sizes = asList(params.p_sizes);
  const countries = asList(params.p_countries);
  const name = typeof params.p_name === 'string' ? params.p_name.toLowerCase() : null;
  const afterId = typeof params.p_after_id === 'string' && params.p_after_id ? params.p_after_id : null;
  const limit = typeof params.p_limit === 'number' ? params.p_limit : 1000;
  const rows = db
    .getRows('pdl_companies')
    .filter((r) => !industries || industries.includes(String(r.industry)))
    .filter((r) => !sizes || sizes.includes(String(r.size)))
    .filter((r) => !countries || countries.includes(String(r.country)))
    .filter((r) => !name || String(r.name ?? '').toLowerCase().includes(name))
    .filter((r) => !afterId || String(r.id) > afterId)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .slice(0, limit);
  return { data: rows };
}

/** Опция посева для тестов, читающих каталог PDL через RPC. */
const PDL_RPC = { search_pdl_companies: pdlRpcHandler };

function row(partial: Partial<HeUnifiedRow>): HeUnifiedRow {
  const full = {} as HeUnifiedRow;
  for (const col of HE_AUTO_COLLECT_COLUMNS) full[col] = partial[col] ?? '';
  return full;
}

/**
 * Пометка «фаза CONSTRUCT уже завершена» для сидов collect_info: тесты
 * PLAN/DISPATCH изолируются от конструктора баз (пункт 4c) — ENG-строки
 * почти без email иначе уходили бы в base_constructor_jobs и рекью.
 */
const CONSTRUCT_DONE = { bc_job_id: 'bc-done', status: 'done' as const };

/** Системный промпт первого LLM-вызова. */
function systemPromptOf(callIndex = 0): string {
  const messages = callLLMMock.mock.calls[callIndex][0] as Array<{ role: string; content: string }>;
  return messages[0].content;
}

beforeEach(() => {
  jest.clearAllMocks();
  // clearAllMocks НЕ снимает очередь mockResolvedValueOnce: недоиспользованные
  // ответы (тест упал раньше, чем выбрал их все) утекали бы в следующий кейс и
  // подменяли там план источников. Сбрасываем очередь явно.
  callLLMMock.mockReset();
  // График пауз ретрая pdl тесты укорачивают через env — чтобы утечка настройки
  // не влияла на соседние кейсы, сбрасываем на дефолт перед каждым.
  delete process.env.HE_PDL_READ_RETRY_DELAYS_MS;
});

/* ─────────────────────────── Схема плана ─────────────────────────── */

describe('HeSourcePlanSchema — ENG-типы задач (market=us)', () => {
  it('pdl с pdl_filters проходит (industries/sizes/countries/name)', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        {
          source: 'pdl',
          rationale: 'US software companies 51-200 as staffing buyers',
          pdl_filters: {
            industries: ['software'],
            sizes: ['51-200'],
            countries: ['united states'],
            name: 'acme',
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('funded с funded_filters проходит (industries/countries/min_funding_usd/funded_since)', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        {
          source: 'funded',
          rationale: 'Recently funded fintech startups scaling sales teams',
          funded_filters: {
            industries: ['fintech'],
            countries: ['united states'],
            min_funding_usd: 5_000_000,
            funded_since: '2026-01-01',
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('eng_hiring с eng_hiring_query проходит (roles/countries/posted_within_days)', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        {
          source: 'eng_hiring',
          rationale: 'Companies hiring account executives — growth signal',
          eng_hiring_query: {
            roles: ['account executive', 'sales development representative'],
            countries: ['us', 'gb'],
            posted_within_days: 30,
          },
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('смешанный ENG-план из 4 задач проходит', () => {
    const r = HeSourcePlanSchema.safeParse({
      tasks: [
        { source: 'pdl', rationale: 'r', pdl_filters: { industries: ['software'] } },
        { source: 'funded', rationale: 'r', funded_filters: { funded_since: '2026-01-01' } },
        { source: 'eng_hiring', rationale: 'r', eng_hiring_query: { roles: ['account executive'] } },
        { source: 'google_maps', rationale: 'r', maps_query: { queries: ['dentist'], geo: 'Austin' } },
      ],
    });
    expect(r.success).toBe(true);
  });

  it('ENG-источник без обязательного под-объекта отклоняется (каждый из 3)', () => {
    expect(HeSourcePlanSchema.safeParse({ tasks: [{ source: 'pdl', rationale: 'r' }] }).success).toBe(false);
    expect(HeSourcePlanSchema.safeParse({ tasks: [{ source: 'funded', rationale: 'r' }] }).success).toBe(false);
    expect(HeSourcePlanSchema.safeParse({ tasks: [{ source: 'eng_hiring', rationale: 'r' }] }).success).toBe(false);
  });

  it('чужой под-объект не заменяет обязательный и для ENG-источников', () => {
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ source: 'pdl', rationale: 'r', eng_hiring_query: { roles: ['x'] } }],
      }).success,
    ).toBe(false);
  });

  it('eng_hiring с пустым roles отклоняется', () => {
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ source: 'eng_hiring', rationale: 'r', eng_hiring_query: { roles: [] } }],
      }).success,
    ).toBe(false);
  });

  it('funded_since: только формат YYYY-MM-DD', () => {
    const base = { source: 'funded', rationale: 'r' };
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ ...base, funded_filters: { funded_since: '01.01.2026' } }],
      }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({
        tasks: [{ ...base, funded_filters: { funded_since: '2026-01-01' } }],
      }).success,
    ).toBe(true);
  });

  it('пустые pdl_filters {} / funded_filters {} отклоняются — нефильтрованный срез справочника', () => {
    expect(
      HeSourcePlanSchema.safeParse({ tasks: [{ source: 'pdl', rationale: 'r', pdl_filters: {} }] }).success,
    ).toBe(false);
    expect(
      HeSourcePlanSchema.safeParse({ tasks: [{ source: 'funded', rationale: 'r', funded_filters: {} }] }).success,
    ).toBe(false);
  });
});

/* ─────────────────────── EN-промпт планировщика ─────────────────────── */

describe('buildSourcePlanMessagesEn', () => {
  it('системный промпт — на английском и только про ENG-источники', () => {
    const msgs = buildSourcePlanMessagesEn({
      verticalName: 'Staffing agencies',
      verticalSummary: 'Recruitment and staffing',
      synonyms: ['recruitment agencies'],
      hypotheses: [{ title: 'Mid-size agencies', description: 'grow via retained search', tier: 1 }],
      companyTypes: ['staffing agency', 'recruitment firm'],
    });
    expect(msgs).toHaveLength(2);
    const system = msgs[0].content;
    expect(system).toContain('Answer strictly in English');
    expect(system).not.toContain('Отвечай строго на русском');
    // Источники ENG-набора описаны.
    expect(system).toContain('pdl');
    expect(system).toContain('funded');
    expect(system).toContain('eng_hiring');
    expect(system).toContain('google_maps');
    // RU-источников в EN-промпте нет.
    expect(system).not.toContain('companies_directory');
    expect(system).not.toContain('hh_live');
    expect(system).not.toContain('yandex_maps');

    const user = msgs[1].content;
    expect(user).toContain('Staffing agencies');
    expect(user).toContain('Mid-size agencies');
    expect(user).toContain('staffing agency');
  });
});

/* ─────────────────────── Мапперы в унифицированные колонки ─────────────────────── */

describe('ENG source row → unified row mapping', () => {
  it('maps a pdl_companies row (size → employees, locality/region/country → address)', () => {
    const mapped = mapPdlRow({
      name: 'Acme Inc',
      website: 'acme.com',
      industry: 'software',
      size: '51-200',
      country: 'united states',
      region: 'ca',
      locality: 'san francisco',
    });
    expect(mapped).toEqual(
      row({
        company: 'Acme Inc',
        website: 'acme.com',
        address: 'san francisco, ca, united states',
        category: 'software',
        employees: '51-200',
        source_detail: 'pdl',
      }),
    );
  });

  it('maps a funded_companies row (source → source_detail, funding не сворачивается в revenue)', () => {
    const mapped = mapFundedRow({
      name: 'Beta',
      website: 'beta.io',
      industry: 'fintech',
      country: 'united states',
      total_funding_usd: 12_000_000,
      last_funding_usd: 5_000_000,
      last_funding_type: 'seed',
      last_funding_date: '2026-01-15',
      batch: 'W26',
      source: 'yc',
    });
    expect(mapped).toEqual(
      row({
        company: 'Beta',
        website: 'beta.io',
        address: 'united states',
        category: 'fintech',
        source_detail: 'funded:yc',
      }),
    );
  });

  it('maps an eng_hiring_cache row (vacancy_title как крючок, source → source_detail)', () => {
    const mapped = mapEngHiringRow({
      company_name: 'Globex',
      company_site_url: 'https://globex.com',
      vacancy_title: 'Account Executive',
      location: 'New York, NY',
      country_code: 'us',
      source: 'greenhouse',
      published_at: '2026-08-01T00:00:00Z',
    });
    expect(mapped).toEqual(
      row({
        company: 'Globex',
        website: 'https://globex.com',
        vacancy_title: 'Account Executive',
        address: 'New York, NY',
        source_detail: 'eng_hiring:greenhouse',
      }),
    );
  });

  it('email/phone остаются пустыми у всех ENG-мапперов (добьёт конструктор в 4c)', () => {
    for (const mapped of [
      mapPdlRow({ name: 'A', website: 'a.com' }),
      mapFundedRow({ name: 'B', website: 'b.com', source: 'yc' }),
      mapEngHiringRow({ company_name: 'C', vacancy_title: 'AE', source: 'lever' }),
    ]) {
      expect(mapped.email).toBe('');
      expect(mapped.phone).toBe('');
    }
  });
});

/* ─────────────────────── Дедуп: EN-юрформы ─────────────────────── */

describe('normalizeCompanyForDedup — EN юрформы', () => {
  it("'Acme, Inc.' и 'ACME LLC' — одна компания", () => {
    expect(normalizeCompanyForDedup('Acme, Inc.')).toBe('acme');
    expect(normalizeCompanyForDedup('ACME LLC')).toBe('acme');
    expect(normalizeCompanyForDedup('Acme, Inc.')).toBe(normalizeCompanyForDedup('ACME LLC'));
  });

  it('срезает EN-юрформы целыми токенами', () => {
    expect(normalizeCompanyForDedup('Globex Corporation')).toBe('globex');
    expect(normalizeCompanyForDedup('Globex Corp')).toBe('globex');
    expect(normalizeCompanyForDedup('Initech GmbH')).toBe('initech');
    expect(normalizeCompanyForDedup('Umbrella PLC')).toBe('umbrella');
    expect(normalizeCompanyForDedup('Wayne Enterprises LP')).toBe('wayne enterprises');
    expect(normalizeCompanyForDedup('Stark Industries Ltd.')).toBe('stark industries');
    expect(normalizeCompanyForDedup('Stark Industries Limited')).toBe('stark industries');
    expect(normalizeCompanyForDedup('Hooli BV')).toBe('hooli');
    expect(normalizeCompanyForDedup('Telco NV')).toBe('telco');
    expect(normalizeCompanyForDedup('Contoso SA')).toBe('contoso');
    expect(normalizeCompanyForDedup('Dump Transport SARL')).toBe('dump transport');
    expect(normalizeCompanyForDedup('Outback Pty Ltd')).toBe('outback');
    expect(normalizeCompanyForDedup('SingTel Pte Ltd')).toBe('singtel');
    expect(normalizeCompanyForDedup('Nakatomi LLP')).toBe('nakatomi');
  });

  it('не трогает токены, лишь похожие на юрформы, и имена без форм', () => {
    expect(normalizeCompanyForDedup('Sage')).toBe('sage');
    expect(normalizeCompanyForDedup('Agatha AG')).toBe('agatha');
    expect(normalizeCompanyForDedup('Massive Dynamic')).toBe('massive dynamic');
    // 'kk' в списке нет — не срезаем.
    expect(normalizeCompanyForDedup('Cyberdyne Systems KK')).toBe('cyberdyne systems kk');
  });

  it('dedupUnifiedRows схлопывает EN-дубли: выживает более богатая строка', () => {
    const bare = row({ company: 'ACME LLC', vacancy_title: 'Account Executive' });
    const rich = row({ company: 'Acme, Inc.', website: 'acme.com' });
    const out = dedupUnifiedRows([bare, rich]);
    expect(out).toHaveLength(1);
    expect(out[0].website).toBe('acme.com');
  });
});

/* ─────────────────────── PLAN: выбор промпта по market ─────────────────────── */

describe('plan phase — market=us зовёт EN-промпт', () => {
  function seedPlanTables(project: Record<string, unknown>) {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
        he_verticals: [VERTICAL],
        he_projects: [project],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        he_hypotheses: [
          { project_id: 'p1', vertical_id: 'v1', title: 'Mid-size agencies', description: 'd', tier: 1, status: 'accepted', potential_pct: 80 },
        ],
        pdl_companies: [
          { id: 'pdl-1', name: 'Acme Inc', website: 'acme.com', industry: 'software', size: '51-200', country: 'united states', region: 'ca', locality: 'san francisco' },
        ],
      },
      rpcHandlers: PDL_RPC,
    });
    callLLMMock.mockResolvedValue({
      data: {
        tasks: [
          { source: 'pdl', rationale: 'US software 51-200', pdl_filters: { industries: ['software'], countries: ['united states'] } },
        ],
      },
      tokensUsed: 100,
      promptTokens: 80,
      completionTokens: 20,
      costUsd: 0.001,
      rawResponse: {},
    });
  }

  it("ctx.market='us' → EN-промпт, pdl-задача исполняется синхронно (без дочерних джоб)", async () => {
    seedPlanTables(PROJECT_US);

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);

    // План источников (EN-промпт) → проба каталожного среза → релевант-гейт финала.
    expect(callLLMMock).toHaveBeenCalledTimes(3);
    expect(systemPromptOf()).toContain('Answer strictly in English');
    expect(systemPromptOf()).not.toContain('Отвечай строго на русском');

    // Никаких дочерних джоб парсеров — только base_analyze в конце.
    expect(mockDb.inserts.filter((i) => i.table !== 'he_jobs')).toHaveLength(0);
    const nextJob = mockDb.inserts.find((i) => i.table === 'he_jobs');
    expect(nextJob?.rows[0]).toEqual(expect.objectContaining({ stage: 'base_analyze' }));

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const data = harvest?.data as HeUnifiedRow[];
    expect(data[0]).toEqual(
      row({
        company: 'Acme Inc',
        website: 'acme.com',
        address: 'san francisco, ca, united states',
        category: 'software',
        employees: '51-200',
        source_detail: 'pdl',
      }),
    );
  });

  it("без ctx.market фолбэк на he_projects.market='us' → тоже EN-промпт", async () => {
    seedPlanTables(PROJECT_US);

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);
    expect(systemPromptOf()).toContain('Answer strictly in English');
  });

  /**
   * Регрессия 12.08.2026: планировщик отдал Franchise Brands план без каталога
   * (eng_hiring + google_maps) — база вышла на 6 строк при лимите 2000.
   * У вертикали нет отраслевой метки в каталоге, поэтому модель штатно
   * пропускает pdl; каталожный срез добирается отдельным вызовом.
   */
  describe('ENG-план без каталожного источника чинится pdl-срезом', () => {
    // Форма плана — как у боевой базы 23a449d8 (12.08): два среза eng_hiring
    // и ни одного каталожного источника.
    const NO_CATALOG_PLAN = {
      tasks: [
        { source: 'eng_hiring', rationale: 'hiring signal', eng_hiring_query: { roles: ['franchise development'] } },
        { source: 'eng_hiring', rationale: 'ops roles', eng_hiring_query: { roles: ['franchise operations'] } },
      ],
    };
    const REPAIR = {
      rationale: 'Franchisors carry the word in their names',
      pdl_filters: { name: 'franchise', countries: ['united states'] },
    };
    const llmResult = (data: unknown) => ({
      data,
      tokensUsed: 10,
      promptTokens: 8,
      completionTokens: 2,
      costUsd: 0.0001,
      rawResponse: {},
    });

    function seedNoCatalog() {
      mockDb = createMockSupabase({
        tables: {
          he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
          he_verticals: [{ ...VERTICAL, name: 'Franchise Brands' }],
          he_projects: [PROJECT_US],
          he_jobs: [makeJob() as unknown as Record<string, unknown>],
          he_hypotheses: [
            { project_id: 'p1', vertical_id: 'v1', title: 'Franchisors scaling', description: 'd', tier: 1, status: 'accepted', potential_pct: 80 },
          ],
          pdl_companies: [
            { id: 'pdl-1', name: 'United Franchise Group', website: 'ufgcorp.com', industry: 'consumer services', size: '201-500', country: 'united states', region: 'fl', locality: 'west palm beach' },
          ],
          eng_hiring_cache: [],
        },
        rpcHandlers: PDL_RPC,
      });
    }

    it('добавляет pdl-задачу, пишет провенанс в collect_info и собирает по ней строки', async () => {
      seedNoCatalog();
      callLLMMock
        .mockResolvedValueOnce(llmResult(NO_CATALOG_PLAN)) // план источников
        .mockResolvedValueOnce(llmResult(REPAIR)) // починка: фильтры каталога
        .mockResolvedValue(llmResult({ irrelevant: [] })); // релевант-гейт

      const res = await runBaseCollectStage(makeJob(), ctx('us'));

      // Промпт починки — отдельный, и он про недостающий каталожный срез.
      expect(systemPromptOf(1)).toContain('WITHOUT any company-catalog task');

      const patches = mockDb.updates.filter((u) => u.table === 'he_bases');
      const info = patches[0].patch.collect_info as HeCollectInfo;
      expect(info.plan?.tasks.map((t) => t.source)).toEqual(['eng_hiring', 'eng_hiring', 'pdl']);
      expect(info.plan?.tasks.at(-1)?.pdl_filters).toEqual(REPAIR.pdl_filters);
      expect(info.plan_repair).toEqual({
        reason: 'no_catalog_source',
        outcome: 'repaired',
        pdl_filters: REPAIR.pdl_filters,
      });

      // Добавленный срез реально исполняется: строка каталога попала в базу.
      expect((res.result as { rows: number }).rows).toBe(1);
      const harvest = patches.at(-1)?.patch;
      expect((harvest?.data as HeUnifiedRow[])[0].company).toBe('United Franchise Group');
    });

    it('план с каталогом не чинится: лишнего вызова модели нет', async () => {
      seedPlanTables(PROJECT_US); // план из одной pdl-задачи

      await runBaseCollectStage(makeJob(), ctx('us'));

      // План + проба среза + релевант-гейт. Четвёртый означал бы починку.
      expect(callLLMMock).toHaveBeenCalledTimes(3);
    });

    it('провал починки не маскируется: план идёт как есть, причина остаётся в collect_info', async () => {
      seedNoCatalog();
      callLLMMock
        .mockResolvedValueOnce(llmResult(NO_CATALOG_PLAN))
        .mockRejectedValueOnce(new Error('LLM 503'))
        .mockResolvedValue(llmResult({ irrelevant: [] }));

      // Сбор без каталога честно падает нулём строк (боевая база 23a449d8),
      // а не отдаёт тонкую базу молча.
      await expect(runBaseCollectStage(makeJob(), ctx('us'))).rejects.toThrow(/не дала строк/);

      const info = mockDb.updates.filter((u) => u.table === 'he_bases')[0].patch.collect_info as HeCollectInfo;
      expect(info.plan?.tasks.map((t) => t.source)).toEqual(['eng_hiring', 'eng_hiring']);
      expect(info.plan_repair).toEqual({
        reason: 'no_catalog_source',
        outcome: 'failed',
        error: 'LLM 503',
      });
    });

    it('полный план из 4 задач: каталожный срез вытесняет последнюю, задач остаётся 4', async () => {
      seedNoCatalog();
      const fourTasks = {
        tasks: [
          ...NO_CATALOG_PLAN.tasks,
          { source: 'google_maps', rationale: 'geo', maps_query: { queries: ['franchise'], geo: 'United States' } },
          { source: 'google_maps', rationale: 'geo 2', maps_query: { queries: ['franchise hq'], geo: 'Canada' } },
        ],
      };
      callLLMMock
        .mockResolvedValueOnce(llmResult(fourTasks))
        .mockResolvedValueOnce(llmResult(REPAIR))
        .mockResolvedValue(llmResult({ irrelevant: [] }));

      await runBaseCollectStage(makeJob(), ctx('us'));

      const info = mockDb.updates.filter((u) => u.table === 'he_bases')[0].patch.collect_info as HeCollectInfo;
      expect(info.plan?.tasks.map((t) => t.source)).toEqual(['eng_hiring', 'eng_hiring', 'google_maps', 'pdl']);
    });

    it("market='ru' не чинится: у RU-плана свой каталог (companies_directory)", async () => {
      mockDb = createMockSupabase({
        tables: {
          he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
          he_verticals: [{ ...VERTICAL, name: 'HR-агентства' }],
          he_projects: [{ ...PROJECT_RU, market: 'ru' }],
          he_jobs: [makeJob() as unknown as Record<string, unknown>],
          he_hypotheses: [
            { project_id: 'p1', vertical_id: 'v1', title: 'Кадровые бутики', description: null, tier: 1, status: 'accepted', potential_pct: 80 },
          ],
        },
      });
      callLLMMock
        .mockResolvedValueOnce(
          llmResult({ tasks: [{ source: 'hh_live', rationale: 'найм', hh_query: { text: 'рекрутер' } }] }),
        )
        .mockResolvedValue(llmResult({ irrelevant: [] }));

      await runBaseCollectStage(makeJob(), ctx('ru'));

      const info = mockDb.updates.filter((u) => u.table === 'he_bases')[0].patch.collect_info as HeCollectInfo;
      expect(info.plan?.tasks.map((t) => t.source)).toEqual(['hh_live']);
      expect(info.plan_repair).toBeUndefined();
    });
  });

  /**
   * Проба каталожного среза. 12.08 планировщик выдал под «Franchise Brands»
   * фирмографически валидный, но чужой срез (широкие индустрии) — 833 строки,
   * 557 почт, цифры как у эталона, а внутри рестораны и школы. Гейт это не
   * ловит по устройству, поэтому срез проверяется ДО сбора.
   */
  describe('проба каталожного среза на принадлежность вертикали', () => {
    const PDL_PLAN = {
      tasks: [
        { source: 'pdl', rationale: 'catalog', pdl_filters: { industries: ['restaurants'] } },
      ],
    };
    const llmResult = (data: unknown) => ({
      data,
      tokensUsed: 10,
      promptTokens: 8,
      completionTokens: 2,
      costUsd: 0.0001,
      rawResponse: {},
    });

    function seedWithCatalog() {
      mockDb = createMockSupabase({
        tables: {
          he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
          he_verticals: [{ ...VERTICAL, name: 'Franchise Brands' }],
          he_projects: [PROJECT_US],
          he_jobs: [makeJob() as unknown as Record<string, unknown>],
          he_hypotheses: [
            { project_id: 'p1', vertical_id: 'v1', title: 'Franchisors', description: 'd', tier: 1, status: 'accepted', potential_pct: 80 },
          ],
          pdl_companies: [
            // Под исходный срез (industries=restaurants) — компания мимо вертикали.
            { id: 'pdl-1', name: 'Le Bilboquet Denver', website: 'lb.com', industry: 'restaurants', country: 'united states' },
            // Под перепланированный срез (name=franchise) — целевая компания.
            { id: 'pdl-2', name: 'United Franchise Group', website: 'ufg.com', industry: 'consumer services', country: 'united states' },
          ],
        },
        rpcHandlers: PDL_RPC,
      });
    }

    function infoOf(): HeCollectInfo {
      return mockDb.updates.filter((u) => u.table === 'he_bases')[0].patch.collect_info as HeCollectInfo;
    }

    it('срез по вертикали → собираем, проба записана как passed', async () => {
      seedWithCatalog();
      callLLMMock
        .mockResolvedValueOnce(llmResult(PDL_PLAN)) // план
        .mockResolvedValueOnce(llmResult({ belongs: [0] })) // проба: строка подходит
        .mockResolvedValue(llmResult({ irrelevant: [] })); // релевант-гейт

      const res = await runBaseCollectStage(makeJob(), ctx('us'));
      expect((res.result as { rows: number }).rows).toBe(1);
      expect(infoOf().slice_probe).toMatchObject({ outcome: 'passed', hit_rate: 1, sampled: 1 });
    });

    it('чужой срез → перепланируется, в план идёт новый; вопрос пробы обратный гейту', async () => {
      seedWithCatalog();
      const REPAIR = { rationale: 'franchisors carry it in the name', pdl_filters: { name: 'franchise' } };
      callLLMMock
        .mockResolvedValueOnce(llmResult(PDL_PLAN))
        .mockResolvedValueOnce(llmResult({ belongs: [] })) // проба 1: не подходит
        .mockResolvedValueOnce(llmResult(REPAIR)) // перепланирование
        .mockResolvedValueOnce(llmResult({ belongs: [0] })) // проба 2: подходит
        .mockResolvedValue(llmResult({ irrelevant: [] }));

      await runBaseCollectStage(makeJob(), ctx('us'));

      const info = infoOf();
      expect(info.plan?.tasks[0].pdl_filters).toEqual({ name: 'franchise' });
      expect(info.slice_probe).toMatchObject({ outcome: 'repaired', hit_rate: 1, first_hit_rate: 0 });

      // Дефолт пробы инвертирован: спрашиваем про принадлежность, а не про шум.
      const probePrompt = systemPromptOf(1);
      expect(probePrompt).toContain('Default to NOT belonging');
      expect(probePrompt).not.toContain('When in doubt — keep');
    });

    it('перепланирование не помогло → база НЕ строится, причина в collect_info', async () => {
      seedWithCatalog();
      callLLMMock
        .mockResolvedValueOnce(llmResult(PDL_PLAN))
        .mockResolvedValueOnce(llmResult({ belongs: [] })) // проба 1
        .mockResolvedValueOnce(llmResult({ rationale: 'r', pdl_filters: { name: 'franchise' } }))
        .mockResolvedValueOnce(llmResult({ belongs: [] })) // проба 2 — снова мимо
        .mockResolvedValue(llmResult({ irrelevant: [] }));

      await expect(runBaseCollectStage(makeJob(), ctx('us'))).rejects.toThrow(
        /не покрывается каталогом/,
      );

      const info = infoOf();
      expect(info.slice_probe).toMatchObject({
        outcome: 'rejected',
        hit_rate: 0,
        // Примеры — из ПОВТОРНОЙ пробы: показываем, на чём решение принято.
        off_target_examples: ['United Franchise Group'],
      });
      // Задачи обнулены — коллекторы не дёргались вовсе.
      expect(info.tasks).toEqual([]);

      // Базу валит САМА стадия, с причиной отказа. Отдать воркеру нельзя:
      // failJob ретраит до MAX_ATTEMPTS, и повторные попытки умерли бы в
      // других ветках, перетерев причину на «план пуст» / start-guard.
      const basePatch = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
      expect(basePatch).toMatchObject({ status: 'failed' });
      expect(String(basePatch?.error)).toMatch(/не покрывается каталогом/);
    });

    it('план с НЕСКОЛЬКИМИ каталожными задачами: заменяется вся каталожная часть, не только первая', async () => {
      // Форма боевого плана 12.08: три pdl-среза с разными индустриями. Замена
      // только первого оставила бы два широких добивать кап нецелевыми.
      mockDb = createMockSupabase({
        tables: {
          he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
          he_verticals: [{ ...VERTICAL, name: 'Franchise Brands' }],
          he_projects: [PROJECT_US],
          he_jobs: [makeJob() as unknown as Record<string, unknown>],
          he_hypotheses: [
            { project_id: 'p1', vertical_id: 'v1', title: 'Franchisors', description: 'd', tier: 1, status: 'accepted', potential_pct: 80 },
          ],
          pdl_companies: [
            { id: 'pdl-1', name: 'Le Bilboquet Denver', website: 'lb.com', industry: 'restaurants', country: 'united states' },
            { id: 'pdl-2', name: 'Collegedale Academy', website: 'ca.com', industry: 'education management', country: 'united states' },
            { id: 'pdl-3', name: 'United Franchise Group', website: 'ufg.com', industry: 'consumer services', country: 'united states' },
          ],
        },
        rpcHandlers: PDL_RPC,
      });
      const THREE_PDL_PLAN = {
        tasks: [
          { source: 'eng_hiring', rationale: 'signal', eng_hiring_query: { roles: ['franchise development'] } },
          { source: 'pdl', rationale: 'c1', pdl_filters: { industries: ['restaurants'] } },
          { source: 'pdl', rationale: 'c2', pdl_filters: { industries: ['education management'] } },
          { source: 'pdl', rationale: 'c3', pdl_filters: { industries: ['consumer services'] } },
        ],
      };
      callLLMMock
        .mockResolvedValueOnce(llmResult(THREE_PDL_PLAN))
        .mockResolvedValueOnce(llmResult({ belongs: [] })) // общая проба: всё мимо
        .mockResolvedValueOnce(llmResult({ rationale: 'name slice', pdl_filters: { name: 'franchise' } }))
        .mockResolvedValueOnce(llmResult({ belongs: [0] })) // проба repaired-среза
        .mockResolvedValue(llmResult({ irrelevant: [] }));

      await runBaseCollectStage(makeJob(), ctx('us'));

      const info = infoOf();
      // Все три pdl-задачи схлопнулись в один выверенный срез.
      expect(info.plan?.tasks.map((t) => t.source)).toEqual(['eng_hiring', 'pdl']);
      expect(info.plan?.tasks[1].pdl_filters).toEqual({ name: 'franchise' });
      expect(info.slice_probe).toMatchObject({ outcome: 'repaired', replaced_tasks: 3 });
    });

    it('сбой пробы не отбраковывает срез: блип модели не должен рубить вертикаль', async () => {
      seedWithCatalog();
      callLLMMock
        .mockResolvedValueOnce(llmResult(PDL_PLAN))
        .mockRejectedValueOnce(new Error('LLM 503')) // проба не состоялась
        .mockResolvedValue(llmResult({ irrelevant: [] }));

      const res = await runBaseCollectStage(makeJob(), ctx('us'));
      expect((res.result as { rows: number }).rows).toBe(1);
      expect(infoOf().slice_probe).toBeUndefined();
    });

    it("market='ru' не пробуется: у RU-плана каталог свой", async () => {
      mockDb = createMockSupabase({
        tables: {
          he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
          he_verticals: [{ ...VERTICAL, name: 'HR-агентства' }],
          he_projects: [{ ...PROJECT_RU, market: 'ru' }],
          he_jobs: [makeJob() as unknown as Record<string, unknown>],
          he_hypotheses: [
            { project_id: 'p1', vertical_id: 'v1', title: 'Кадровые бутики', description: null, tier: 1, status: 'accepted', potential_pct: 80 },
          ],
        },
      });
      callLLMMock
        .mockResolvedValueOnce(
          llmResult({ tasks: [{ source: 'companies_directory', rationale: 'р', directory_filters: { okvedCodes: ['78'] } }] }),
        )
        .mockResolvedValue(llmResult({ irrelevant: [] }));
      searchRowsMock.mockResolvedValue({ rows: [{ name: 'ООО Кадры', website: 'kadry.ru' }] });

      await runBaseCollectStage(makeJob(), ctx('ru'));
      expect(infoOf().slice_probe).toBeUndefined();
    });
  });

  it("market='ru' → RU-промпт планировщика (поведение не изменилось)", async () => {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
        he_verticals: [{ ...VERTICAL, name: 'HR-агентства' }],
        he_projects: [{ ...PROJECT_RU, market: 'ru' }],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        he_hypotheses: [
          { project_id: 'p1', vertical_id: 'v1', title: 'Кадровые бутики', description: null, tier: 1, status: 'accepted', potential_pct: 80 },
        ],
      },
    });
    callLLMMock.mockResolvedValue({
      data: {
        tasks: [
          { source: 'companies_directory', rationale: 'Реестр по ОКВЭД 78', directory_filters: { okvedCodes: ['78'] } },
        ],
      },
      tokensUsed: 10,
      promptTokens: 8,
      completionTokens: 2,
      costUsd: 0.0001,
      rawResponse: {},
    });
    searchRowsMock.mockResolvedValue({ rows: [{ name: 'ООО Кадры', website: 'kadry.ru' }] });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);
    expect(systemPromptOf()).toContain('Отвечай строго на русском');
    expect(systemPromptOf()).not.toContain('Answer strictly in English');
  });
});

/* ─────────────────────── DISPATCH: pdl ─────────────────────── */

describe('dispatch — pdl (прямое чтение pdl_companies)', () => {
  it('применяет фильтры industry/size/country (значения приводятся к lower) и мапит строки', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'pdl',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'pdl',
            rationale: 'r',
            pdl_filters: { industries: ['Software'], sizes: ['51-200'], countries: ['United States'] },
          },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        pdl_companies: [
          { id: '1', name: 'Acme Software', website: 'acme.com', industry: 'software', size: '51-200', country: 'united states', region: 'tx', locality: 'austin' },
          { id: '2', name: 'Beta Soft', website: 'beta.com', industry: 'software', size: '11-50', country: 'united states' },
          { id: '3', name: 'Gamma Health', website: 'gamma.com', industry: 'hospital & health care', size: '51-200', country: 'united states' },
          { id: '4', name: 'Delta Soft DE', website: 'delta.de', industry: 'software', size: '51-200', country: 'germany' },
        ],
      },
      rpcHandlers: PDL_RPC,
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);

    // Дочерних джоб нет, base_analyze поставлен.
    expect(mockDb.inserts.filter((i) => i.table !== 'he_jobs')).toHaveLength(0);
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')?.rows[0]).toEqual(
      expect.objectContaining({ stage: 'base_analyze' }),
    );

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.status).toBe('analyzing');
    const data = harvest?.data as HeUnifiedRow[];
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual(
      row({
        company: 'Acme Software',
        website: 'acme.com',
        address: 'austin, tx, united states',
        category: 'software',
        employees: '51-200',
        source_detail: 'pdl',
      }),
    );
    const savedInfo = harvest?.collect_info as HeCollectInfo;
    expect(savedInfo.tasks?.[0]).toMatchObject({ status: 'done', rows: 1 });
  });

  it('name-фильтр — подстрока по имени (ilike), без учёта регистра', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'pdl',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'pdl', rationale: 'r', pdl_filters: { name: 'acme' } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        pdl_companies: [
          { id: '1', name: 'Acme Corp', website: 'acme.com', country: 'united states' },
          { id: '2', name: 'ACME Labs', website: 'acmelabs.io', country: 'united states' },
          { id: '3', name: 'Beta Industries', website: 'beta.com', country: 'united states' },
        ],
      },
      rpcHandlers: PDL_RPC,
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(2);
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect((harvest?.data as HeUnifiedRow[]).map((r) => r.company).sort()).toEqual(['ACME Labs', 'Acme Corp']);
  });

  it('лимит сборки режет выдачу каталога (150 строк → 120 при limit=120)', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'pdl',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'pdl', rationale: 'r', pdl_filters: { industries: ['software'] } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        pdl_companies: Array.from({ length: 150 }, (_, i) => ({
          id: `pdl-${String(i).padStart(3, '0')}`,
          name: `corp-${i}`,
          website: `corp${i}.com`,
          industry: 'software',
          country: 'united states',
        })),
      },
      rpcHandlers: PDL_RPC,
    });

    const res = await runBaseCollectStage(makeJob({ payload: { base_id: 'b1', limit: 120 } }), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(120);
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.row_count).toBe(120);
  });

  it('чтение каталога повторяется с РАСТУЩИМИ паузами, пока не выйдут попытки', async () => {
    // Холодный срез pdl (19.5M строк) читается с диска десятки секунд, шлюз
    // отдаёт 504 раньше — но неудавшаяся попытка прогревает кэш. Поэтому пауз
    // несколько и они растут; на единственной трёхсекундной сборка Franchise
    // Brands 12.08 легла (pdl упал, база вышла на 7 строк).
    process.env.HE_PDL_READ_RETRY_DELAYS_MS = '0,0,0';
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'pdl',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'pdl', rationale: 'r', pdl_filters: { industries: ['software'] } },
        },
      ],
    };
    let calls = 0;
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        pdl_companies: [
          { id: '1', name: 'Acme Software', website: 'acme.com', industry: 'software', country: 'united states' },
        ],
      },
      rpcHandlers: {
        search_pdl_companies: (params, db) => {
          calls += 1;
          // Три подряд отказа «холодного» чтения, успех — только с четвёртой.
          if (calls <= 3) return { data: null, error: { message: 'canceling statement due to statement timeout' } };
          return pdlRpcHandler(params, db);
        },
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);
    // 4 попытки = 3 паузы из графика + первая без паузы.
    expect(calls).toBe(4);
  }, 15000);

  it('повторная попытка чтения при транзиентной ошибке: страница перечитывается, сбор не падает', async () => {
    process.env.HE_PDL_READ_RETRY_DELAYS_MS = '0,0,0';
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'pdl',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'pdl', rationale: 'r', pdl_filters: { industries: ['software'] } },
        },
      ],
    };
    let calls = 0;
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        pdl_companies: [
          { id: '1', name: 'Acme Software', website: 'acme.com', industry: 'software', country: 'united states' },
        ],
      },
      rpcHandlers: {
        search_pdl_companies: (params, db) => {
          calls += 1;
          if (calls === 1) return { data: null, error: { message: 'gateway blip' } };
          return pdlRpcHandler(params, db);
        },
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);
    expect(calls).toBe(2);
    const savedInfo = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch?.collect_info as HeCollectInfo;
    expect(savedInfo.tasks?.[0]).toMatchObject({ status: 'done', rows: 1 });
  }, 15000);

  it('HTML maintenance-страница Kong в ошибке чтения режется до чистого текста', async () => {
    process.env.HE_PDL_READ_RETRY_DELAYS_MS = '0,0,0';
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'pdl',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'pdl', rationale: 'r', pdl_filters: { industries: ['software'] } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        pdl_companies: [],
      },
      rpcHandlers: {
        search_pdl_companies: () => ({
          data: null,
          error: { message: '<!doctype html>\n<html lang="ru"><head><title>Портал обновляется</title></head></html>' },
        }),
      },
    });

    await expect(runBaseCollectStage(makeJob(), ctx('us'))).rejects.toThrow(/Авто-сборка не дала строк/);
    // Финальный fail базы — с чистой ошибкой, без HTML-простыни Kong.
    const failPatch = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(failPatch?.status).toBe('failed');
    expect(String(failPatch?.error ?? '')).toContain('non-JSON response (gateway timeout/restart)');
    expect(String(failPatch?.error ?? '')).not.toContain('<html');
    const savedInfo = failPatch?.collect_info as HeCollectInfo | undefined;
    expect(savedInfo?.tasks?.[0]?.status).toBe('failed');
    expect(String(savedInfo?.tasks?.[0]?.error ?? '')).toContain('non-JSON response (gateway timeout/restart)');
  }, 15000);
});

/* ─────────────────────── DISPATCH: funded ─────────────────────── */

describe('dispatch — funded (прямое чтение funded_companies)', () => {
  it('фильтры country / min_funding (last ИЛИ total) / funded_since', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'funded',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'funded',
            rationale: 'r',
            funded_filters: { countries: ['united states'], min_funding_usd: 5_000_000, funded_since: '2026-01-01' },
          },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        funded_companies: [
          // Проходит по last_funding_usd.
          { id: 'yc:a', source: 'yc', name: 'FundedA', website: 'a.com', industry: 'fintech', country: 'united states', last_funding_usd: 6_000_000, total_funding_usd: 6_000_000, last_funding_date: '2026-03-01', last_funding_type: 'seed', batch: 'W26' },
          // Проходит по total_funding_usd (or-семантика min funding).
          { id: 'sec:b', source: 'sec_formd', name: 'FundedB', website: 'b.com', industry: 'biotech', country: 'united states', last_funding_usd: 1_000_000, total_funding_usd: 12_000_000, last_funding_date: '2026-02-01' },
          // Страна не та.
          { id: 'yc:c', source: 'yc', name: 'FundedC', website: 'c.de', country: 'germany', last_funding_usd: 9_000_000, last_funding_date: '2026-03-01' },
          // Раунд слишком мал.
          { id: 'yc:d', source: 'yc', name: 'FundedD', website: 'd.com', country: 'united states', last_funding_usd: 100_000, total_funding_usd: 100_000, last_funding_date: '2026-03-01' },
          // Раунд старый.
          { id: 'yc:e', source: 'yc', name: 'FundedE', website: 'e.com', country: 'united states', last_funding_usd: 8_000_000, last_funding_date: '2025-06-01' },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(2);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const data = harvest?.data as HeUnifiedRow[];
    const byCompany = new Map(data.map((r) => [r.company, r]));
    expect([...byCompany.keys()].sort()).toEqual(['FundedA', 'FundedB']);
    expect(byCompany.get('FundedA')).toEqual(
      row({
        company: 'FundedA',
        website: 'a.com',
        address: 'united states',
        category: 'fintech',
        source_detail: 'funded:yc',
      }),
    );
    expect(byCompany.get('FundedB')?.source_detail).toBe('funded:sec_formd');
  });
});

/* ─────────────────────── eng_hiring: SQL-предфильтр роли ─────────────────────── */

/**
 * Контракт предфильтра: выражение обязано быть НАДМНОЖЕСТВОМ совпадений
 * buildRolesRegex. Точность добирает regex в JS, а вот сузить выборку
 * предфильтр не имеет права — иначе молча теряются валидные вакансии.
 */
describe('buildRolesIlikeFilter — предфильтр роли для eng_hiring_cache', () => {
  it('роли → or-выражение ilike по vacancy_title', () => {
    expect(buildRolesIlikeFilter(['franchise development', 'vp franchise'])).toBe(
      'vacancy_title.ilike.%franchise development%,vacancy_title.ilike.%vp franchise%',
    );
  });

  it('запятая внутри роли режет её на термы — как в buildRolesRegex', () => {
    expect(buildRolesIlikeFilter(['head of sales, cro'])).toBe(
      'vacancy_title.ilike.%head of sales%,vacancy_title.ilike.%cro%',
    );
  });

  it('терм со спецсимволом обрезается до префикса — ilike по префиксу шире точного совпадения', () => {
    expect(buildRolesIlikeFilter(['vp franchise (us)'])).toBe('vacancy_title.ilike.%vp franchise%');
    expect(buildRolesIlikeFilter(['sr. account executive'])).toBe('vacancy_title.ilike.%sr%');
  });

  it('b2b-роль → предфильтра нет: regex раскрывает её в ~30 альтернатив, ilike их не выразит', () => {
    expect(buildRolesIlikeFilter(['b2b sales'])).toBeNull();
    expect(buildRolesIlikeFilter(['account executive', 'b2b sales'])).toBeNull();
  });

  it('терм, начинающийся со спецсимвола, → предфильтра нет (пустой префикс матчил бы всё)', () => {
    expect(buildRolesIlikeFilter(['(interim) head of sales'])).toBeNull();
  });

  it('пустой список ролей → предфильтра нет', () => {
    expect(buildRolesIlikeFilter([])).toBeNull();
    expect(buildRolesIlikeFilter(['   '])).toBeNull();
  });
});

/* ─────────────────────── DISPATCH: eng_hiring ─────────────────────── */

describe('dispatch — eng_hiring (прямое чтение eng_hiring_cache)', () => {
  it('роль regex по vacancy_title, страна по country_code, свежесть по published_at, дедуп по компании (свежая выживает)', async () => {
    const now = Date.now();
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'eng_hiring',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'eng_hiring',
            rationale: 'r',
            eng_hiring_query: { roles: ['account executive'], countries: ['us'], posted_within_days: 30 },
          },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        eng_hiring_cache: [
          // Две вакансии одной компании: выживает более свежая (Senior AE, 2 дня).
          { id: 'v1', source: 'greenhouse', company_name: 'Globex', company_site_url: 'https://globex.com', vacancy_title: 'Account Executive', location: 'New York, NY', country_code: 'us', published_at: daysAgo(5) },
          { id: 'v2', source: 'greenhouse', company_name: 'Globex', company_site_url: 'https://globex.com', vacancy_title: 'Senior Account Executive', location: 'Remote', country_code: 'us', published_at: daysAgo(2) },
          // Роль не та.
          { id: 'v3', source: 'lever', company_name: 'Initech', company_site_url: 'https://initech.com', vacancy_title: 'Software Engineer', location: 'Austin, TX', country_code: 'us', published_at: daysAgo(1) },
          // Страна не та.
          { id: 'v4', source: 'lever', company_name: 'Umbrella', company_site_url: 'https://umbrella.de', vacancy_title: 'Account Executive', location: 'Berlin', country_code: 'de', published_at: daysAgo(1) },
          // Вакансия старая (> 30 дней).
          { id: 'v5', source: 'ashby', company_name: 'Stark', company_site_url: 'https://stark.com', vacancy_title: 'Account Executive', location: 'Malibu, CA', country_code: 'us', published_at: daysAgo(90) },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const data = harvest?.data as HeUnifiedRow[];
    expect(data).toEqual([
      row({
        company: 'Globex',
        website: 'https://globex.com',
        vacancy_title: 'Senior Account Executive',
        address: 'Remote',
        source_detail: 'eng_hiring:greenhouse',
      }),
    ]);
  });

  it('роль уходит в SQL-предфильтр: узкая роль собирается, хотя в кэше полно свежего мусора', async () => {
    // Регрессия 12.08.2026: роль отбиралась только в JS — после усечения выборки
    // потолком страниц по свежести. На проде под «страна + 90 дней» подходило
    // 336k строк, сканировались первые 20k, и узкие роли давали ровно 0.
    // Здесь предфильтр обязан отобрать вакансию по роли и не срезать её сам.
    const now = Date.now();
    const fresh = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'eng_hiring',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'eng_hiring',
            rationale: 'r',
            eng_hiring_query: {
              roles: ['franchise development', 'director of franchise'],
              countries: ['us'],
              posted_within_days: 90,
            },
          },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        eng_hiring_cache: [
          // Свежий нерелевантный шум — на проде именно он забивал окно сканирования.
          ...Array.from({ length: 30 }, (_, i) => ({
            id: `noise-${i}`,
            source: 'greenhouse',
            company_name: `Noise ${i}`,
            company_site_url: `https://noise${i}.com`,
            vacancy_title: 'Software Engineer',
            location: 'Austin, TX',
            country_code: 'us',
            published_at: fresh(1),
          })),
          {
            id: 'target',
            source: 'lever',
            company_name: 'Franchise Group',
            company_site_url: 'https://franchisegroup.com',
            vacancy_title: 'Director of Franchise Development',
            location: 'Dallas, TX',
            country_code: 'us',
            published_at: fresh(40),
          },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect((harvest?.data as HeUnifiedRow[])[0].company).toBe('Franchise Group');
  });

  it('строке без сайта досбирается домен из каталога — иначе конструктор её теряет', async () => {
    // У ATS-фида сайт заполнен у ~13% строк. На сборке Franchise Brands 12.08
    // из-за этого выпали ЕДИНСТВЕННЫЕ компании по вертикали (их нашли по
    // вакансии «franchise development»), и в базе не осталось ни одной строки
    // eng_hiring.
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'eng_hiring',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'eng_hiring',
            rationale: 'r',
            eng_hiring_query: { roles: ['franchise development'], countries: ['us'] },
          },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        eng_hiring_cache: [
          {
            id: 'v1',
            source: 'lever',
            company_name: 'United Franchise Group',
            company_site_url: null,
            vacancy_title: 'Director of Franchise Development',
            location: 'West Palm Beach, FL',
            country_code: 'us',
            published_at: new Date().toISOString(),
          },
        ],
        pdl_companies: [
          {
            id: 'pdl-1',
            name: 'United Franchise Group',
            website: 'ufgcorp.com',
            country: 'united states',
            industry: 'consumer services',
          },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const collected = (harvest?.data as HeUnifiedRow[])[0];
    expect(collected.company).toBe('United Franchise Group');
    expect(collected.website).toBe('https://ufgcorp.com');
  });

  it('имеющийся сайт строки не перетирается досбором', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'eng_hiring',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'eng_hiring', rationale: 'r', eng_hiring_query: { roles: ['franchise development'] } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        eng_hiring_cache: [
          {
            id: 'v1',
            source: 'lever',
            company_name: 'United Franchise Group',
            company_site_url: 'https://real-site.com',
            vacancy_title: 'Franchise Development Manager',
            location: 'FL',
            country_code: 'us',
            published_at: new Date().toISOString(),
          },
        ],
        // В каталоге у той же компании ДРУГОЙ домен — досбор не должен его подставить.
        pdl_companies: [
          { id: 'pdl-1', name: 'United Franchise Group', website: 'ufgcorp.com', country: 'united states' },
        ],
      },
    });

    await runBaseCollectStage(makeJob(), ctx('us'));
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect((harvest?.data as HeUnifiedRow[])[0].website).toBe('https://real-site.com');
  });

  it('коллизия имени в каталоге → сайт не подставляется (неверный домен хуже пустого)', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'eng_hiring',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'eng_hiring', rationale: 'r', eng_hiring_query: { roles: ['franchise development'] } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        eng_hiring_cache: [
          {
            id: 'v1',
            source: 'lever',
            company_name: 'Momentum',
            company_site_url: null,
            vacancy_title: 'Franchise Development Lead',
            location: 'NY',
            country_code: 'us',
            published_at: new Date().toISOString(),
          },
        ],
        // Две РАЗНЫЕ компании с одним именем: угадывать нельзя.
        pdl_companies: [
          { id: 'p1', name: 'Momentum', website: 'momentum-a.com', country: 'united states' },
          { id: 'p2', name: 'Momentum', website: 'momentum-b.com', country: 'united states' },
        ],
      },
    });

    await runBaseCollectStage(makeJob(), ctx('us'));
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect((harvest?.data as HeUnifiedRow[])[0].website).toBe('');
  });

  it('несколько ролей матчатся как альтернативы (keywords через запятую)', async () => {
    const now = Date.now();
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'eng_hiring',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'eng_hiring',
            rationale: 'r',
            eng_hiring_query: { roles: ['account executive', 'head of sales'], posted_within_days: 30 },
          },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        eng_hiring_cache: [
          { id: 'v1', source: 'lever', company_name: 'Globex', company_site_url: 'https://globex.com', vacancy_title: 'Head of Sales', location: 'NYC', country_code: 'us', published_at: new Date(now - 86_400_000).toISOString() },
          { id: 'v2', source: 'lever', company_name: 'Initech', company_site_url: 'https://initech.com', vacancy_title: 'Product Manager', location: 'Austin', country_code: 'us', published_at: new Date(now - 86_400_000).toISOString() },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(1);
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect((harvest?.data as HeUnifiedRow[])[0].vacancy_title).toBe('Head of Sales');
  });
});

/* ─────────────────────── DISPATCH: google_maps по market ─────────────────────── */

describe('dispatch — google_maps language/region по market', () => {
  it("market='us' → language 'en', region 'US' в конфиге дочерней джобы", async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        {
          source: 'google_maps',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'google_maps', rationale: 'r', maps_query: { queries: ['dentist'], geo: 'Austin' } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT_US],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { waiting: boolean }).waiting).toBe(true);

    const gmInsert = mockDb.inserts.find((i) => i.table === 'google_maps_jobs');
    expect(gmInsert?.rows[0]).toEqual(
      expect.objectContaining({
        status: 'queued',
        config: {
          inputLines: ['dentist Austin'],
          limitPerQuery: 100,
          language: 'en',
          region: 'US',
          enrichContacts: true,
          minDelayMs: 1200,
          maxDelayMs: 2800,
        },
      }),
    );
  });
});

/* ─────────────────────── vocab: выбор промпта по market ─────────────────────── */

describe('buildVocabMessagesEn', () => {
  it('системный промпт — на английском, с разметкой buyer/campaign_target', () => {
    const msgs = buildVocabMessagesEn({
      verticalName: 'Staffing agencies',
      verticalSummary: 'Recruitment and staffing',
      synonyms: ['recruitment agencies'],
      hypotheses: [{ title: 'Mid-size agencies', description: 'grow via retained search', tier: 1, confirmed: true }],
    });
    expect(msgs).toHaveLength(2);
    const system = msgs[0].content;
    expect(system).toContain('Answer strictly in English');
    expect(system).not.toContain('Отвечай строго на русском');
    expect(system).toContain('buyer');
    expect(system).toContain('campaign_target');

    const user = msgs[1].content;
    expect(user).toContain('Staffing agencies');
    expect(user).toContain('Mid-size agencies');
    // Подтверждённая специалистом гипотеза помечена (EN-маркер).
    expect(user).toContain('✓ SPECIALIST-CONFIRMED');
  });
});

describe('runVocabStage — выбор промпта по market', () => {
  const VOCAB_DATA = { company_types: [], job_titles: [], search_queries: [] };

  function makeVocabJob(projectId: string): HeJob {
    return {
      ...makeJob(),
      stage: 'vocab',
      payload: { vertical_id: 'v1' },
      project_id: projectId,
    };
  }

  async function runVocab(project: Record<string, unknown>) {
    mockDb = createMockSupabase({
      tables: {
        he_projects: [project],
        he_verticals: [VERTICAL],
        he_hypotheses: [
          { project_id: project.id, vertical_id: 'v1', title: 'Mid-size agencies', description: 'd', tier: 1, status: 'accepted' },
        ],
        he_vocab: [],
      },
    });
    callLLMMock.mockResolvedValue({ data: VOCAB_DATA, tokensUsed: 10, costUsd: 0.01 });
    return runVocabStage(makeVocabJob(project.id as string), {
      supabase: mockDb as unknown as SupabaseClient,
      search: async () => [],
    });
  }

  it("market='us' (фолбэк на he_projects.market) → EN-промпт, he_vocab вставлен", async () => {
    const out = await runVocab({ id: 'p-us', market: 'us' });

    expect(callLLMMock).toHaveBeenCalledTimes(1);
    expect(systemPromptOf()).toContain('Answer strictly in English');
    expect(systemPromptOf()).not.toContain('Отвечай строго на русском');

    const insert = mockDb.inserts.find((i) => i.table === 'he_vocab');
    expect(insert?.rows[0]).toEqual(expect.objectContaining({ vertical_id: 'v1', status: 'ready' }));
    expect((out.result as { vocab_id: string }).vocab_id).toBeTruthy();
  });

  it('без market (старая строка) → RU-промпт, поведение не изменилось', async () => {
    await runVocab({ id: 'p-ru' });
    expect(systemPromptOf()).toContain('Отвечай строго на русском');
  });
});
