/** @jest-environment node */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import {
  FORBIDDEN_STEPS,
  loadGisSignalConfig,
  loadGisSignalSegments,
  toTwoGisRubricGroups,
} from '@/lib/gisSignalOutreach/config';

function configRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    enabled: true,
    measure_only: false,
    client_user_id: '00000000-0000-4000-8000-000000000009',
    monthly_target_companies: 3000,
    daily_limit: 100,
    signal_min_count: 1,
    selected_steps: ['validate_emails', 'find_emails', 'remove_empty'],
    step_config: {},
    job_poll_timeout_minutes: 180,
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('loadGisSignalConfig', () => {
  it('возвращает null, когда строки конфига нет', async () => {
    mockDb = createMockSupabase({ tables: { gis_signal_pipeline_config: [] } });
    await expect(loadGisSignalConfig()).resolves.toBeNull();
  });

  it('вырезает запрещённые шаги (ta_scoring, personalization, remove_support_emails)', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_pipeline_config: [
          configRow({
            selected_steps: [
              'find_emails', 'ta_scoring', 'validate_emails',
              'personalization', 'remove_support_emails', 'remove_empty',
            ],
          }),
        ],
      },
    });
    const cfg = await loadGisSignalConfig();
    expect(cfg).not.toBeNull();
    for (const forbidden of FORBIDDEN_STEPS) {
      expect(cfg!.selected_steps).not.toContain(forbidden);
    }
    expect(cfg!.selected_steps).toEqual(['remove_empty', 'find_emails', 'validate_emails']);
  });

  it('сортирует шаги по каноническому приоритету (воркер сам не сортирует)', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_pipeline_config: [
          configRow({
            selected_steps: [
              'enrich_descriptions', 'cap_emails_per_company', 'dedup_email',
              'clean_names', 'split_emails', 'find_emails', 'validate_emails',
              'check_sites', 'dedup_full', 'remove_empty',
            ],
          }),
        ],
      },
    });
    const cfg = await loadGisSignalConfig();
    expect(cfg!.selected_steps).toEqual([
      'remove_empty', 'dedup_full', 'check_sites', 'find_emails', 'split_emails',
      'dedup_email', 'validate_emails', 'cap_emails_per_company', 'clean_names',
      'enrich_descriptions',
    ]);
  });

  it('неизвестные шаги уезжают в конец (приоритет 999), не ломая сортировку', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_pipeline_config: [
          configRow({ selected_steps: ['mystery_step', 'find_emails'] }),
        ],
      },
    });
    const cfg = await loadGisSignalConfig();
    expect(cfg!.selected_steps).toEqual(['find_emails', 'mystery_step']);
  });

  it('signal_min_count зажат снизу единицей; step_config по умолчанию {}', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_pipeline_config: [
          configRow({ signal_min_count: 0, step_config: null }),
        ],
      },
    });
    const cfg = await loadGisSignalConfig();
    expect(cfg!.signal_min_count).toBe(1);
    expect(cfg!.step_config).toEqual({});
  });
});

describe('loadGisSignalSegments', () => {
  it('отдаёт только enabled, в порядке priority ASC', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_segments: [
          {
            key: 'disabled-seg', label: 'Выключенный', instantly_campaign_id: 'camp-x',
            rubric_groups: [], priority: 0, enabled: false,
          },
          {
            key: 'clinics', label: 'Клиники', instantly_campaign_id: 'camp-1',
            rubric_groups: [{ category: 'Медицина', includedSubcategories: ['Стоматологии'] }],
            priority: 20, enabled: true,
          },
          {
            key: 'schools', label: 'Школы', instantly_campaign_id: null,
            rubric_groups: [{ category: 'Образование', excludedSubcategories: ['ВУЗы'] }],
            priority: 10, enabled: true,
          },
        ],
      },
    });
    const segments = await loadGisSignalSegments();
    expect(segments.map((s) => s.key)).toEqual(['schools', 'clinics']);
  });

  it('пустая таблица → пустой массив (не null)', async () => {
    mockDb = createMockSupabase({ tables: { gis_signal_segments: [] } });
    await expect(loadGisSignalSegments()).resolves.toEqual([]);
  });
});

describe('toTwoGisRubricGroups', () => {
  it('includedSubcategories → mode some; excluded → allExcept; пусто → all', () => {
    expect(
      toTwoGisRubricGroups([
        { category: 'Медицина', includedSubcategories: ['Стоматологии'] },
        { category: 'Образование', excludedSubcategories: ['ВУЗы'] },
        { category: 'Общепит' },
      ]),
    ).toEqual([
      { category: 'Медицина', mode: 'some', subcategories: ['Стоматологии'] },
      { category: 'Образование', mode: 'allExcept', excludedSubcategories: ['ВУЗы'] },
      { category: 'Общепит', mode: 'all' },
    ]);
  });

  it('included выигрывает у excluded, когда заданы оба', () => {
    expect(
      toTwoGisRubricGroups([
        { category: 'Медицина', includedSubcategories: ['А'], excludedSubcategories: ['Б'] },
      ]),
    ).toEqual([{ category: 'Медицина', mode: 'some', subcategories: ['А'] }]);
  });
});
