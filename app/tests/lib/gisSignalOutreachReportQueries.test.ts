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
  getPeriodFunnel,
  getPeriodCompanyStats,
  getAppendBatchTotals,
  getPoolProcessedCounts,
} from '@/lib/gisSignalOutreach/reportQueries';

function signalRow(id: number, segmentKey: string, flags: Partial<Record<string, unknown>> = {}) {
  return {
    id,
    twogis_id: `tg-${id}`,
    segment_key: segmentKey,
    signal_general_phone: false,
    signal_contact_form: false,
    signal_sales_dept: false,
    signal_target_vacancy: false,
    signal_high_volume: false,
    signal_multi_office: false,
    signal_legal_relevance: false,
    signal_crm_calltracking: false,
    score: null,
    grade: null,
    checked_at: '2026-08-10T10:00:00.000Z',
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
          signalRow(3, 'legal', { signal_contact_form: true, signal_legal_relevance: true }),
        ],
      },
    });

    const rows = await getSignalSlice();
    expect(rows).toHaveLength(32); // 2 сегмента × 16 сигналов
    const at = (seg: string, sig: string) =>
      rows.find((r) => r.segmentKey === seg && r.signalKey === sig)?.companies;
    expect(at('edu', 'signal_general_phone')).toBe(2);
    expect(at('edu', 'signal_contact_form')).toBe(1);
    expect(at('edu', 'signal_sales_dept')).toBe(0);
    expect(at('legal', 'signal_contact_form')).toBe(1);
    expect(at('legal', 'signal_general_phone')).toBe(0);
    expect(at('legal', 'signal_legal_relevance')).toBe(1);
    expect(at('legal', 'signal_crm_calltracking')).toBe(0);
    expect(at('edu', 'signal_legal_relevance')).toBe(0);
    // Сортировка: сегмент, затем сигнал в каноническом порядке.
    expect(rows[0]).toMatchObject({ segmentKey: 'edu', signalKey: 'signal_general_phone' });
    expect(rows[16]).toMatchObject({ segmentKey: 'legal', signalKey: 'signal_general_phone' });
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
    // В фикстурах onlineOk нет (старые прогоны) → fallback на signalsOk.
    expect(rows).toEqual([
      { runDate: day, segmentKey: 'edu', pulled: 16, signalsOk: 8, onlineOk: 8, bcIn: 6, validContacts: 5, appended: 3 },
      { runDate: day, segmentKey: 'legal', pulled: 4, signalsOk: 1, onlineOk: 1, bcIn: 1, validContacts: 1, appended: 0 },
    ]);
  });

  it('onlineOk из funnel jsonb имеет приоритет над fallback на signalsOk', async () => {
    const today = new Date().toISOString();
    mockDb = createMockSupabase({
      tables: {
        gis_signal_runs: [
          {
            id: 'r1',
            started_at: today,
            funnel: {
              perSegment: {
                // Новый прогон: online-гейт отрезал 3 из 5 сигнальных.
                edu: { pulled: 10, signalsOk: 5, onlineOk: 2, bcIn: 2, validContacts: 1, appended: 1 },
              },
            },
          },
          {
            id: 'r2',
            started_at: today,
            funnel: {
              perSegment: {
                // Старый прогон (до require_online): поля нет → fallback = signalsOk.
                edu: { pulled: 4, signalsOk: 3, bcIn: 3, validContacts: 2, appended: 1 },
              },
            },
          },
        ],
      },
    });

    const rows = await getWeeklyFunnel();
    expect(rows).toEqual([
      {
        runDate: today.slice(0, 10), segmentKey: 'edu',
        pulled: 14, signalsOk: 8, onlineOk: 5, bcIn: 5, validContacts: 3, appended: 2,
      },
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
      { runDate: 'all', segmentKey: 'edu', pulled: 10, signalsOk: 5, onlineOk: 5, bcIn: 4, validContacts: 3, appended: 2 },
    ]);
  });

  it('ошибка БД → throw', async () => {
    mockDb = createMockSupabase({ errorTables: { gis_signal_runs: 'db blip' } });
    await expect(getTotalFunnel()).rejects.toThrow('gis_signal_runs');
  });
});

describe('getPeriodFunnel', () => {
  const RANGE = {
    fromUtc: new Date('2026-08-05T21:00:00.000Z'), // 2026-08-06 00:00 МСК
    toExclusiveUtc: new Date('2026-08-12T21:00:00.000Z'), // 2026-08-13 00:00 МСК
  };

  it('суммирует прогоны внутри [fromUtc; toExclusiveUtc), runDate=period', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_runs: [
          {
            id: 'in-1',
            started_at: '2026-08-06T10:00:00.000Z',
            funnel: { perSegment: { edu: { pulled: 10, signalsOk: 5, onlineOk: 4, bcIn: 3, validContacts: 2, appended: 1 } } },
          },
          {
            id: 'in-2',
            started_at: '2026-08-12T20:59:59.000Z',
            funnel: { perSegment: { edu: { pulled: 4, signalsOk: 2, bcIn: 1, validContacts: 1, appended: 1 }, legal: { pulled: 3, signalsOk: 1, bcIn: 1, validContacts: 0, appended: 0 } } },
          },
          { id: 'before', started_at: '2026-08-05T20:59:59.000Z', funnel: { perSegment: { edu: { pulled: 99 } } } },
          { id: 'after', started_at: '2026-08-12T21:00:00.000Z', funnel: { perSegment: { edu: { pulled: 88 } } } },
        ],
      },
    });

    const rows = await getPeriodFunnel(RANGE);
    expect(rows).toEqual([
      // in-2 без onlineOk (старый формат) → fallback на signalsOk.
      { runDate: 'period', segmentKey: 'edu', pulled: 14, signalsOk: 7, onlineOk: 6, bcIn: 4, validContacts: 3, appended: 2 },
      { runDate: 'period', segmentKey: 'legal', pulled: 3, signalsOk: 1, onlineOk: 1, bcIn: 1, validContacts: 0, appended: 0 },
    ]);
  });

  it('без границ (all) — все прогоны', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_runs: [
          { id: 'r1', started_at: '2026-07-01T06:00:00.000Z', funnel: { perSegment: { edu: { pulled: 5 } } } },
          { id: 'r2', started_at: '2026-08-01T06:00:00.000Z', funnel: { perSegment: { edu: { pulled: 7 } } } },
        ],
      },
    });
    const rows = await getPeriodFunnel({ fromUtc: null, toExclusiveUtc: null });
    expect(rows).toEqual([
      { runDate: 'period', segmentKey: 'edu', pulled: 12, signalsOk: 0, onlineOk: 0, bcIn: 0, validContacts: 0, appended: 0 },
    ]);
  });

  it('ошибка БД → throw', async () => {
    mockDb = createMockSupabase({ errorTables: { gis_signal_runs: 'db blip' } });
    await expect(getPeriodFunnel(RANGE)).rejects.toThrow('gis_signal_runs');
  });
});

describe('getPeriodCompanyStats', () => {
  const RANGE = {
    fromUtc: new Date('2026-08-09T21:00:00.000Z'), // пн 2026-08-10 00:00 МСК
    toExclusiveUtc: new Date('2026-08-16T21:00:00.000Z'), // пн 2026-08-17 00:00 МСК
  };

  it('считает срез по 8 сигналам, грейды A/B/C/отсев и медианный скор', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_company_signals: [
          // edu — сегмент без скоринга (score/grade NULL).
          signalRow(1, 'edu', { signal_general_phone: true, checked_at: '2026-08-10T08:00:00.000Z' }),
          signalRow(2, 'edu', { signal_contact_form: true, checked_at: '2026-08-11T08:00:00.000Z' }),
          // legal — скоринг-сегмент.
          signalRow(3, 'legal', { signal_legal_relevance: true, score: 80, grade: 'A', checked_at: '2026-08-10T09:00:00.000Z' }),
          signalRow(4, 'legal', { signal_sales_dept: true, score: 60, grade: 'B', checked_at: '2026-08-11T09:00:00.000Z' }),
          signalRow(5, 'legal', { signal_crm_calltracking: true, score: 40, grade: 'C', checked_at: '2026-08-12T09:00:00.000Z' }),
          signalRow(6, 'legal', { score: 20, grade: null, checked_at: '2026-08-12T10:00:00.000Z' }), // отсев ниже порога
          // Вне периода — не должны попасть.
          signalRow(7, 'legal', { score: 100, grade: 'A', checked_at: '2026-08-09T20:59:59.000Z' }),
          signalRow(8, 'edu', { signal_general_phone: true, checked_at: '2026-08-16T21:00:00.000Z' }),
        ],
      },
    });

    const stats = await getPeriodCompanyStats(RANGE);
    expect(stats).toHaveLength(2);
    const edu = stats.find((s) => s.segmentKey === 'edu')!;
    const legal = stats.find((s) => s.segmentKey === 'legal')!;

    expect(edu.companies).toBe(2);
    expect(edu.signalHits.signal_general_phone).toBe(1);
    expect(edu.signalHits.signal_contact_form).toBe(1);
    expect(edu.signalHits.signal_legal_relevance).toBe(0);
    expect(edu.scored).toBe(0);
    expect(edu.gradeA + edu.gradeB + edu.gradeC + edu.rejected).toBe(0);
    expect(edu.medianScore).toBeNull();

    expect(legal.companies).toBe(4);
    expect(legal.signalHits.signal_legal_relevance).toBe(1);
    expect(legal.signalHits.signal_crm_calltracking).toBe(1);
    expect(legal.scored).toBe(4);
    expect(legal.gradeA).toBe(1);
    expect(legal.gradeB).toBe(1);
    expect(legal.gradeC).toBe(1);
    expect(legal.rejected).toBe(1);
    // scores [20, 40, 60, 80] → медиана (40+60)/2 = 50.
    expect(legal.medianScore).toBe(50);
  });

  it('медиана нечётного ряда — средний элемент', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_company_signals: [
          signalRow(1, 'legal', { score: 35, grade: 'C' }),
          signalRow(2, 'legal', { score: 75, grade: 'A' }),
          signalRow(3, 'legal', { score: 55, grade: 'B' }),
        ],
      },
    });
    const stats = await getPeriodCompanyStats({ fromUtc: null, toExclusiveUtc: null });
    expect(stats[0].medianScore).toBe(55);
    expect(stats[0].rejected).toBe(0);
  });

  it('ошибка БД → throw', async () => {
    mockDb = createMockSupabase({ errorTables: { gis_signal_company_signals: 'PostgREST down' } });
    await expect(getPeriodCompanyStats(RANGE)).rejects.toThrow('gis_signal_company_signals');
  });
});

describe('getAppendBatchTotals', () => {
  const RANGE = {
    fromUtc: new Date('2026-08-09T21:00:00.000Z'),
    toExclusiveUtc: new Date('2026-08-16T21:00:00.000Z'),
  };

  function batchRow(id: string, campaignId: string, startedAt: string, counts: { requested?: number; accepted?: number; skipped?: number }, clientUserId = 'client-1') {
    return {
      id,
      client_user_id: clientUserId,
      campaign_id: campaignId,
      requested_count: counts.requested ?? 0,
      accepted_count: counts.accepted ?? 0,
      skipped_count: counts.skipped ?? 0,
      started_at: startedAt,
    };
  }

  it('суммирует requested/accepted/skipped по кампаниям за период', async () => {
    mockDb = createMockSupabase({
      tables: {
        client_campaign_append_batches: [
          batchRow('b1', 'camp-edu', '2026-08-10T08:00:00.000Z', { requested: 10, accepted: 8, skipped: 2 }),
          batchRow('b2', 'camp-edu', '2026-08-11T08:00:00.000Z', { requested: 5, accepted: 5, skipped: 0 }),
          batchRow('b3', 'camp-legal', '2026-08-12T08:00:00.000Z', { requested: 7, accepted: 6, skipped: 1 }),
          batchRow('b4', 'camp-edu', '2026-08-09T20:59:59.000Z', { requested: 99, accepted: 99 }), // до периода
          batchRow('b5', 'camp-edu', '2026-08-16T21:00:00.000Z', { requested: 88, accepted: 88 }), // после
          batchRow('b6', 'camp-foreign', '2026-08-10T08:00:00.000Z', { requested: 50, accepted: 50 }), // чужая кампания
          batchRow('b7', 'camp-edu', '2026-08-10T09:00:00.000Z', { requested: 40, accepted: 40 }, 'other-client'), // чужой клиент
        ],
      },
    });

    const rows = await getAppendBatchTotals(RANGE, ['camp-edu', 'camp-legal'], 'client-1');
    expect(rows).toEqual([
      { campaignId: 'camp-edu', requested: 15, accepted: 13, skipped: 2 },
      { campaignId: 'camp-legal', requested: 7, accepted: 6, skipped: 1 },
    ]);
  });

  it('пустой список кампаний → пустой результат без запроса', async () => {
    mockDb = createMockSupabase({ tables: { client_campaign_append_batches: [] } });
    await expect(getAppendBatchTotals(RANGE, [], 'client-1')).resolves.toEqual([]);
  });

  it('ошибка БД → throw', async () => {
    mockDb = createMockSupabase({ errorTables: { client_campaign_append_batches: 'db blip' } });
    await expect(getAppendBatchTotals(RANGE, ['camp-edu'], 'client-1')).rejects.toThrow('client_campaign_append_batches');
  });
});

describe('getPoolProcessedCounts', () => {
  it('processed = |seen ∪ archive| per сегмент (пересечение не дублируется)', async () => {
    mockDb = createMockSupabase({
      tables: {
        gis_signal_company_signals: [
          signalRow(1, 'edu', { twogis_id: 'arch-1' }),
          signalRow(2, 'edu', { twogis_id: 'arch-2' }),
          signalRow(3, 'edu', { twogis_id: 'arch-3' }),
          signalRow(4, 'legal', { twogis_id: 'arch-9' }),
        ],
        gis_signal_seen_companies: [
          // arch-2 — уже в архиве (залитая после проверки): в union не добавляется.
          { twogis_id: 'arch-2', segment_key: 'edu' },
          // seen-only — залита, но строки архива нет (дрейф): добавляется.
          { twogis_id: 'seen-only-1', segment_key: 'edu' },
          // Сегмент вне запроса — игнорируется.
          { twogis_id: 'other-1', segment_key: 'accounting' },
        ],
      },
    });

    const rows = await getPoolProcessedCounts(['edu', 'legal', 'remont']);
    expect(rows).toEqual([
      { segmentKey: 'edu', seenCount: 2, archiveCount: 3, processed: 4 },
      { segmentKey: 'legal', seenCount: 0, archiveCount: 1, processed: 1 },
      { segmentKey: 'remont', seenCount: 0, archiveCount: 0, processed: 0 },
    ]);
  });

  it('ошибка БД на count архива → throw', async () => {
    mockDb = createMockSupabase({ errorTables: { gis_signal_company_signals: 'db blip' } });
    await expect(getPoolProcessedCounts(['edu'])).rejects.toThrow('gis_signal_company_signals');
  });

  it('ошибка БД на seen → throw', async () => {
    mockDb = createMockSupabase({ errorTables: { gis_signal_seen_companies: 'db blip' } });
    await expect(getPoolProcessedCounts(['edu'])).rejects.toThrow('gis_signal_seen_companies');
  });
});
