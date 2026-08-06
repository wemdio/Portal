/** @jest-environment node */

/**
 * Фаза CONSTRUCT стадии base_collect (пункт 4c EN-пайплайна): передача
 * собранной базы конструктору баз (base_constructor_jobs — поиск/валидация
 * почт, описания) и импорт результата обратно в he_bases.
 *
 *   gate        — email у >50% строк → CONSTRUCT пропускается (RU-источники);
 *                 construct.status='done' в collect_info → фаза завершена ранее;
 *   DISPATCH    — создаётся base_constructor_jobs (locale по рынку, шаги
 *                 dedup/find/validate/cap/enrich, data-матрица с каноническими
 *                 заголовками RU/EN), bc_job_id — в collect_info.construct,
 *                 self-requeue с паузой ~60с;
 *   WAIT        — BC-джоба processing → рекью; >6ч → база failed + джоба падает;
 *   IMPORT      — completed: строки BC-джобы мапятся обратно в унифицированные
 *                 колонки по имени заголовка, email ← первый адрес merged-ячейки,
 *                 колонка description добавляется В КОНЕЦ заголовков;
 *                 failed/cancelled: импорт частичного data, если он есть, иначе
 *                 analyzing без обогащения — база НЕ падает;
 *   launch      — детект email-колонки находит 'Email' и 'Found Email'.
 */

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
}));

jest.mock('@/lib/hypothesisEngine/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getHeModel: jest.fn(() => 'test-bulk-model'),
}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import { findEmailColumn } from '@/lib/hypothesisEngine/launchHandoff';
import type { HeMarket } from '@/lib/hypothesisEngine/market';
import {
  HE_AUTO_COLLECT_COLUMNS,
  runBaseCollectStage,
  type HeCollectInfo,
  type HeUnifiedRow,
} from '@/lib/hypothesisEngine/stages/baseCollect';
import type { HeJob } from '@/lib/hypothesisEngine/types';

let mockDb: MockSupabaseClient = createMockSupabase();

const PROJECT_US = { id: 'p1', name: 'P', created_by: 'user-1', market: 'us' };
const PROJECT_RU = { id: 'p1', name: 'P', created_by: 'user-1' };
const VERTICAL = {
  id: 'v1',
  project_id: 'p1',
  name: 'Staffing agencies',
  summary: 'Recruitment and staffing',
  synonyms: [],
  potential_pct: 50,
  rank: 1,
};

const EN_HEADERS = ['Company', 'Site', 'Email', 'Phone', 'Vacancy', 'Address', 'Category', 'Employees', 'Revenue', 'INN', 'Source'];
const RU_HEADERS = ['Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория', 'Сотрудники', 'Выручка', 'ИНН', 'Источник'];
const CONSTRUCT_STEPS = ['dedup_email', 'find_emails', 'validate_emails', 'cap_emails_per_company', 'enrich_descriptions'];

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
    started_at: '2026-08-04T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-04T00:00:00Z',
    updated_at: '2026-08-04T00:00:00Z',
    ...overrides,
  };
}

function ctx(market?: HeMarket) {
  return { supabase: mockDb as unknown as SupabaseClient, ...(market ? { market } : {}) };
}

function row(partial: Partial<HeUnifiedRow>): HeUnifiedRow {
  const full = {} as HeUnifiedRow;
  for (const col of HE_AUTO_COLLECT_COLUMNS) full[col] = partial[col] ?? '';
  return full;
}

/** Унифицированная строка + колонка description (после импорта из конструктора). */
function enrichedRow(partial: Partial<HeUnifiedRow> & { description?: string }): HeUnifiedRow & { description: string } {
  const { description, ...rest } = partial;
  return { ...row(rest), description: description ?? '' };
}

/** collect_info с завершёнными задачами: harvest сразу даёт merged-строки. */
function doneInfo(harvest: HeUnifiedRow[], construct?: HeCollectInfo['construct']): HeCollectInfo {
  return {
    plan: { tasks: [] },
    tasks: [
      {
        source: 'pdl',
        status: 'done',
        child_job_id: null,
        rows: harvest.length,
        task: { source: 'pdl', rationale: 'r', pdl_filters: { industries: ['software'] } },
        harvest,
      },
    ],
    ...(construct ? { construct } : {}),
  };
}

const HARVEST_ROWS = [
  row({ company: 'Acme Inc', website: 'acme.com', vacancy_title: 'Account Executive', category: 'software', employees: '51-200', address: 'austin, tx, united states', source_detail: 'pdl' }),
  row({ company: 'Globex', website: 'globex.com', category: 'staffing and recruiting', source_detail: 'pdl' }),
];

function seedTables(info: HeCollectInfo, project: Record<string, unknown>, extraTables: Record<string, Array<Record<string, unknown>>> = {}) {
  mockDb = createMockSupabase({
    tables: {
      he_bases: [makeBase(info)],
      he_verticals: [VERTICAL],
      he_projects: [project],
      he_jobs: [makeJob() as unknown as Record<string, unknown>],
      ...extraTables,
    },
  });
}

/** Последний patch he_bases. */
function lastBasePatch() {
  return mockDb.updates.filter((u) => u.table === 'he_bases').at(-1)?.patch;
}

beforeEach(() => {
  jest.clearAllMocks();
});

/* ─────────────────────────── Gate ─────────────────────────── */

describe('construct gate', () => {
  it('email у >50% строк → CONSTRUCT всё равно идёт (валидация!), но БЕЗ find_emails', async () => {
    const info = doneInfo([
      row({ company: 'ООО Код', website: 'code.ru', email: 'hi@code.ru', source_detail: 'реестр' }),
      row({ company: 'ООО Два', website: 'two.ru', email: 'a@two.ru', source_detail: 'реестр' }),
      row({ company: 'ООО Три', website: 'three.ru', source_detail: 'hh: рекрутер' }),
    ]);
    seedTables(info, PROJECT_RU);

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { waiting: boolean }).waiting).toBe(true);

    // Конструктор вызван, но без поиска почт: dedup → validate → cap → описания.
    const bcInsert = mockDb.inserts.find((i) => i.table === 'base_constructor_jobs');
    expect(bcInsert).toBeDefined();
    expect(bcInsert?.rows[0].selected_steps).toEqual([
      'dedup_email',
      'validate_emails',
      'cap_emails_per_company',
      'enrich_descriptions',
    ]);
    // base_analyze ещё не ставится — ждём конструктор.
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();
  });

  it('ровно 50% строк с email → CONSTRUCT выполняется (граница — «больше 50%»)', async () => {
    const info = doneInfo([
      row({ company: 'Acme', website: 'acme.com', email: 'a@acme.com' }),
      row({ company: 'Globex', website: 'globex.com' }),
    ]);
    seedTables(info, PROJECT_RU);

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { waiting: boolean }).waiting).toBe(true);
    expect(mockDb.inserts.find((i) => i.table === 'base_constructor_jobs')).toBeDefined();
  });

  it("construct.status='done' в collect_info → фаза завершена ранее, база сразу analyzing", async () => {
    const info = doneInfo(HARVEST_ROWS, { bc_job_id: 'bc-old', status: 'done', emails_found: 2, valid_count: 1 });
    seedTables(info, PROJECT_US);

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(2);
    expect(mockDb.inserts.find((i) => i.table === 'base_constructor_jobs')).toBeUndefined();
    expect(lastBasePatch()?.status).toBe('analyzing');
  });
});

/* ─────────────────────────── DISPATCH-CONSTRUCT ─────────────────────────── */

describe('dispatch construct', () => {
  it("market='us' → BC-джоба с locale='en', EN-заголовками и шагами конструктора", async () => {
    seedTables(doneInfo(HARVEST_ROWS), PROJECT_US);

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    const result = res.result as { waiting: boolean; construct?: string };
    expect(result.waiting).toBe(true);
    expect(result.construct).toBe('dispatched');

    const bcInsert = mockDb.inserts.find((i) => i.table === 'base_constructor_jobs');
    expect(bcInsert?.rows[0]).toEqual(
      expect.objectContaining({
        user_id: 'user-1',
        file_name: 'HE · auto: Staffing agencies',
        status: 'pending',
        locale: 'en',
        selected_steps: CONSTRUCT_STEPS,
        step_config: { cap_emails_per_company: { max: 5 } },
        initial_row_count: 2,
        total_steps: CONSTRUCT_STEPS.length,
      }),
    );
    expect(bcInsert?.rows[0].data).toEqual([
      EN_HEADERS,
      ['Acme Inc', 'acme.com', '', '', 'Account Executive', 'austin, tx, united states', 'software', '51-200', '', '', 'pdl'],
      ['Globex', 'globex.com', '', '', '', '', 'staffing and recruiting', '', '', '', 'pdl'],
    ]);

    // bc_job_id персистнут в collect_info.construct, base_analyze ещё не ставится.
    const info = lastBasePatch()?.collect_info as HeCollectInfo;
    expect(info.construct).toMatchObject({ status: 'dispatched' });
    expect(typeof info.construct?.bc_job_id).toBe('string');
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();

    // Self-requeue с паузой ~60с (не 30с дочерних парсеров).
    const requeue = mockDb.updates.find((u) => u.table === 'he_jobs');
    expect(requeue?.patch).toMatchObject({ status: 'pending', started_at: null });
    const runAfter = Date.parse(String(requeue?.patch.run_after));
    expect(runAfter).toBeGreaterThan(Date.now() + 50_000);
    expect(runAfter).toBeLessThanOrEqual(Date.now() + 70_000);
  });

  it("market='ru' → BC-джоба с locale='ru' и кириллическими заголовками", async () => {
    const info = doneInfo([
      row({ company: 'ООО Код', website: 'code.ru', source_detail: 'реестр' }),
      row({ company: 'ИП Сидоров', website: 'sidorov.ru', source_detail: 'hh: рекрутер' }),
    ]);
    seedTables(info, PROJECT_RU);

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { waiting: boolean }).waiting).toBe(true);

    const bcInsert = mockDb.inserts.find((i) => i.table === 'base_constructor_jobs');
    expect(bcInsert?.rows[0]).toEqual(expect.objectContaining({ locale: 'ru', status: 'pending' }));
    expect((bcInsert?.rows[0].data as string[][])[0]).toEqual(RU_HEADERS);
    expect((bcInsert?.rows[0].data as string[][])[1]).toEqual([
      'ООО Код', 'code.ru', '', '', '', '', '', '', '', '', 'реестр',
    ]);
  });
});

/* ─────────────────────────── WAIT-CONSTRUCT ─────────────────────────── */

describe('wait construct', () => {
  const dispatched = () => ({ bc_job_id: 'bc1', status: 'dispatched' as const, dispatched_at: new Date().toISOString() });

  it('BC-джоба processing → self-requeue ~60с, база не трогается', async () => {
    seedTables(doneInfo(HARVEST_ROWS, dispatched()), PROJECT_US, {
      base_constructor_jobs: [{ id: 'bc1', status: 'processing', error_message: null }],
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    const result = res.result as { waiting: boolean; construct?: string };
    expect(result.waiting).toBe(true);
    expect(result.construct).toBe('processing');

    const requeue = mockDb.updates.find((u) => u.table === 'he_jobs');
    expect(requeue?.patch.status).toBe('pending');
    expect(Date.parse(String(requeue?.patch.run_after))).toBeGreaterThan(Date.now() + 50_000);
    // Ни analyzing, ни base_analyze.
    expect(mockDb.updates.filter((u) => u.table === 'he_bases').every((u) => !('status' in u.patch))).toBe(true);
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();
  });

  it('BC-джоба висит >6ч → база failed с разбором, джоба падает', async () => {
    const sevenHoursAgo = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    seedTables(
      doneInfo(HARVEST_ROWS, { bc_job_id: 'bc1', status: 'dispatched', dispatched_at: sevenHoursAgo }),
      PROJECT_US,
      { base_constructor_jobs: [{ id: 'bc1', status: 'processing', error_message: null }] },
    );

    await expect(runBaseCollectStage(makeJob(), ctx('us'))).rejects.toThrow(/конструктор/i);

    const patch = lastBasePatch();
    expect(patch?.status).toBe('failed');
    expect(String(patch?.error)).toContain('6ч');
    expect(String(patch?.error)).toContain('bc1');
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeUndefined();
  });
});

/* ─────────────────────────── IMPORT ─────────────────────────── */

describe('import construct result', () => {
  const dispatched = () => ({ bc_job_id: 'bc1', status: 'dispatched' as const, dispatched_at: new Date().toISOString() });

  it('completed → строки мапятся по имени заголовка, email ← первый адрес, description добавляется в конец', async () => {
    seedTables(doneInfo(HARVEST_ROWS, dispatched()), PROJECT_US, {
      base_constructor_jobs: [
        {
          id: 'bc1',
          status: 'completed',
          error_message: null,
          data: [
            [...EN_HEADERS, 'Description', 'Email Статус'],
            ['Acme Inc', 'acme.com', 'found@acme.com', '', 'Account Executive', 'austin, tx, united states', 'software', '51-200', '', '', 'pdl', 'Acme builds staffing software', 'ok'],
            ['Globex', 'globex.com', 'orig@globex.com, found@globex.com', '', '', '', 'staffing and recruiting', '', '', '', 'pdl', 'Globex recruits', 'invalid'],
          ],
          result_stats: { total_rows: 2, emails_found: 2, avg_ta_score: 0, columns: 13 },
        },
      ],
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(2);

    const patch = lastBasePatch();
    expect(patch?.status).toBe('analyzing');
    // description — В КОНЦЕ массива существующих заголовков.
    expect(patch?.columns).toEqual([...HE_AUTO_COLLECT_COLUMNS, 'description']);
    expect(patch?.data).toEqual([
      {
        ...enrichedRow({
          company: 'Acme Inc',
          website: 'acme.com',
          email: 'found@acme.com',
          vacancy_title: 'Account Executive',
          address: 'austin, tx, united states',
          category: 'software',
          employees: '51-200',
          source_detail: 'pdl',
          description: 'Acme builds staffing software',
        }),
        // Вердикт валидации хранится на строке — запуск пропускает не-'ok'.
        _email_status: 'ok',
      },
      // Мульти-email ячейка: в he_bases уходит первый адрес (единый email на строку).
      {
        ...enrichedRow({
          company: 'Globex',
          website: 'globex.com',
          email: 'orig@globex.com',
          category: 'staffing and recruiting',
          source_detail: 'pdl',
          description: 'Globex recruits',
        }),
        _email_status: 'invalid',
      },
    ]);

    // Статистика конструктора — в collect_info.construct.
    const info = patch?.collect_info as HeCollectInfo;
    expect(info.construct).toMatchObject({ bc_job_id: 'bc1', status: 'done', emails_found: 2, valid_count: 1 });

    // Далее обычный переход: base_analyze поставлен.
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')?.rows[0]).toEqual(
      expect.objectContaining({ stage: 'base_analyze', payload: { base_id: 'b1' } }),
    );
    // Никакого рекью — фаза завершена.
    expect(mockDb.updates.find((u) => u.table === 'he_jobs')).toBeUndefined();
  });

  it('completed по RU-заголовкам (кириллица) мапится так же', async () => {
    seedTables(
      doneInfo([row({ company: 'ООО Код', website: 'code.ru', source_detail: 'реестр' })], dispatched()),
      PROJECT_RU,
      {
        base_constructor_jobs: [
          {
            id: 'bc1',
            status: 'completed',
            data: [
              [...RU_HEADERS, 'Описание', 'Email Статус'],
              ['ООО Код', 'code.ru', 'found@code.ru', '+7999', '', 'Мск', '62.01', '50', '10000000', '7700000001', 'реестр', 'Пишет код', 'ok'],
            ],
            result_stats: { total_rows: 1, emails_found: 1 },
          },
        ],
      },
    );

    const res = await runBaseCollectStage(makeJob(), ctx());
    expect((res.result as { rows: number }).rows).toBe(1);
    const patch = lastBasePatch();
    expect(patch?.columns).toEqual([...HE_AUTO_COLLECT_COLUMNS, 'description']);
    expect(patch?.data).toEqual([
      {
        ...enrichedRow({
          company: 'ООО Код',
          website: 'code.ru',
          email: 'found@code.ru',
          phone: '+7999',
          address: 'Мск',
          category: '62.01',
          employees: '50',
          revenue: '10000000',
          inn: '7700000001',
          source_detail: 'реестр',
          description: 'Пишет код',
        }),
        _email_status: 'ok',
      },
    ]);
  });

  it('failed BC-джоба с частичными данными → импорт того, что есть, база analyzing (НЕ failed)', async () => {
    seedTables(doneInfo(HARVEST_ROWS, dispatched()), PROJECT_US, {
      base_constructor_jobs: [
        {
          id: 'bc1',
          status: 'failed',
          error_message: 'smtp proxy down',
          // Частично обработанная сетка (checkpoint после find_emails).
          data: [
            EN_HEADERS,
            ['Acme Inc', 'acme.com', 'found@acme.com', '', 'Account Executive', 'austin, tx, united states', 'software', '51-200', '', '', 'pdl'],
            ['Globex', 'globex.com', '', '', '', '', 'staffing and recruiting', '', '', '', 'pdl'],
          ],
          result_stats: null,
        },
      ],
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(2);

    const patch = lastBasePatch();
    expect(patch?.status).toBe('analyzing');
    const data = patch?.data as HeUnifiedRow[];
    expect(data[0].email).toBe('found@acme.com');
    expect(data[1].email).toBe('');
    // Без колонки description в частичных данных — и в базе её нет.
    expect(patch?.columns).toEqual([...HE_AUTO_COLLECT_COLUMNS]);

    const info = patch?.collect_info as HeCollectInfo;
    expect(info.construct?.status).toBe('failed');
    expect(info.construct?.note).toContain('failed');
    expect(mockDb.inserts.find((i) => i.table === 'he_jobs')).toBeDefined();
  });

  it('cancelled BC-джоба без данных → analyzing без обогащения (исходные строки), база НЕ падает', async () => {
    seedTables(doneInfo(HARVEST_ROWS, dispatched()), PROJECT_US, {
      base_constructor_jobs: [{ id: 'bc1', status: 'cancelled', error_message: null, data: null }],
    });

    const res = await runBaseCollectStage(makeJob(), ctx('us'));
    expect((res.result as { rows: number }).rows).toBe(2);

    const patch = lastBasePatch();
    expect(patch?.status).toBe('analyzing');
    expect(patch?.data).toEqual(HARVEST_ROWS);
    expect(patch?.columns).toEqual([...HE_AUTO_COLLECT_COLUMNS]);
    const info = patch?.collect_info as HeCollectInfo;
    expect(info.construct?.status).toBe('cancelled');
    expect(info.construct?.note).toBeTruthy();
  });
});

/* ─────────────────── launch: детект email-колонки ─────────────────── */

describe('findEmailColumn — EN-имена колонок', () => {
  it("находит 'Email' и 'Found Email' по имени (case-insensitive)", () => {
    expect(findEmailColumn(['Company', 'Email'], [])).toBe('Email');
    expect(findEmailColumn(['Company', 'Found Email'], [])).toBe('Found Email');
    expect(findEmailColumn(['company', 'found email'], [])).toBe('found email');
  });

  it('RU-детект не изменился: «Почта»/«E-mail» по имени, по содержимому — как раньше', () => {
    expect(findEmailColumn(['Компания', 'Почта'], [])).toBe('Почта');
    expect(findEmailColumn(['Компания', 'E-mail'], [])).toBe('E-mail');
    // Без имени — по содержимому (≥60% непустых значений похожи на email).
    expect(findEmailColumn(['Компания', 'Контакт'], [{ Контакт: 'a@x.ru' }, { Контакт: 'b@y.ru' }])).toBe('Контакт');
    expect(findEmailColumn(['Компания', 'Контакт'], [{ Контакт: 'позвонить' }])).toBeNull();
  });
});
