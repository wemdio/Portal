/** @jest-environment node */

/**
 * VE2-only regression contracts for the CONSTRUCT handoff.
 *
 * The shared base-constructor already knows how to split multi-email cells,
 * validate each resulting address and cap addresses per company. VE2 must ask
 * for those steps in the right order; otherwise importConstructRows sees a
 * merged cell, keeps only its first address and can attach the cell's best
 * validation status to a different address.
 *
 * Legacy Hypothesis Engine behavior is intentionally outside this suite.
 */

jest.mock('@/lib/companiesSearch/rpcSearch', () => ({
  searchRows: jest.fn(),
}));

jest.mock('@/lib/verticalEngineV2/llm', () => ({
  callLLMWithSchema: jest.fn(),
  getVeModel: jest.fn(() => 'test-bulk-model'),
}));

const mockFindIrrelevantRows = jest.fn();

jest.mock('@/lib/verticalEngineV2/relevanceGate', () => ({
  findIrrelevantRows: (...args: unknown[]) => mockFindIrrelevantRows(...args),
}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  baseRowMatchesExclusion,
  buildBaseExclusionKeysFromRows,
  runBaseCollectStage,
  VE_AUTO_COLLECT_COLUMNS,
  type VeCollectInfo,
  type VeUnifiedRow,
} from '@/lib/verticalEngineV2/stages/baseCollect';
import { selectRefillLeadRows } from '@/lib/verticalEngineV2/stages/baseCollectRefill';
import { prepareSegmentationAudience } from '@/lib/verticalEngineV2/segmentationAudit';
import type { VeJob } from '@/lib/verticalEngineV2/types';

const PROJECT = { id: 'p1', name: 'P', created_by: 'user-1', market: 'ru' };
const VERTICAL = {
  id: 'v1',
  project_id: 'p1',
  name: 'Частные клиники',
  summary: 'Сети частных медицинских клиник',
  synonyms: [],
  potential_pct: 50,
  rank: 1,
};

const DIRECTORY_TASK = {
  source: 'companies_directory' as const,
  rationale: 'Тестовый срез реестра',
  directory_filters: { okvedCodes: ['86.1', '86.2', '86.9'], includeIp: false },
};

function unifiedRow(partial: Partial<VeUnifiedRow>): VeUnifiedRow {
  const result = {} as VeUnifiedRow;
  for (const column of VE_AUTO_COLLECT_COLUMNS) result[column] = partial[column] ?? '';
  return result;
}

function collectInfo(
  harvest: VeUnifiedRow[],
  construct?: VeCollectInfo['construct'],
): VeCollectInfo {
  return {
    plan: { tasks: [DIRECTORY_TASK] },
    tasks: [
      {
        source: DIRECTORY_TASK.source,
        status: 'done',
        child_job_id: null,
        rows: harvest.length,
        task: DIRECTORY_TASK,
        harvest,
      },
    ],
    ...(construct ? { construct } : {}),
  };
}

function makeBase(info: VeCollectInfo): Record<string, unknown> {
  return {
    id: 'b1',
    project_id: 'p1',
    vertical_id: 'v1',
    hypothesis_id: 'h1',
    filename: 'auto: Сети частных клиник',
    row_count: 0,
    columns: [],
    sample_rows: [],
    data: [],
    status: 'collecting',
    source: 'auto',
    collect_info: info,
    error: null,
  };
}

function makeJob(): VeJob {
  return {
    id: 'job-1',
    project_id: 'p1',
    stage: 'base_collect',
    status: 'running',
    payload: { base_id: 'b1', hypothesis_id: 'h1' },
    result: null,
    attempts: 1,
    error: null,
    started_at: '2026-08-30T00:00:00Z',
    tokens_used: 0,
    cost_usd: 0,
    created_at: '2026-08-30T00:00:00Z',
    updated_at: '2026-08-30T00:00:00Z',
  };
}

function seed(
  info: VeCollectInfo,
  extraTables: Record<string, Array<Record<string, unknown>>> = {},
): MockSupabaseClient {
  return createMockSupabase({
    tables: {
      ve_bases: [makeBase(info)],
      ve_verticals: [VERTICAL],
      ve_hypotheses: [
        {
          id: 'h1',
          project_id: 'p1',
          vertical_id: 'v1',
          title: 'Сети частных клиник',
          description: 'Частные клиники с собственным сайтом и действующим бизнесом.',
          status: 'accepted',
        },
      ],
      ve_projects: [PROJECT],
      ve_jobs: [makeJob() as unknown as Record<string, unknown>],
      ...extraTables,
    },
    rpcHandlers: {
      ve_directory_segment_stats: () => ({
        data: {
          directory_rows_total: 9_120,
          companies_unique_total: 8_410,
          // Known-any-row contact counts are dossier semantics.
          companies_with_email: 7_000,
          companies_with_phone: 7_250,
          companies_with_any_contact: 7_900,
          // Exact-plan estimate must use contacts on rows that themselves
          // match the hypothesis filters.
          matched_companies_with_email: 6_842,
          matched_companies_with_phone: 7_105,
          matched_companies_with_any_contact: 7_700,
        },
      }),
    },
  });
}

function lastBasePatch(db: MockSupabaseClient): Record<string, unknown> | undefined {
  return db.updates.filter((update) => update.table === 've_bases').at(-1)?.patch;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFindIrrelevantRows.mockImplementation(async (input: { rows: unknown[] }) => ({
    flagged: new Set<number>(),
    unchecked: new Set<number>(),
    coverage: {
      checkedCompanies: input.rows.length,
      totalCompanies: input.rows.length,
      complete: true,
    },
    tokensUsed: 0,
    costUsd: 0,
  }));
});

describe('base_collect CONSTRUCT step order', () => {
  it.each([
    {
      label: 'email-rich harvest',
      row: unifiedRow({
        company: 'Клиника Альфа',
        website: 'alpha.test',
        email: 'info@alpha.test, doctor@alpha.test',
        inn: '7700000001',
        source_detail: 'реестр',
      }),
      expected: [
        'enrich_descriptions',
        'split_emails',
        'dedup_email',
        'validate_emails',
        'cap_emails_per_company',
      ],
    },
    {
      label: 'email-poor harvest',
      row: unifiedRow({
        company: 'Клиника Бета',
        website: 'beta.test',
        inn: '7700000002',
        source_detail: 'реестр',
      }),
      expected: [
        'find_emails',
        'enrich_descriptions',
        'split_emails',
        'dedup_email',
        'validate_emails',
        'cap_emails_per_company',
      ],
    },
  ])('$label splits before deduplication, validation and per-company cap', async ({ row, expected }) => {
    const db = seed(collectInfo([row]));

    await expect(
      runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }),
    ).resolves.toMatchObject({ result: { waiting: true, construct: 'dispatched' } });

    const constructorInsert = db.inserts.find((insert) => insert.table === 'base_constructor_jobs');
    expect(constructorInsert?.rows[0].selected_steps).toEqual(expected);
    expect(constructorInsert?.rows[0].step_config).toEqual({
      cap_emails_per_company: { max: 5 },
    });
  });

  it('stores the company-level estimate from the exact single directory task', async () => {
    const db = seed(collectInfo([
      unifiedRow({ company: 'Клиника Альфа', website: 'alpha.test', inn: '7700000001' }),
    ]));

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    expect(db.rpcCalls).toEqual([
      {
        fn: 've_directory_segment_stats',
        params: expect.objectContaining({
          p_okved_prefixes: ['86.1', '86.2', '86.9'],
          p_include_ip: false,
          // Email is a funnel output here, not a filter on the population.
          p_require_email: false,
        }),
      },
    ]);
    const estimatePatch = db.updates.find((update) => {
      const info = update.patch.collect_info as VeCollectInfo | undefined;
      return info?.estimate?.unique_companies === 8_410;
    });
    expect((estimatePatch?.patch.collect_info as VeCollectInfo).estimate).toMatchObject({
      unique_companies: 8_410,
      companies_with_email: 6_842,
      companies_with_phone: 7_105,
      directory_rows_total: 9_120,
    });
  });

  it('re-dispatches an in-flight legacy constructor result that never split multi-email cells', async () => {
    const legacyConstruct: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-legacy-without-split',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const info = collectInfo([
      unifiedRow({
        company: 'Клиника Легаси',
        website: 'legacy.test',
        email: 'first@legacy.test, live@legacy.test',
        inn: '7700000099',
      }),
    ], legacyConstruct);
    const db = seed(info, {
      base_constructor_jobs: [
        {
          id: 'bc-legacy-without-split',
          status: 'completed',
          error_message: null,
          selected_steps: [
            'dedup_email',
            'validate_emails',
            'cap_emails_per_company',
            'enrich_descriptions',
          ],
          data: [
            ['Компания', 'Сайт', 'Email', 'ИНН', 'Email Статус'],
            [
              'Клиника Легаси',
              'legacy.test',
              'first@legacy.test, live@legacy.test',
              '7700000099',
              'ok',
            ],
          ],
        },
      ],
    });

    await expect(
      runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }),
    ).resolves.toMatchObject({ result: { waiting: true, construct: 're_dispatched' } });

    const replacement = db.inserts
      .filter((insert) => insert.table === 'base_constructor_jobs')
      .at(-1)?.rows[0];
    expect(replacement?.selected_steps).toContain('split_emails');
    expect(replacement?.data).toEqual(expect.arrayContaining([
      expect.arrayContaining(['first@legacy.test, live@legacy.test']),
    ]));

    const replacementInfo = db.updates
      .map((update) => update.patch.collect_info as VeCollectInfo | undefined)
      .find((stored) =>
        stored?.construct?.bc_job_id != null
        && stored.construct.bc_job_id !== 'bc-legacy-without-split',
      );
    expect(replacementInfo?.construct).toMatchObject({ status: 'dispatched' });
    expect(db.updates).not.toContainEqual(expect.objectContaining({
      table: 've_bases',
      patch: expect.objectContaining({ status: 'analyzing' }),
    }));
  });
});

describe('base_collect CONSTRUCT import', () => {
  it('keeps one address per row, preserves its own status and launches only the ok address', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc1',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const db = seed(
      collectInfo(
        [
          unifiedRow({
            company: 'Клиника Альфа',
            website: 'alpha.test',
            email: 'source@alpha.test',
            inn: '7700000001',
            source_detail: 'реестр',
          }),
        ],
        dispatched,
      ),
      {
        base_constructor_jobs: [
          {
            id: 'bc1',
            status: 'completed',
            error_message: null,
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            data: [
              [
                'Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория',
                'Сотрудники', 'Выручка', 'ИНН', 'Источник', 'Email Статус',
              ],
              [
                'Клиника Альфа', 'alpha.test', 'catch@alpha.test', '', '', '', '86.2',
                '', '', '7700000001', 'реестр', 'catch_all',
              ],
              [
                'Клиника Альфа', 'alpha.test', 'live@alpha.test', '', '', '', '86.2',
                '', '', '7700000001', 'реестр', 'ok',
              ],
            ],
            result_stats: { total_rows: 2, emails_found: 2 },
          },
        ],
      },
    );

    await expect(
      runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient }),
    ).resolves.toMatchObject({ result: { rows: 2 } });

    const storedRows = (lastBasePatch(db)?.data ?? []) as Array<Record<string, unknown>>;
    expect(storedRows).toEqual([
      expect.objectContaining({ email: 'catch@alpha.test', _email_status: 'catch_all' }),
      expect.objectContaining({ email: 'live@alpha.test', _email_status: 'ok' }),
    ]);

    const audience = prepareSegmentationAudience({
      rows: storedRows,
      columns: [...VE_AUTO_COLLECT_COLUMNS],
      source: 'auto',
    });
    expect(audience.leads.map((lead) => lead.email)).toEqual(['live@alpha.test']);
    expect(audience.excluded.invalidEmailStatus).toBe(1);

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 1,
      processed_rows: 2,
      launchable_rows: 1,
      low_relevance: 0,
    });
  });

  it('does not claim launch-ready recipients after a failed partial validation', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-partial-failed',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const db = seed(
      collectInfo(
        [
          unifiedRow({
            company: 'Клиника Частичная',
            website: 'partial.test',
            email: 'unchecked@partial.test',
            inn: '7700000088',
          }),
        ],
        dispatched,
      ),
      {
        base_constructor_jobs: [
          {
            id: 'bc-partial-failed',
            status: 'failed',
            error_message: 'validator unavailable',
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            // Partial checkpoint has no row-level validation column yet.
            data: [
              ['Компания', 'Сайт', 'Email', 'ИНН'],
              ['Клиника Частичная', 'partial.test', 'unchecked@partial.test', '7700000088'],
            ],
          },
        ],
      },
    );

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 1,
      processed_rows: 1,
      low_relevance: 0,
    });
    expect(storedInfo.stats).not.toHaveProperty('launchable_rows');
  });

  it('fails closed when relevance coverage leaves a valid-email company unchecked', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-relevance-partial',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const db = seed(
      collectInfo(
        [
          unifiedRow({
            company: 'Клиника Проверенная',
            website: 'checked.test',
            email: 'hello@checked.test',
            inn: '7700000101',
          }),
          unifiedRow({
            company: 'Клиника Без Вердикта',
            website: 'unchecked.test',
            email: 'hello@unchecked.test',
            inn: '7700000102',
          }),
        ],
        dispatched,
      ),
      {
        base_constructor_jobs: [
          {
            id: 'bc-relevance-partial',
            status: 'completed',
            error_message: null,
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            data: [
              [
                'Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория',
                'Сотрудники', 'Выручка', 'ИНН', 'Источник', 'Email Статус',
              ],
              [
                'Клиника Проверенная', 'checked.test', 'hello@checked.test', '', '', '',
                '86.2', '', '', '7700000101', 'реестр', 'ok',
              ],
              [
                'Клиника Без Вердикта', 'unchecked.test', 'hello@unchecked.test', '', '', '',
                '86.2', '', '', '7700000102', 'реестр', 'ok',
              ],
            ],
            result_stats: { total_rows: 2, emails_found: 2 },
          },
        ],
      },
    );
    mockFindIrrelevantRows.mockResolvedValueOnce({
      flagged: new Set<number>(),
      unchecked: new Set<number>([1]),
      coverage: {
        checkedCompanies: 1,
        totalCompanies: 2,
        complete: false,
      },
      tokensUsed: 7,
      costUsd: 0.001,
    });

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const storedRows = (lastBasePatch(db)?.data ?? []) as Array<Record<string, unknown>>;
    expect(storedRows[0]).not.toHaveProperty('_relevance_unchecked');
    expect(storedRows[1]).toEqual(expect.objectContaining({
      email: 'hello@unchecked.test',
      _email_status: 'ok',
      _relevance_unchecked: true,
    }));

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 2,
      processed_rows: 2,
      launchable_rows: 1,
      relevance_unchecked: 1,
      relevance_checked_companies: 1,
      relevance_total_companies: 2,
      relevance_coverage_complete: false,
    });
  });
});

describe('VE2 auto email validation gate', () => {
  it('excludes auto rows with a missing or empty validation status', () => {
    const audience = prepareSegmentationAudience({
      rows: [
        { company: 'Подтверждённая', email: 'ok@example.test', _email_status: 'ok' },
        { company: 'Без статуса', email: 'missing@example.test' },
        { company: 'Пустой статус', email: 'empty@example.test', _email_status: '' },
      ],
      columns: ['company', 'email'],
      source: 'auto',
    });

    expect(audience.leads.map((lead) => lead.email)).toEqual(['ok@example.test']);
    expect(audience.excluded.invalidEmailStatus).toBe(2);
  });

  it('does not turn a partial constructor row without a verdict into a launch lead', () => {
    const audience = prepareSegmentationAudience({
      rows: [{ company: 'Частичная', email: 'unchecked@example.test' }],
      columns: ['company', 'email'],
      source: 'auto',
    });

    expect(audience.leads).toEqual([]);
    expect(audience.excluded.invalidEmailStatus).toBe(1);
  });

  it('refill admits only exact ok and fails closed without status data', () => {
    const rows = [
      unifiedRow({ company: 'OK', email: 'ok@example.test' }),
      unifiedRow({ company: 'Catch-all', email: 'catch@example.test' }),
      unifiedRow({ company: 'Без статуса', email: 'missing@example.test' }),
      unifiedRow({ company: 'Пустой статус', email: 'empty@example.test' }),
    ];

    expect(selectRefillLeadRows(rows, ['ok', 'catch_all', null, ''])).toMatchObject({
      leadRows: [expect.objectContaining({ email: 'ok@example.test' })],
      withEmail: 4,
      valid: 1,
    });
    expect(selectRefillLeadRows(rows, null)).toMatchObject({
      leadRows: [],
      withEmail: 4,
      valid: 0,
    });
  });
});

describe('VE2 cross-base contact exclusion', () => {
  it('waits for an older collecting base in the same project before dispatching work', async () => {
    const info = collectInfo([
      unifiedRow({
        company: 'Клиника Новая',
        website: 'new.test',
        email: 'new@example.test',
        inn: '7700000333',
      }),
    ]);
    const current = {
      ...makeBase(info),
      id: 'b-new',
      created_at: '2026-08-30T00:02:00Z',
    };
    const older = {
      ...makeBase(collectInfo([])),
      id: 'b-old',
      created_at: '2026-08-30T00:01:00Z',
    };
    const db = seed(info, {
      ve_bases: [current, older],
    });

    await expect(
      runBaseCollectStage(
        { ...makeJob(), payload: { base_id: 'b-new', hypothesis_id: 'h1' } },
        { supabase: db as unknown as SupabaseClient },
      ),
    ).resolves.toMatchObject({
      result: { waiting: true, base_id: 'b-new', waiting_for_base_id: 'b-old' },
    });

    expect(db.inserts).toEqual([]);
    expect(db.updates).toContainEqual(expect.objectContaining({
      table: 've_jobs',
      patch: expect.objectContaining({ status: 'pending' }),
    }));
  });

  it('treats every email in another base as occupied even when company and inn differ', () => {
    const keys = buildBaseExclusionKeysFromRows([
      {
        company: 'ООО Старое имя',
        inn: '7700000001',
        email: 'owner@example.test, Shared@Example.test',
      },
    ]);

    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Совсем другая компания',
      inn: '7800000002',
      email: 'shared@example.test',
    }))).toBe(true);
    expect(baseRowMatchesExclusion(keys, unifiedRow({
      company: 'Совсем другая компания',
      inn: '7800000002',
      email: 'fresh@example.test',
    }))).toBe(false);
  });

  it('rechecks other project bases after constructor import and drops duplicate emails', async () => {
    const dispatched: NonNullable<VeCollectInfo['construct']> = {
      bc_job_id: 'bc-post-construct-dedup',
      status: 'dispatched',
      dispatched_at: '2026-08-30T00:00:00Z',
    };
    const currentHarvest = [
      unifiedRow({
        company: 'Клиника Новое Имя',
        website: 'new-name.test',
        email: 'source@new-name.test',
        inn: '7700000111',
      }),
    ];
    const db = seed(
      collectInfo(currentHarvest, dispatched),
      {
        ve_bases: [
          makeBase(collectInfo(currentHarvest, dispatched)),
          {
            id: 'b-other',
            project_id: 'p1',
            vertical_id: 'v1',
            hypothesis_id: 'h2',
            filename: 'other',
            row_count: 1,
            columns: [],
            sample_rows: [],
            data: [
              {
                company: 'Клиника Старое Имя',
                website: 'old-name.test',
                email: 'found@clinic.test',
                inn: '7800000222',
              },
            ],
            status: 'analyzed',
            source: 'auto',
            collect_info: {},
            error: null,
          },
        ],
        base_constructor_jobs: [
          {
            id: 'bc-post-construct-dedup',
            status: 'completed',
            error_message: null,
            selected_steps: [
              'split_emails',
              'dedup_email',
              'validate_emails',
              'cap_emails_per_company',
            ],
            data: [
              [
                'Компания', 'Сайт', 'Email', 'Телефон', 'Вакансия', 'Адрес', 'Категория',
                'Сотрудники', 'Выручка', 'ИНН', 'Источник', 'Email Статус',
              ],
              [
                'Клиника Новое Имя', 'new-name.test', 'found@clinic.test', '', '', '',
                '86.2', '', '', '7700000111', 'реестр', 'ok',
              ],
              [
                'Клиника Новое Имя', 'new-name.test', 'fresh@clinic.test', '', '', '',
                '86.2', '', '', '7700000111', 'реестр', 'ok',
              ],
            ],
            result_stats: { total_rows: 2, emails_found: 2 },
          },
        ],
      },
    );

    await runBaseCollectStage(makeJob(), { supabase: db as unknown as SupabaseClient });

    const storedRows = (lastBasePatch(db)?.data ?? []) as Array<Record<string, unknown>>;
    expect(storedRows.map((row) => row.email)).toEqual(['fresh@clinic.test']);
    expect(lastBasePatch(db)?.row_count).toBe(1);

    const storedInfo = lastBasePatch(db)?.collect_info as VeCollectInfo;
    expect(storedInfo.stats).toMatchObject({
      rows_total: 1,
      processed_rows: 1,
      excluded_existing_bases: 1,
      excluded_existing_bases_after_construct: 1,
      launchable_rows: 1,
    });
  });
});
