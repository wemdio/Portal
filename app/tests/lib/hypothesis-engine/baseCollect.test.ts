/** @jest-environment node */

/**
 * Tests for the base_collect stage (auto-collect orchestrator):
 *
 *   pure helpers     — each source row → unified row, dedup, filter/query builders
 *   DISPATCH         — hh/yandex/google child job insert shapes; directory via searchRows
 *   WAIT / requeue   — own he_jobs row → status 'pending' + run_after cooldown,
 *                      attempts untouched; stuck child (>3h) → task failed (timeout)
 *   HARVEST          — child rows merged into he_bases (+base_analyze enqueue),
 *                      total cap from job payload limit (default 10000, clamp
 *                      [100, 50000]), zero rows → base failed + job throws
 *   continuation     — other-base companies are skipped DURING directory paging
 *                      (only new rows count toward limit, 200-page ceiling),
 *                      exhausted registry → task note «реестр исчерпан»,
 *                      200-page ceiling → note «предел сканирования 200k»
 *                      (NOT exhaustion), all-exhausted + 0 new + no failed
 *                      tasks → «Сегмент исчерпан» failure;
 *                      merge-time exclusion stays as the hh/maps safety net
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
  interleaveTaskHarvests,
  mapDirectoryFilters,
  mapDirectoryRow,
  mapGoogleRow,
  mapHhRow,
  mapYandexRow,
  normalizeCompanyForDedup,
  normalizeWebsiteForDedup,
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

/**
 * Пометка «фаза CONSTRUCT уже завершена» для сидов collect_info: тесты
 * PLAN/DISPATCH/HARVEST изолируются от конструктора баз (пункт 4c) — иначе
 * сборки с email у ≤50% строк уходили бы в base_constructor_jobs и рекью.
 */
const CONSTRUCT_DONE = { bc_job_id: 'bc-done', status: 'done' as const };

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

  it('maps directory phones stored as comma-joined text (first phone wins)', () => {
    const mapped = mapDirectoryRow({ name: 'ООО Текст', phones: '+7999000001, +7999000002' });
    expect(mapped.phone).toBe('+7999000001');
    // И массив схлопывается в ту же строку — первый телефон тоже выживает.
    expect(mapDirectoryRow({ name: 'N', phones: ['+7111', '+7222'] }).phone).toBe('+7111');
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

describe('normalizeCompanyForDedup', () => {
  it('treats legal forms, quote styles, case and word order of the form as equal', () => {
    const forms = [
      'ООО «ТЕРАБАЙТ»',
      'ТЕРАБАЙТ',
      'ООО "ТЕРАБАЙТ"',
      'Терабайт ооо',
      '  ооо   "Терабайт" ',
    ];
    for (const f of forms) expect(normalizeCompanyForDedup(f)).toBe('терабайт');
  });

  it('strips other legal forms and collapses punctuation/whitespace', () => {
    expect(normalizeCompanyForDedup('ИП Иванов И.И.')).toBe('иванов и и');
    expect(normalizeCompanyForDedup('АНО "Центр Развития"')).toBe('центр развития');
    expect(normalizeCompanyForDedup('ПАО «Сбербанк»')).toBe('сбербанк');
    expect(normalizeCompanyForDedup('ООО "Ромашка-Сервис"')).toBe('ромашка сервис');
    expect(normalizeCompanyForDedup('')).toBe('');
  });

  it('does not mangle names containing legal-form-looking substrings', () => {
    // «ао» внутри слова — не юрформа.
    expect(normalizeCompanyForDedup('ООО "Аврора"')).toBe('аврора');
  });

  it('strips latin legal forms as whole tokens (llc/ltd/inc/ooo), keeps ip and lookalikes', () => {
    // Латинские имена приходят от hh employers.
    expect(normalizeCompanyForDedup('Terabayt LLC')).toBe('terabayt');
    expect(normalizeCompanyForDedup('ACME Inc.')).toBe('acme');
    expect(normalizeCompanyForDedup('Beta LTD')).toBe('beta');
    expect(normalizeCompanyForDedup('Gamma OOO')).toBe('gamma');
    // Латинское IP НЕ срезаем — слишком коллизионно («IP Solutions»).
    expect(normalizeCompanyForDedup('IP Solutions')).toBe('ip solutions');
    // Только целые токены: «Unlimited» — не «limited»/«ltd».
    expect(normalizeCompanyForDedup('Unlimited Inc')).toBe('unlimited');
    // Сама форма «limited» добавлена EN-набором (пункт 4b EN-пайплайна):
    // «Limited Inc» — две юрформы подряд → пустой ключ (мусор, как «ООО»).
    expect(normalizeCompanyForDedup('Limited Inc')).toBe('');
  });
});

describe('normalizeWebsiteForDedup', () => {
  it('reduces urls to a lowercase host without www or path', () => {
    expect(normalizeWebsiteForDedup('https://www.x.ru/about')).toBe('x.ru');
    expect(normalizeWebsiteForDedup('http://x.ru/')).toBe('x.ru');
    expect(normalizeWebsiteForDedup('X.Ru')).toBe('x.ru');
    expect(normalizeWebsiteForDedup('www.x.ru')).toBe('x.ru');
    expect(normalizeWebsiteForDedup('as.ru')).toBe('as.ru');
    expect(normalizeWebsiteForDedup('')).toBe('');
  });

  it('strips the trailing dot and returns an empty key for junk hosts', () => {
    expect(normalizeWebsiteForDedup('x.ru.')).toBe('x.ru');
    expect(normalizeWebsiteForDedup('https://www.x.ru./about')).toBe('x.ru');
    // «не-сайт» — не домен: без точки с TLD это мусор, а не ключ (раньше
    // уходил в punycode и жил отдельным ключом от пустого сайта).
    expect(normalizeWebsiteForDedup('не-сайт')).toBe('');
    expect(normalizeWebsiteForDedup('localhost')).toBe('');
    expect(normalizeWebsiteForDedup('просто текст')).toBe('');
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

  it('dedups across legal forms / quote styles and keeps the full website in the row', () => {
    const registry = row({ company: 'ООО "ТЕРАБАЙТ"', website: 'terabait.ru', phone: '1' });
    const hh = row({ company: 'ТЕРАБАЙТ', website: 'https://www.terabait.ru/about', phone: '2' });
    const out = dedupUnifiedRows([registry, hh]);
    expect(out).toHaveLength(1);
    expect(out[0].company).toBe('ООО "ТЕРАБАЙТ"');
    // Полный website строки не трогаем — хост нужен только для ключа.
    expect(out[0].website).toBe('terabait.ru');
  });

  it('merges same-company rows when either website is empty — the richer row (website/email) wins', () => {
    // Кросс-базовое исключение матчит только по компании, а within-batch дедуп
    // оставлял «ООО "ТЕРАБАЙТ"» с сайтом и «ТЕРАБАЙТ» без сайта двумя строками.
    const bare = row({ company: 'ТЕРАБАЙТ', phone: '2', vacancy_title: 'Рекрутер' });
    const rich = row({ company: 'ООО "ТЕРАБАЙТ"', website: 'tb.ru', phone: '1' });
    // Бедная строка первой — выживает богатая (с сайтом), на её месте.
    const out = dedupUnifiedRows([bare, rich]);
    expect(out).toHaveLength(1);
    expect(out[0].website).toBe('tb.ru');
    expect(out[0].phone).toBe('1');
    // Богатая первая — она и остаётся.
    expect(dedupUnifiedRows([rich, bare])).toEqual([rich]);
    // Богатая по EMAIL (без сайта) — тоже замена.
    const withEmail = row({ company: 'терабайт', email: 'a@tb.ru' });
    const out2 = dedupUnifiedRows([bare, withEmail]);
    expect(out2).toHaveLength(1);
    expect(out2[0].email).toBe('a@tb.ru');
    // Обе бедные — побеждает первая.
    const bare2 = row({ company: 'Терабайт ООО', vacancy_title: 'Sourcer' });
    expect(dedupUnifiedRows([bare, bare2])).toEqual([bare]);
    // Разные НЕПУСТЫЕ сайты — обе строки живут (дочки/филиалы с разными доменами).
    const otherSite = row({ company: 'ТЕРАБАЙТ', website: 'tb-two.ru' });
    expect(dedupUnifiedRows([rich, otherSite])).toHaveLength(2);
  });

  it('drops garbage rows whose company normalizes to empty («ООО», «—», quotes-only)', () => {
    // Все они схлопывались в один ключ «|» и жили одной мусорной строкой.
    const out = dedupUnifiedRows([
      row({ company: 'ООО', website: 'a.ru' }),
      row({ company: '—', website: 'b.ru' }),
      row({ company: '«»' }),
      row({ company: 'Нормальная', website: 'n.ru' }),
    ]);
    expect(out).toEqual([row({ company: 'Нормальная', website: 'n.ru' })]);
  });
});

describe('interleaveTaskHarvests (fair merge)', () => {
  const sourceRows = (source: string, n: number): HeUnifiedRow[] =>
    Array.from({ length: n }, (_, i) =>
      row({ company: `${source}-${i}`, website: `${source}${i}.ru`, source_detail: source }),
    );

  it('round-robins 3 sources 1500/1500/1500: first 900 rows contain 300 of each, total preserved', () => {
    const registry = sourceRows('реестр', 1500);
    const hh = sourceRows('hh', 1500);
    const maps = sourceRows('карты', 1500);

    const merged = interleaveTaskHarvests([registry, hh, maps]);
    expect(merged).toHaveLength(4500);

    // Первые 900 строк — ровно по 300 «ходов» каждого источника (а не 900 реестра,
    // как давал concat+slice под капом 2000).
    const first900 = merged.slice(0, 900);
    for (const source of ['реестр', 'hh', 'карты']) {
      expect(first900.filter((r) => r.source_detail === source)).toHaveLength(300);
    }
    // Порядок внутри источника сохранён: его строки идут по возрастанию индекса.
    const registryTurns = merged.filter((r) => r.source_detail === 'реестр');
    expect(registryTurns[0].company).toBe('реестр-0');
    expect(registryTurns.at(-1)?.company).toBe('реестр-1499');
  });

  it('skips exhausted lists and keeps per-list order', () => {
    const a = [row({ company: 'a1' }), row({ company: 'a2' }), row({ company: 'a3' })];
    const b: HeUnifiedRow[] = [];
    const c = [row({ company: 'c1' })];
    expect(interleaveTaskHarvests([a, b, c]).map((r) => r.company)).toEqual([
      'a1',
      'c1',
      'a2',
      'a3',
    ]);
  });

  it('dedup after interleave still works: first turn (higher-priority task) wins', () => {
    const first = [row({ company: 'АС', website: 'as.ru', phone: '1' }), row({ company: 'Первая' })];
    const second = [row({ company: 'Вторая' }), row({ company: 'ас', website: 'AS.ru', phone: '2' })];
    const out = dedupUnifiedRows(interleaveTaskHarvests([first, second]));
    // Дубль из второй задачи отброшен, хотя в concat-мёрдже порядок был бы тот же —
    // важно, что строки разных задач в выдаче чередуются.
    expect(out.map((r) => r.company)).toEqual(['АС', 'Вторая', 'Первая']);
    expect(out[0].phone).toBe('1');
  });
});

describe('collector request builders', () => {
  it('maps directory_filters to CompaniesSearchFilters (set fields only, includeIp дефолтит в false)', () => {
    expect(
      mapDirectoryFilters({
        okvedCodes: ['62'],
        regionCodes: ['77'],
        revenueFrom: 1,
        employeesTo: 100,
        hasEmail: true,
        includeIp: true,
      }),
    ).toEqual({
      okvedCodes: ['62'],
      regionCodes: ['77'],
      revenueFrom: 1,
      employeesTo: 100,
      hasEmail: true,
      includeIp: true,
    });
    // B2B-дефолт: includeIp=false даже когда LLM поле не задал (RPC иначе вернёт true).
    expect(mapDirectoryFilters({})).toEqual({ includeIp: false });
    expect(mapDirectoryFilters(undefined)).toEqual({ includeIp: false });
    expect(mapDirectoryFilters({ okvedCodes: [] })).toEqual({ includeIp: false });
    expect(mapDirectoryFilters({ okvedCodes: ['62'] })).toEqual({
      okvedCodes: ['62'],
      includeIp: false,
    });
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

    // google → google_maps_jobs (minDelayMs/maxDelayMs обязательны — иначе delay NaN)
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
          minDelayMs: 1200,
          maxDelayMs: 2800,
        },
      }),
    );

    // Дочерние джобы pending/queued → self-requeue: своя строка → pending,
    // attempts НЕ трогаем (инкремент — только в failJob при фейле), клейм
    // отложен run_after на ~30с вперёд (hot-spin guard).
    const requeue = mockDb.updates.find((u) => u.table === 'he_jobs');
    expect(requeue?.patch).toMatchObject({ status: 'pending', started_at: null });
    expect(requeue?.patch).not.toHaveProperty('attempts');
    const runAfter = Date.parse(String(requeue?.patch.run_after));
    expect(runAfter).toBeGreaterThan(Date.now() + 20_000);
    expect(runAfter).toBeLessThanOrEqual(Date.now() + 40_000);

    // child_job_id и dispatched_at задач персистнуты в collect_info
    const baseUpdates = mockDb.updates.filter((u) => u.table === 'he_bases');
    const lastInfo = baseUpdates.at(-1)?.patch.collect_info as HeCollectInfo;
    expect(lastInfo.tasks?.every((t) => t.status === 'dispatched' && t.child_job_id)).toBe(true);
    expect(lastInfo.tasks?.every((t) => typeof t.dispatched_at === 'string')).toBe(true);
    expect(Date.parse(lastInfo.tasks![0].dispatched_at!)).toBeLessThanOrEqual(Date.now());
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
          // dispatched_at нарочно не задан (collect_info до появления штампа):
          // без него таймаута нет — поведение как раньше.
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
    expect(Date.parse(String(requeue?.patch.run_after))).toBeGreaterThan(Date.now());
    // Ни база не тронута статусом, ни base_analyze не поставлен.
    expect(mockDb.updates.filter((u) => u.table === 'he_bases').every((u) => !('status' in u.patch))).toBe(true);
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();
  });

  it('fails a task whose child job is stuck over 3h and harvests the rest', async () => {
    const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'hh_live',
          status: 'dispatched',
          child_job_id: 'pj1',
          rows: 0,
          dispatched_at: fourHoursAgo,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
        },
        {
          source: 'yandex_maps',
          status: 'dispatched',
          child_job_id: 'ym1',
          rows: 0,
          dispatched_at: new Date().toISOString(),
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
        // Зависшая джоба — до неё дело даже не доходит: таймаут раньше опроса.
        parser_jobs: [{ id: 'pj1', status: 'running' }],
        yandex_maps_jobs: [{ id: 'ym1', status: 'completed', error_message: null }],
        yandex_maps_organizations: [
          { job_id: 'ym1', name: 'Стоматология Улыбка', website: 'smile.ru', email: null, phone: '1', address: 'Казань', categories: 'Стоматология' },
        ],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    const result = res.result as { rows: number; tasks_done: number; tasks_failed: number; failed_sources: string[] };
    expect(result.rows).toBe(1);
    expect(result.tasks_done).toBe(1);
    expect(result.tasks_failed).toBe(1);
    expect(result.failed_sources).toEqual(['hh_live']);

    // Таймаут зафиксирован в collect_info, harvest прошёл по остальным задачам.
    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.status).toBe('analyzing');
    const savedInfo = harvest?.collect_info as HeCollectInfo;
    const stuck = savedInfo.tasks?.find((t) => t.source === 'hh_live');
    expect(stuck?.status).toBe('failed');
    expect(stuck?.error).toBe('timeout: дочерняя джоба зависла');
    // Никакого self-requeue — зависшая задача больше не держит сборку.
    expect(mockDb.updates.find((u) => u.table === 'he_jobs')).toBeUndefined();
  });
});

/* ─────────────────────────── HARVEST ─────────────────────────── */

describe('harvest', () => {
  it('merges completed child rows into he_bases and enqueues base_analyze', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
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
          // компания-мусор (нормализуется в пустой ключ) — отбрасывается
          { job_id: 'pj1', name: 'Ops', company_name: 'ООО', company_site_url: 'ooo.ru', area: '' },
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

  it('interleaves done task harvests round-robin (first source no longer eats the cap)', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'companies_directory',
          status: 'done',
          child_job_id: null,
          rows: 3,
          task: { source: 'companies_directory', rationale: 'r', directory_filters: {} },
          harvest: [
            row({ company: 'Реестр-1', website: 'r1.ru' }),
            row({ company: 'Реестр-2', website: 'r2.ru' }),
            row({ company: 'Реестр-3', website: 'r3.ru' }),
          ],
        },
        {
          source: 'hh_live',
          status: 'done',
          child_job_id: 'pj1',
          rows: 2,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
          harvest: [
            row({ company: 'HH-1', website: 'h1.ru' }),
            row({ company: 'HH-2', website: 'h2.ru' }),
          ],
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
    expect((res.result as { rows: number }).rows).toBe(5);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const data = harvest?.data as HeUnifiedRow[];
    // Round-robin: реестр/hh по кругу, исчерпанный hh-список пропускается.
    expect(data.map((r) => r.company)).toEqual(['Реестр-1', 'HH-1', 'Реестр-2', 'HH-2', 'Реестр-3']);
  });

  it('caps the merged base at 10000 rows, balanced across sources', async () => {
    const big = (prefix: string, n: number): HeUnifiedRow[] =>
      Array.from({ length: n }, (_, i) => row({ company: `${prefix}-${i}`, website: `${prefix}${i}.ru` }));
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'companies_directory',
          status: 'done',
          child_job_id: null,
          rows: 5000,
          task: { source: 'companies_directory', rationale: 'r', directory_filters: {} },
          harvest: big('реестр', 5000),
        },
        {
          source: 'hh_live',
          status: 'done',
          child_job_id: 'pj1',
          rows: 5000,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
          harvest: big('hh', 5000),
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
    expect((res.result as { rows: number }).rows).toBe(10000);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.row_count).toBe(10000);
    const data = harvest?.data as HeUnifiedRow[];
    // Кап делит поровну: 5000 «ходов» каждого источника (2 × 5000 → 10000).
    expect(data.filter((r) => r.company.startsWith('реестр-'))).toHaveLength(5000);
    expect(data.filter((r) => r.company.startsWith('hh-'))).toHaveLength(5000);
    expect((harvest?.collect_info as HeCollectInfo).stats?.rows_total).toBe(10000);
  });

  it('caps the merged base at the payload limit (2 × 3000 with limit 4000 → 4000 interleaved)', async () => {
    const big = (prefix: string, n: number): HeUnifiedRow[] =>
      Array.from({ length: n }, (_, i) => row({ company: `${prefix}-${i}`, website: `${prefix}${i}.ru` }));
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'companies_directory',
          status: 'done',
          child_job_id: null,
          rows: 3000,
          task: { source: 'companies_directory', rationale: 'r', directory_filters: {} },
          harvest: big('реестр', 3000),
        },
        {
          source: 'hh_live',
          status: 'done',
          child_job_id: 'pj1',
          rows: 3000,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
          harvest: big('hh', 3000),
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

    const res = await runBaseCollectStage(
      makeJob({ payload: { base_id: 'b1', limit: 4000 } }),
      ctx(),
    );
    expect((res.result as { rows: number }).rows).toBe(4000);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.row_count).toBe(4000);
    const data = harvest?.data as HeUnifiedRow[];
    // Кап из payload делится round-robin'ом: по 2000 «ходов» каждого источника.
    expect(data.filter((r) => r.company.startsWith('реестр-'))).toHaveLength(2000);
    expect(data.filter((r) => r.company.startsWith('hh-'))).toHaveLength(2000);
    expect((harvest?.collect_info as HeCollectInfo).stats?.rows_total).toBe(4000);
  });

  it('clamps a payload limit outside [100, 50000]', async () => {
    const big = (prefix: string, n: number): HeUnifiedRow[] =>
      Array.from({ length: n }, (_, i) => row({ company: `${prefix}-${i}`, website: `${prefix}${i}.ru` }));
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'companies_directory',
          status: 'done',
          child_job_id: null,
          rows: 500,
          task: { source: 'companies_directory', rationale: 'r', directory_filters: {} },
          harvest: big('реестр', 500),
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

    // limit 10 < MIN_ROWS_LIMIT → кламп до 100, хотя строк хватило бы на 500.
    const res = await runBaseCollectStage(
      makeJob({ payload: { base_id: 'b1', limit: 10 } }),
      ctx(),
    );
    expect((res.result as { rows: number }).rows).toBe(100);
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

    expect(searchRowsMock).toHaveBeenCalledWith(
      { okvedCodes: ['62'], hasEmail: true, includeIp: false },
      1000,
      0,
    );
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

  it('paginates the directory in 1000-row pages until a short page', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'companies_directory',
          status: 'pending',
          child_job_id: null,
          rows: 0,
          task: { source: 'companies_directory', rationale: 'r', directory_filters: { okvedCodes: ['62'] } },
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
    const page = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${i}`, website: `${prefix}${i}.ru` }));
    // 3 страницы: 1000 + 1000 + короткая 600 → стоп, 4-го запроса нет.
    searchRowsMock
      .mockResolvedValueOnce({ rows: page('a', 1000) })
      .mockResolvedValueOnce({ rows: page('b', 1000) })
      .mockResolvedValueOnce({ rows: page('c', 600) });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(2600);

    const filters = { okvedCodes: ['62'], includeIp: false };
    expect(searchRowsMock).toHaveBeenCalledTimes(3);
    expect(searchRowsMock).toHaveBeenNthCalledWith(1, filters, 1000, 0);
    expect(searchRowsMock).toHaveBeenNthCalledWith(2, filters, 1000, 1000);
    expect(searchRowsMock).toHaveBeenNthCalledWith(3, filters, 1000, 2000);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.row_count).toBe(2600);
  });

  it('stops directory pagination at the default 10000 limit on full pages', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
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
    // Каждая страница полная → ровно 10 запросов, кап — дефолтный лимит 10000.
    // Имена уникальны между страницами, иначе их съест дедуп.
    let call = 0;
    searchRowsMock.mockImplementation(async () => {
      call += 1;
      return { rows: Array.from({ length: 1000 }, (_, i) => ({ name: `p${call}-${i}` })) };
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(10000);
    expect(searchRowsMock).toHaveBeenCalledTimes(10);
  });

  it('excludes companies already present in other bases of the project', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'companies_directory',
          status: 'done',
          child_job_id: null,
          rows: 3,
          task: { source: 'companies_directory', rationale: 'r', directory_filters: {} },
          harvest: [
            row({ company: 'ООО "ТЕРАБАЙТ"', website: 'tb.ru' }),
            row({ company: 'ИП Сидоров', website: 'sidorov.ru' }),
            row({ company: 'Новая Компания', website: 'new.ru' }),
          ],
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [
          makeBase(info),
          // Другая авто-база того же проекта: совпадение по нормализованной
          // компании («ТЕРАБАЙТ» без юрформы), несмотря на ДРУГОЙ website.
          {
            id: 'b2',
            project_id: 'p1',
            vertical_id: 'v1',
            status: 'analyzed',
            source: 'auto',
            data: [{ company: 'ТЕРАБАЙТ', website: 'other-tb.ru' }, { company: 'ип сидоров' }],
          },
          // Ручная база тоже считается (source любой), но failed — игнорируется.
          {
            id: 'b3',
            project_id: 'p1',
            vertical_id: 'v1',
            status: 'failed',
            source: 'upload',
            data: [{ company: 'Новая Компания' }],
          },
          // Чужой проект — не участвует.
          {
            id: 'b4',
            project_id: 'p2',
            vertical_id: 'v9',
            status: 'analyzed',
            source: 'auto',
            data: [{ company: 'Новая Компания' }],
          },
        ],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const data = harvest?.data as HeUnifiedRow[];
    expect(data.map((r) => r.company)).toEqual(['Новая Компания']);
    expect((harvest?.collect_info as HeCollectInfo).stats).toMatchObject({
      rows_total: 1,
      excluded_existing_bases: 2,
    });
  });

  it('failed task does not fail the job when another task produced rows', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
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

/* ─────────────────── Continuation: исключение на выборке реестра ─────────────────── */

describe('continuation: other-base exclusion during directory fetch', () => {
  const directoryInfo = (): HeCollectInfo => ({
    plan: { tasks: [] },
    construct: CONSTRUCT_DONE,
    tasks: [
      {
        source: 'companies_directory',
        status: 'pending',
        child_job_id: null,
        rows: 0,
        task: { source: 'companies_directory', rationale: 'r', directory_filters: { okvedCodes: ['62'] } },
      },
    ],
  });

  const otherBase = (data: Array<Record<string, unknown>>): Record<string, unknown> => ({
    id: 'b2',
    project_id: 'p1',
    vertical_id: 'v1',
    status: 'analyzed',
    source: 'auto',
    data,
  });

  it('skips rows known from other bases while paging and keeps paging until new rows (pages 1-2 known, page 3 new)', async () => {
    const page = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${i}`, website: `${prefix}${i}.ru` }));
    mockDb = createMockSupabase({
      tables: {
        he_bases: [
          makeBase(directoryInfo()),
          // Первая сборка того же сегмента: страницы a-* и b-* реестра уже в ней.
          otherBase([...page('a', 1000), ...page('b', 1000)].map((r) => ({ company: r.name, website: r.website }))),
        ],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });
    searchRowsMock
      .mockResolvedValueOnce({ rows: page('a', 1000) }) // все известны — в limit не считаются
      .mockResolvedValueOnce({ rows: page('b', 1000) }) // все известны
      .mockResolvedValueOnce({ rows: page('c', 600) }); // новые, короткая страница → стоп

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(600);

    // offset двигается по ПРОСКАНИРОВАННЫМ строкам, а не по оставленным.
    const filters = { okvedCodes: ['62'], includeIp: false };
    expect(searchRowsMock).toHaveBeenCalledTimes(3);
    expect(searchRowsMock).toHaveBeenNthCalledWith(1, filters, 1000, 0);
    expect(searchRowsMock).toHaveBeenNthCalledWith(2, filters, 1000, 1000);
    expect(searchRowsMock).toHaveBeenNthCalledWith(3, filters, 1000, 2000);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const data = harvest?.data as HeUnifiedRow[];
    expect(data).toHaveLength(600);
    expect(data.every((r) => r.company.startsWith('c-'))).toBe(true);

    // Исключение сработало на выборке — мёрджу отсекать нечего.
    const info = harvest?.collect_info as HeCollectInfo;
    expect(info.stats).toMatchObject({
      rows_total: 600,
      excluded_during_fetch: 2000,
      excluded_existing_bases: 0,
    });
    // Выдача кончилась раньше limit — задача помечена исчерпанной.
    expect(info.tasks?.[0]).toMatchObject({
      status: 'done',
      rows: 600,
      exhausted: true,
      note: 'реестр исчерпан',
      excluded_during_fetch: 2000,
    });
  });

  it('excludes companies beyond the first 10k rows of another base (collect limit can be 50k)', async () => {
    // 12k компаний в чужой базе; реестр отдаёт строки 10500–11499 — за старым
    // капом чтения 10k. Они обязаны попасть в исключения на выборке, иначе
    // вторая сборка собирает хвост первой базы заново как «новые» компании.
    const known = Array.from({ length: 12_000 }, (_, i) => `c-${i}`);
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(directoryInfo()), otherBase(known.map((company) => ({ company })))],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });
    searchRowsMock
      .mockResolvedValueOnce({ rows: known.slice(10_500, 11_500).map((name) => ({ name })) }) // все известны
      .mockResolvedValueOnce({ rows: [{ name: 'Новая-1' }, { name: 'Новая-2' }] }); // короткая страница новых

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(2);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    const data = harvest?.data as HeUnifiedRow[];
    expect(data.map((r) => r.company)).toEqual(['Новая-1', 'Новая-2']);
    const info = harvest?.collect_info as HeCollectInfo;
    expect(info.stats).toMatchObject({ excluded_during_fetch: 1000, excluded_existing_bases: 0 });
  });

  it('stops at the 200-page ceiling (200k scanned) and reports it as a ceiling, NOT segment exhaustion', async () => {
    const knownPage = Array.from({ length: 1000 }, (_, i) => ({ name: `old-${i}` }));
    mockDb = createMockSupabase({
      tables: {
        he_bases: [
          makeBase(directoryInfo()),
          otherBase(knownPage.map((r) => ({ company: r.name }))),
        ],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });
    // Полные страницы известных компаний бесконечно — останавливает только потолок.
    searchRowsMock.mockResolvedValue({ rows: knownPage });

    // Потолок — не исчерпание: общий нулевой фейл, а не «Сегмент исчерпан».
    await expect(runBaseCollectStage(makeJob(), ctx())).rejects.toThrow(/не дала строк/);
    expect(searchRowsMock).toHaveBeenCalledTimes(200);
    // Последняя страница уходит по offset 199k — потолок по просканированным строкам.
    expect(searchRowsMock).toHaveBeenLastCalledWith({ okvedCodes: ['62'], includeIp: false }, 1000, 199_000);

    const fail = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(fail?.status).toBe('failed');
    expect(String(fail?.error)).toContain('не дала строк');
    expect(String(fail?.error)).not.toMatch(/сегмент исчерпан/i);
    const info = fail?.collect_info as HeCollectInfo;
    expect(info.stats?.excluded_during_fetch).toBe(200_000);
    // Задача помечена note про предел сканирования и НЕ считается exhausted —
    // повторная сборка продолжит сегмент с места останова.
    expect(info.tasks?.[0]).toMatchObject({
      status: 'done',
      rows: 0,
      hit_ceiling: true,
      note: 'достигнут предел сканирования 200k — запустите сборку ещё раз',
    });
    expect(info.tasks?.[0].exhausted).toBeUndefined();
  });

  it('marks the directory task as exhausted («реестр исчерпан») when the registry ends before the limit', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase(directoryInfo())],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });
    searchRowsMock.mockResolvedValue({ rows: [{ name: 'Одна', website: 'one.ru' }] });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(harvest?.status).toBe('analyzing');
    const info = harvest?.collect_info as HeCollectInfo;
    expect(info.tasks?.[0]).toMatchObject({ exhausted: true, note: 'реестр исчерпан' });
    expect(info.stats?.excluded_during_fetch).toBe(0);
  });

  it('fails with «Сегмент исчерпан» when a continuation yields zero new rows (all scanned rows known)', async () => {
    const known = [{ name: 'Старая-1' }, { name: 'Старая-2' }];
    mockDb = createMockSupabase({
      tables: {
        he_bases: [
          makeBase(directoryInfo()),
          otherBase(known.map((r) => ({ company: r.name }))),
        ],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });
    // Короткая страница, все строки уже в другой базе → 0 новых, реестр исчерпан.
    searchRowsMock.mockResolvedValue({ rows: known });

    await expect(runBaseCollectStage(makeJob(), ctx())).rejects.toThrow(/сегмент исчерпан/i);

    const fail = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(fail?.status).toBe('failed');
    expect(String(fail?.error)).toContain('Сегмент исчерпан: новых компаний нет');
    expect(String(fail?.error)).not.toContain('не дала строк');
    const info = fail?.collect_info as HeCollectInfo;
    expect(info.stats?.excluded_during_fetch).toBe(2);
    expect(info.tasks?.[0]).toMatchObject({ exhausted: true, note: 'реестр исчерпан' });
    // base_analyze не ставится.
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();
  });

  it('failed hh task + exhausted registry → failure breakdown, NOT «Сегмент исчерпан»', async () => {
    // Реестр исчерпан (все строки выдачи уже в другой базе), но hh-задача
    // упала — «исчерпан» маскировал бы настоящий фейл: показываем разбор.
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      tasks: [
        ...directoryInfo().tasks!,
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
        he_bases: [makeBase(info), otherBase([{ company: 'Старая' }])],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        parser_jobs: [{ id: 'pj1', status: 'failed', error_message: 'captcha' }],
      },
    });
    // Короткая страница, единственная строка уже в другой базе → реестр исчерпан, 0 новых.
    searchRowsMock.mockResolvedValue({ rows: [{ name: 'Старая' }] });

    await expect(runBaseCollectStage(makeJob(), ctx())).rejects.toThrow(/не дала строк/);

    const fail = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect(fail?.status).toBe('failed');
    expect(String(fail?.error)).toContain('не дала строк');
    expect(String(fail?.error)).toContain('hh_live — captcha');
    expect(String(fail?.error)).not.toMatch(/сегмент исчерпан/i);
    const saved = fail?.collect_info as HeCollectInfo;
    // Реестр при этом честно помечен исчерпанным — но итог сборки не «исчерпан».
    expect(saved.tasks?.find((t) => t.source === 'companies_directory')).toMatchObject({
      exhausted: true,
      note: 'реестр исчерпан',
    });
  });

  it('still excludes hh/maps rows at merge time (fetch-time exclusion covers only the registry)', async () => {
    const info: HeCollectInfo = {
      plan: { tasks: [] },
      construct: CONSTRUCT_DONE,
      tasks: [
        {
          source: 'hh_live',
          status: 'done',
          child_job_id: 'pj1',
          rows: 2,
          task: { source: 'hh_live', rationale: 'r', hh_query: { text: 'рекрутер' } },
          harvest: [
            row({ company: 'Уже Собранная', website: 'old.ru' }),
            row({ company: 'Свежая', website: 'fresh.ru' }),
          ],
        },
      ],
    };
    mockDb = createMockSupabase({
      tables: {
        he_bases: [
          makeBase(info),
          otherBase([{ company: 'Уже собранная' }]),
        ],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
      },
    });

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);

    const harvest = mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
    expect((harvest?.data as HeUnifiedRow[]).map((r) => r.company)).toEqual(['Свежая']);
    // Страховка на мёрдже жива: строка hh отсеяна именно там, не на выборке.
    expect((harvest?.collect_info as HeCollectInfo).stats).toMatchObject({
      excluded_existing_bases: 1,
      excluded_during_fetch: 0,
    });
  });
});

/* ─────────────────────────── PLAN ─────────────────────────── */

describe('plan phase', () => {
  it('builds the source plan via LLM from non-rejected hypotheses and vocab, then persists it', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
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

  it('plans only over the hypothesis_ids subset from the job payload', async () => {
    mockDb = createMockSupabase({
      tables: {
        he_bases: [makeBase({ construct: CONSTRUCT_DONE })],
        he_verticals: [VERTICAL],
        he_projects: [PROJECT],
        he_jobs: [makeJob() as unknown as Record<string, unknown>],
        he_hypotheses: [
          { id: 'h-acc', project_id: 'p1', vertical_id: 'v1', title: 'Невыбранная принятая', description: null, tier: 1, status: 'accepted', potential_pct: 90 },
          { id: 'h-prop', project_id: 'p1', vertical_id: 'v1', title: 'Выбранная гипотеза', description: 'd', tier: 2, status: 'proposed', potential_pct: 60 },
          { id: 'h-rej', project_id: 'p1', vertical_id: 'v1', title: 'Отклонённая выбранная', description: null, tier: 3, status: 'rejected', potential_pct: 10 },
        ],
      },
    });
    callLLMMock.mockResolvedValue({
      data: {
        tasks: [
          { source: 'companies_directory', rationale: 'r', directory_filters: { okvedCodes: ['78'] } },
        ],
      },
      tokensUsed: 10,
      promptTokens: 8,
      completionTokens: 2,
      costUsd: 0.0001,
      rawResponse: {},
    });
    searchRowsMock.mockResolvedValue({ rows: [{ name: 'ООО Кадры', website: 'kadry.ru' }] });

    const res = await runBaseCollectStage(
      makeJob({ payload: { base_id: 'b1', hypothesis_ids: ['h-prop', 'h-rej'] } }),
      ctx(),
    );
    expect((res.result as { rows: number }).rows).toBe(1);

    // В промпт попала ТОЛЬКО выбранная неотклонённая гипотеза: ни невыбранной,
    // ни отклонённой — даже отмеченной (пересечение с неотклонёнными).
    expect(callLLMMock).toHaveBeenCalledTimes(1);
    const [messages] = callLLMMock.mock.calls[0] as [Array<{ role: string; content: string }>];
    const user = messages.find((m) => m.role === 'user')!.content;
    expect(user).toContain('Выбранная гипотеза');
    expect(user).not.toContain('Невыбранная принятая');
    expect(user).not.toContain('Отклонённая выбранная');
  });

  it.each([{ ids: ['h-rej'] }, { ids: ['unknown-id'] }])(
    'fails the job with a clear error when hypothesis_ids intersect nothing non-rejected ($ids)',
    async ({ ids }) => {
      mockDb = createMockSupabase({
        tables: {
          he_bases: [makeBase(null)],
          he_verticals: [VERTICAL],
          he_projects: [PROJECT],
          he_jobs: [makeJob() as unknown as Record<string, unknown>],
          he_hypotheses: [
            { id: 'h-acc', project_id: 'p1', vertical_id: 'v1', title: 'Принятая', description: null, tier: 1, status: 'accepted', potential_pct: 90 },
            { id: 'h-rej', project_id: 'p1', vertical_id: 'v1', title: 'Отклонённая', description: null, tier: 3, status: 'rejected', potential_pct: 10 },
          ],
        },
      });

      await expect(
        runBaseCollectStage(makeJob({ payload: { base_id: 'b1', hypothesis_ids: ids } }), ctx()),
      ).rejects.toThrow(/выбранные гипотезы не найдены или все отклонены/i);
      // До LLM дело не доходит.
      expect(callLLMMock).not.toHaveBeenCalled();
    },
  );
});
