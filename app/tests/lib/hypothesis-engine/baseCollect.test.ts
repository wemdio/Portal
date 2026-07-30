/** @jest-environment node */

/**
 * Tests for the base_collect stage (auto-collect orchestrator):
 *
 *   pure helpers     — each source row → unified row, dedup, filter/query builders
 *   DISPATCH         — hh/yandex/google child job insert shapes; directory via searchRows
 *   WAIT / requeue   — own he_jobs row → status 'pending', attempts untouched
 *   HARVEST          — child rows merged into he_bases (+base_analyze enqueue),
 *                      zero rows → base failed + job throws
 *   guards           — base must be source='auto' AND status='collecting'
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { HeJob } from '@/lib/hypothesisEngine/types';

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
}));

jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getHeModel: jest.fn(() => 'test-bulk-model'),
}));

import { searchRows } from '@/lib/companiesSearch/rpcSearch';
import { callLLMWithSchema } from '@/lib/hypothesisEngine/llm';
import {
  buildGoogleInputLines,
  buildYandexSearchUrls,
  dedupUnifiedRows,
  HE_AUTO_COLLECT_COLUMNS,
  mapDirectoryFilters,
  mapDirectoryRow,
  mapGoogleRow,
  mapHhRow,
  mapYandexRow,
  runBaseCollectStage,
  type HeCollectInfo,
  type HeUnifiedRow,
} from '@/lib/hypothesisEngine/stages/baseCollect';

const searchRowsMock = searchRows as unknown as jest.Mock;
const callLLMMock = callLLMWithSchema as unknown as jest.Mock;

let mockDb: MockSupabaseClient = createMockSupabase();

const PROJECT = { id: 'p1', name: 'P', created_by: 'user-1' };
const VERTICAL = {
  id: 'v1',
  project_id: 'p1',
  name: 'HR-агентства',
  summary: 'Подбор персонала',
  synonyms: ['кадровые агентства'],
  potential_pct: 50,
  rank: 1,
};

function makeBase(collectInfo: HeCollectInfo | null): Record<string, unknown> {
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
    started_at: '2026-07-30T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-07-30T00:00:00Z',
    updated_at: '2026-07-30T00:00:00Z',
    ...overrides,
  };
}

function ctx() {
  return { supabase: mockDb as unknown as SupabaseClient };
}

function row(partial: Partial<HeUnifiedRow>): HeUnifiedRow {
  const full = {} as HeUnifiedRow;
  for (const col of HE_AUTO_COLLECT_COLUMNS) full[col] = partial[col] ?? '';
  return full;
}

beforeEach(() => {
  jest.clearAllMocks();
});

/* ─────────────────────────── Pure helpers ─────────────────────────── */

describe('source row → unified row mapping', () => {
  it('maps a companies_directory row (phones[0], okved → category, реестр)', () => {
    const mapped = mapDirectoryRow({
      name: 'ООО Код',
      website: 'code.ru',
      email: 'hi@code.ru',
      phones: ['+7999000001', '+7999000002'],
      address: 'Москва',
      okved_code: '62.01',
      employees_count: 50,
      revenue: 10_000_000,
      inn: '7700000001',
    });
    expect(mapped).toEqual(
      row({
        company: 'ООО Код',
        website: 'code.ru',
        email: 'hi@code.ru',
        phone: '+7999000001',
        address: 'Москва',
        category: '62.01',
        employees: '50',
        revenue: '10000000',
        inn: '7700000001',
        source_detail: 'реестр',
      }),
    );
  });

  it('maps a directory row with missing fields to empty cells', () => {
    const mapped = mapDirectoryRow({ name: 'ООО Пусто' });
    expect(mapped.company).toBe('ООО Пусто');
    expect(mapped.phone).toBe('');
    expect(mapped.revenue).toBe('');
    expect(mapped.source_detail).toBe('реестр');
  });

  it('maps an hh vacancy row (vacancy → vacancy_title, hh: query detail)', () => {
    const mapped = mapHhRow(
      {
        name: 'Рекрутер',
        company_name: 'АС',
        company_site_url: 'as.ru',
        area: 'Москва',
      },
      'рекрутер',
    );
    expect(mapped).toEqual(
      row({
        company: 'АС',
        website: 'as.ru',
        vacancy_title: 'Рекрутер',
        address: 'Москва',
        source_detail: 'hh: рекрутер',
      }),
    );
  });

  it('maps a yandex organization row (categories → category)', () => {
    const mapped = mapYandexRow({
      name: 'Стоматология Улыбка',
      website: 'smile.ru',
      email: 'a@smile.ru',
      phone: '+78432',
      address: 'Казань, Баумана 1',
      categories: 'Стоматология',
    });
    expect(mapped).toEqual(
      row({
        company: 'Стоматология Улыбка',
        website: 'smile.ru',
        email: 'a@smile.ru',
        phone: '+78432',
        address: 'Казань, Баумана 1',
        category: 'Стоматология',
        source_detail: 'яндекс.карты',
      }),
    );
  });

  it('maps a google place row (emails[0], category)', () => {
    const mapped = mapGoogleRow({
      name: 'Автосервис Драйв',
      website: 'drive.ru',
      emails: ['x@drive.ru', 'y@drive.ru'],
      phone: '+7999',
      address: 'Тула',
      category: 'car_repair',
    });
    expect(mapped.email).toBe('x@drive.ru');
    expect(mapped.category).toBe('car_repair');
    expect(mapped.source_detail).toBe('google maps');
    expect(mapGoogleRow({ name: 'N' }).email).toBe('');
  });
});

describe('dedupUnifiedRows', () => {
  it('dedups by lowercase company+website, first occurrence wins', () => {
    const a = row({ company: 'АС', website: 'as.ru', phone: '1' });
    const dup = row({ company: ' ас ', website: 'AS.RU', phone: '2' });
    const otherSite = row({ company: 'АС', website: 'as2.ru' });
    const out = dedupUnifiedRows([a, dup, otherSite]);
    expect(out).toHaveLength(2);
    expect(out[0].phone).toBe('1');
    expect(out[1].website).toBe('as2.ru');
  });
});

describe('collector request builders', () => {
  it('maps directory_filters to CompaniesSearchFilters (set fields only)', () => {
    expect(
      mapDirectoryFilters({
        okvedCodes: ['62'],
        regionCodes: ['77'],
        revenueFrom: 1,
        employeesTo: 100,
        hasEmail: true,
        includeIp: false,
      }),
    ).toEqual({
      okvedCodes: ['62'],
      regionCodes: ['77'],
      revenueFrom: 1,
      employeesTo: 100,
      hasEmail: true,
      includeIp: false,
    });
    expect(mapDirectoryFilters({})).toEqual({});
    expect(mapDirectoryFilters(undefined)).toEqual({});
    expect(mapDirectoryFilters({ okvedCodes: [] })).toEqual({});
  });

  it('builds yandex search urls (geo appended, url-encoded)', () => {
    expect(buildYandexSearchUrls({ queries: ['стоматология'], geo: 'Казань' })).toEqual([
      `https://yandex.ru/maps/?text=${encodeURIComponent('стоматология Казань')}`,
    ]);
    expect(buildYandexSearchUrls({ queries: ['a', 'b'] })).toEqual([
      'https://yandex.ru/maps/?text=a',
      'https://yandex.ru/maps/?text=b',
    ]);
  });

  it('builds google inputLines (geo appended per query)', () => {
    expect(buildGoogleInputLines({ queries: ['стоматология'], geo: 'Казань' })).toEqual([
      'стоматология Казань',
    ]);
    expect(buildGoogleInputLines({ queries: ['a'] })).toEqual(['a']);
  });
});

/* ─────────────────────────── Stage guards ─────────────────────────── */

describe('guards', () => {
  it('fails when the base is not source=auto', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [{ ...makeBase(null), source: 'upload', status: 'uploaded' }],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
      },
    });
    await expect(runBaseCollectStage(makeJob(), ctx())).rejects.toThrow(/source='upload'/);
  });

  it('fails when the base is not collecting anymore', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [{ ...makeBase(null), status: 'analyzed' }],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
      },
    });
    await expect(runBaseCollectStage(makeJob(), ctx())).rejects.toThrow(/status='analyzed'/);
  });
});

/* ─────────────────────────── DISPATCH + WAIT ─────────────────────────── */

describe('dispatch + wait', () => {
  it('inserts hh/yandex/google child jobs with collector configs, then self-requeues', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        {
          source: 'hh_live',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'hh_live',
            rationale: 'r',
            hh_query: { text: 'рекрутер', area: '1', date_from: '2026-07-01' },
          },
        },
        {
          source: 'yandex_maps',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'yandex_maps', rationale: 'r', maps_query: { queries: ['стоматология'], geo: 'Казань' } },
        },
        {
          source: 'google_maps',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'google_maps', rationale: 'r', maps_query: { queries: ['стоматология'], geo: 'Казань' } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { waiting: boolean }).waiting).toBe(true);

    // hh → parser_jobs
    const hhInsert = mockDb.inserts.find((i) => i.table === 'parser_jobs');
    expect(hhInsert?.rows[0]).toEqual(
      expect.objectContaining({
        user_id: 'user-1',
        parser_type: 'hh_vacancies',
        status: 'pending',
        config: { text: 'рекрутер', per_page: 100, area: '1', date_from: '2026-07-01' },
      }),
    );

    // yandex → yandex_maps_jobs
    const ymInsert = mockDb.inserts.find((i) => i.table === 'yandex_maps_jobs');
    expect(ymInsert?.rows[0]).toEqual(
      expect.objectContaining({
        user_id: 'user-1',
        status: 'pending',
        config: {
          search_urls: [`https://yandex.ru/maps/?text=${encodeURIComponent('стоматология Казань')}`],
          max_results: 500,
          headless: true,
        },
      }),
    );

    // google → google_maps_jobs
    const gmInsert = mockDb.inserts.find((i) => i.table === 'google_maps_jobs');
    expect(gmInsert?.rows[0]).toEqual(
      expect.objectContaining({
        user_id: 'user-1',
        status: 'queued',
        total_targets: 1,
        config: {
          inputLines: ['стоматология Казань'],
          limitPerQuery: 100,
          language: 'ru',
          region: 'RU',
          enrichContacts: true,
        },
      }),
    );

    // Дочерние джобы pending/queued → self-requeue: своя строка → pending,
    // attempts НЕ трогаем (клейм воркера сам инкрементирует).
    const requeue = mockDb.updates.find((u) => u.table === 'he_jobs');
    expect(requeue?.patch).toMatchObject({ status: 'pending', started_at: null });
    expect(requeue?.patch).not.toHaveProperty('attempts');

    // child_job_id задач персистнуты в collect_info
    const baseUpdates = mockDb.updates.filter((u) => u.table === 'he_bases');
    const lastInfo = baseUpdates.at(-1)?.patch.collect_info as HeCollectInfo;
    expect(lastInfo.tasks?.every((t) => t.status === 'dispatched' && t.child_job_id)).toBe(true);
  });

  it('requeues while a child job is still running (attempts untouched)', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        {
          source: 'hh_live',
          status: 'dispatched',
          child_job_id: 'pj1',
          rows: 0,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        parser_jobs: [{ id: 'pj1', status: 'running' }],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    const result = res.result as { waiting: boolean; pending_sources: string[] };
    expect(result.waiting).toBe(true);
    expect(result.pending_sources).toEqual(['hh_live']);

    const requeue = mockDb.updates.find((u) => u.table === 'he_jobs');
    expect(requeue?.patch.status).toBe('pending');
    expect(requeue?.patch).not.toHaveProperty('attempts');
    // Ни база не тронута статусом, ни base_analyze не поставлен.
    expect(mockDb.updates.filter((u) => u.table === 'he_bases').every((u) => !('status' in u.patch))).toBe(true);
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();
  });
});

/* ─────────────────────────── HARVEST ─────────────────────────── */

describe('harvest', () => {
  it('merges completed child rows into he_bases and enqueues base_analyze', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        {
          source: 'hh_live',
          status: 'dispatched',
          child_job_id: 'pj1',
          rows: 0,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        parser_jobs: [{ id: 'pj1', status: 'completed', error_message: null }],
        hh_vacancies: [
          { job_id: 'pj1', name: 'Рекрутер', company_name: 'АС', company_site_url: 'as.ru', area: 'Москва' },
          // дубль по company+website (регистр) — отбрасывается
          { job_id: 'pj1', name: 'HR-менеджер', company_name: 'ас', company_site_url: 'AS.ru', area: 'СПб' },
          // без компании — отбрасывается
          { job_id: 'pj1', name: 'Sourcer', company_name: '', company_site_url: '', area: 'Москва' },
          // чужая джоба — не попадает
          { job_id: 'pj2', name: 'X', company_name: 'Чужая', company_site_url: 'x.ru', area: 'Москва' },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    const result = res.result as { rows: number; tasks_done: number };
    expect(result.rows).toBe(1);
    expect(result.tasks_done).toBe(1);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest).toMatchObject({ status: 'analyzing', row_count: 1 });
    expect(harvest?.columns).toEqual([...HE_AUTO_COLLECT_COLUMNS]);
    const data = harvest?.data as HeUnifiedRow[];
    expect(data).toHaveLength(1);
    expect(data[0]).toEqual(
      row({
        company: 'АС',
        website: 'as.ru',
        vacancy_title: 'Рекрутер',
        address: 'Москва',
        source_detail: 'hh: рекрутер',
      }),
    );
    expect((harvest?.sample_rows as unknown[]).length).toBe(1);
    expect((harvest?.collect_info as HeCollectInfo).stats).toMatchObject({
      tasks_total: 1,
      tasks_done: 1,
      tasks_failed: 0,
      rows_total: 1,
    });

    const nextJob = mockDb.inserts.find((i) => i.table === 'he_jobs');
    expect(nextJob?.rows[0]).toEqual(
      expect.objectContaining({
        project_id: 'p1',
        stage: 'base_analyze',
        status: 'pending',
        payload: { base_id: 'b1' },
      }),
    );
  });

  it('dispatches companies_directory synchronously via searchRows and harvests immediately', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        {
          source: 'companies_directory',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: {
            source: 'companies_directory',
            rationale: 'r',
            directory_filters: { okvedCodes: ['62'], hasEmail: true },
          },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });
    searchRowsMock.mockResolvedValue({
      rows: [
        {
          name: 'ООО Код',
          website: 'code.ru',
          email: 'hi@code.ru',
          phones: ['+7999'],
          address: 'Мск',
          okved_code: '62.01',
          employees_count: 50,
          revenue: 10_000_000,
          inn: '7700000001',
        },
      ],
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);

    expect(searchRowsMock).toHaveBeenCalledWith({ okvedCodes: ['62'], hasEmail: true }, 2000);
    // Без дочерних джоб парсеров.
    expect(mockDb.inserts.filter((i) => i.table !== 'he_jobs')).toHaveLength(0);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.status).toBe('analyzing');
    const data = harvest?.data as HeUnifiedRow[];
    expect(data[0]).toEqual(
      row({
        company: 'ООО Код',
        website: 'code.ru',
        email: 'hi@code.ru',
        phone: '+7999',
        address: 'Мск',
        category: '62.01',
        employees: '50',
        revenue: '10000000',
        inn: '7700000001',
        source_detail: 'реестр',
      }),
    );
  });

  it('failed task does not fail the job when another task produced rows', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        {
          source: 'hh_live',
          status: 'dispatched',
          child_job_id: 'pj1',
          rows: 0,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
        },
        {
          source: 'yandex_maps',
          status: 'dispatched',
          child_job_id: 'ym1',
          rows: 0,
          task: { source: 'yandex_maps', rationale: 'r', maps_query: { queries: ['q'] } },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        parser_jobs: [{ id: 'pj1', status: 'completed', error_message: null }],
        yandex_maps_jobs: [{ id: 'ym1', status: 'failed', error_message: 'captcha' }],
        hh_vacancies: [
          { job_id: 'pj1', name: 'Рекрутер', company_name: 'АС', company_site_url: 'as.ru', area: 'Москва' },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    const result = res.result as { rows: number; tasks_failed: number; failed_sources: string[] };
    expect(result.rows).toBe(1);
    expect(result.tasks_failed).toBe(1);
    expect(result.failed_sources).toEqual(['yandex_maps']);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.status).toBe('analyzing');
    expect((harvest?.collect_info as HeCollectInfo).stats).toMatchObject({
      tasks_total: 2,
      tasks_done: 1,
      tasks_failed: 1,
    });
    expect(
      (harvest?.collect_info as HeCollectInfo).tasks?.find((t) => t.source === 'yandex_maps')?.error,
    ).toBe('captcha');
  });

  it('zero rows total → base failed with breakdown and the job throws', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        {
          source: 'companies_directory',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'companies_directory', rationale: 'r', directory_filters: {} },
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(info)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });
    searchRowsMock.mockResolvedValue({ rows: [] });

    await expect(runBaseCollectStage(makeJob(), ctx())).rejects.toThrow(/не дала строк/);

    const fail = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(fail?.status).toBe('failed');
    expect(String(fail?.error)).toContain('не дала строк');
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();
  });
});

/* ─────────────────────────── PLAN ─────────────────────────── */

describe('plan phase', () => {
  it('builds the source plan via LLM from non-rejected hypotheses and vocab, then persists it', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(null)],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        he_hypotheses: [
          { project_id: 'p1', vertical_id: 'v1', title: 'Кадровые агентства растут', description: 'd', tier: 1, status: 'accepted', potential_pct: 80 },
          { project_id: 'p1', vertical_id: 'v1', title: 'Отклонённая', description: null, tier: 2, status: 'rejected', potential_pct: 10 },
        ],
        he_vocab: [
          { vertical_id: 'v1', company_types: [{ term: 'hr-агентство' }, { term: 'кадровое агентство' }] },
        ],
      },
    });
    callLLMMock.mockResolvedValue({
      data: {
        tasks: [
          { source: 'companies_directory', rationale: 'Реестр по ОКВЭД 78', directory_filters: { okvedCodes: ['78'] } },
        ],
      },
      tokensUsed: 100,
      promptTokens: 80,
      completionTokens: 20,
      costUsd: 0.001,
      rawResponse: {},
    });
    searchRowsMock.mockResolvedValue({
      rows: [{ name: 'ООО Кадры', website: 'kadry.ru', phones: [], inn: '1' }],
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);
    expect(res.tokensUsed).toBe(100);

    // Один LLM-вызов, в контексте — вертикаль и ТОЛЬКО неотклонённые гипотезы.
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const [messages, , llmOpts] = callLLMMock.mock.calls[0] as [
      Array<{ role: string; content: string }>,
      unknown,
      { model: string },
    ];
    const user = messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('HR-агентства');
    expect(user).toContain('Кадровые агентства растут');
    expect(user).not.toContain('Отклонённая');
    expect(user).toContain('hr-агентство');
    expect(llmOpts.model).toBe('test-bulk-model');

    // План и задача персистнуты в collect_info до dispatch.
    const planUpdate = mockDb.updates
      .filter((u) => u.table === 'he_bases')
      .find((u) => (u.patch.collect_info as HeCollectInfo | undefined)?.plan);
    expect(planUpdate).toBeDefined();
    const info = planUpdate?.patch.collect_info as HeCollectInfo;
    expect(info.plan?.tasks[0].source).toBe('companies_directory');
    expect(info.tasks?.[0]).toMatchObject({ source: 'companies_directory', child_job_id: null });
  });
});
