/** @jest-environment node */

/**
 * reportQueries дашборда gis-signals: агрегация воронки/среза + контракт
 * «ошибка БД = throw» (роут отвечает 500; тихий 200 с усечёнными числами
 * хуже, чем явный фейл — дашборд иначе показывает partial data как полную).
 */

jest.mock('server-only', () => ({}));

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockDb: MockSupabaseClient = createMockSupabase();

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));

import {
  getWeeklyFunnel,
  getTotalFunnel,
  getSignalSlice,
} from '@/lib/gisSignalOutreach/reportQueries';

function signalRow(id: number, segmentKey: string, flags: Partial<Record<string, boolean>> = {}) {
  return {
    id,
    segment_key: segmentKey,
    signal_general_phone: false,
    signal_contact_form: false,
    signal_sales_dept: false,
    signal_target_vacancy: false,
    signal_high_volume: false,
    signal_multi_office: false,
    ...flags,
  };
}

describe('getSignalSlice', () => {
  it('агрегирует count компаний по сегмент × сигнал за всё время', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_company_signals: [
          signalRow(1, 'edu', { signal_general_phone: true }),
          signalRow(2, 'edu', { signal_general_phone: true, signal_contact_form: true }),
          signalRow(3, 'legal', { signal_contact_form: true }),
        ],
      },
    });

    const rows = await getSignalSlice();
    expect(rows).toHaveLength(12); // 2 сегмента × 6 сигналов
    const at = (seg: string, sig: string) =>
      rows.find((r) => r.segmentKey === seg && r.signalKey === sig)?.companies;
    expect(at('edu', 'signal_general_phone')).toBe(2);
    expect(at('edu', 'signal_contact_form')).toBe(1);
    expect(at('edu', 'signal_sales_dept')).toBe(0);
    expect(at('legal', 'signal_contact_form')).toBe(1);
    expect(at('legal', 'signal_general_phone')).toBe(0);
    // Сортировка: сегмент, затем сигнал в каноническом порядке.
    expect(rows[0]).toMatchObject({ segmentKey: 'edu', signalKey: 'signal_general_phone' });
    expect(rows[6]).toMatchObject({ segmentKey: 'legal', signalKey: 'signal_general_phone' });
  });

  it('ошибка БД → throw (не тихий пустой срез)', async () => {
    mockDb = createMockSupabase({
      errorTables: { gis_signal_company_signals: 'PostgREST down' },
    });
    await expect(getSignalSlice()).rejects.toThrow('gis_signal_company_signals');
  });
});

describe('getWeeklyFunnel', () => {
  it('суммирует funnel jsonb по день × сегмент за последние 7 дней', async () => {
    const today = new Date().toISOString();
    mockDb = createMockSupabase({
      tables: {
        gis_signal_runs: [
          {
            id: 'r1',
            started_at: today,
            funnel: {
              perSegment: {
                edu: { pulled: 10, signalsOk: 5, bcIn: 4, validContacts: 3, appended: 2 },
              },
            },
          },
          {
            id: 'r2',
            started_at: today,
            funnel: {
              perSegment: {
                edu: { pulled: 6, signalsOk: 3, bcIn: 2, validContacts: 2, appended: 1 },
                legal: { pulled: 4, signalsOk: 1, bcIn: 1, validContacts: 1, appended: 0 },
              },
            },
          },
        ],
      },
    });

    const rows = await getWeeklyFunnel();
    expect(rows).toHaveLength(2);
    const day = today.slice(0, 10);
    expect(rows).toEqual([
      { runDate: day, segmentKey: 'edu', pulled: 16, signalsOk: 8, bcIn: 6, validContacts: 5, appended: 3 },
      { runDate: day, segmentKey: 'legal', pulled: 4, signalsOk: 1, bcIn: 1, validContacts: 1, appended: 0 },
    ]);
  });

  it('ошибка БД → throw (не тихая частичная воронка)', async () => {
    mockDb = createMockSupabase({ errorTables: { gis_signal_runs: 'db blip' } });
    await expect(getWeeklyFunnel()).rejects.toThrow('gis_signal_runs');
  });
});

describe('getTotalFunnel', () => {
  it('суммирует за всё время per сегмент (runDate = all)', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_runs: [
          {
            id: 'r1',
            started_at: '2026-08-01T06:00:00.000Z',
            funnel: { perSegment: { edu: { pulled: 10, signalsOk: 5, bcIn: 4, validContacts: 3, appended: 2 } } },
          },
        ],
      },
    });
    const rows = await getTotalFunnel();
    expect(rows).toEqual([
      { runDate: 'all', segmentKey: 'edu', pulled: 10, signalsOk: 5, bcIn: 4, validContacts: 3, appended: 2 },
    ]);
  });

  it('ошибка БД → throw', async () => {
    mockDb = createMockSupabase({ errorTables: { gis_signal_runs: 'db blip' } });
    await expect(getTotalFunnel()).rejects.toThrow('gis_signal_runs');
  });
});
