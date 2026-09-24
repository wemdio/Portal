/** @jest-environment node */

/**
 * Unit tests for the pace calculator + history loaders that power the
 * "Projects" page hover tooltips (Контакты / KPI).
 *
 * The two regressions pinned here:
 *   1) The history query MUST be DESC + LIMIT N — earlier ASC + LIMIT 90
 *      caused the tooltip to operate on a project's OLDEST 90 days and
 *      ignore everything past day 90, so freshly added points stopped
 *      affecting the displayed темп. (Bug 1.)
 *   2) `computePace` must sort the input internally so it works regardless
 *      of which order the loader returns rows in.
 */

import {
  computePace,
  loadAllProjectsPace,
  loadContactsPaceData,
  loadKpiPaceData,
  PACE_HISTORY_LIMIT,
  PACE_HISTORY_WINDOW_DAYS,
  summarizeProjectRisk,
  RISK_GRACE_DAYS,
  isProjectAtRisk,
  type PaceData,
  type PaceHistoryPoint,
  type PaceQueryBuilder,
  type PaceQueryClient,
  type ProjectPace,
  type ProjectPaceInput,
} from '@/lib/projects/paceCalculator';

const NOW = new Date('2026-05-01T00:00:00Z');

/** Factory: cumulative `value` advances by `perDay` each day, starting at `from`. */
function generateHistory(
  startDate: string,
  days: number,
  perDay: number,
  initial = 0,
): { value: number; recorded_at: string }[] {
  const start = new Date(startDate);
  const out: { value: number; recorded_at: string }[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86_400_000);
    out.push({
      value: initial + (i + 1) * perDay,
      recorded_at: d.toISOString().slice(0, 10),
    });
  }
  return out;
}

describe('computePace', () => {
  it('returns base values without forecast when fewer than 2 points', () => {
    const r = computePace([{ value: 10, recorded_at: '2026-04-01' }], 100, 10, null, NOW);
    expect(r.avgPerDay).toBe(0);
    expect(r.dataPoints).toBe(1);
    expect(r.periodDays).toBe(0);
    expect(r.forecastDays).toBeNull();
  });

  it('computes avgPerDay across the full window (ascending input)', () => {
    const hist = generateHistory('2026-04-01', 11, 5); // 11 points, +5/day for 10 days
    const r = computePace(hist, 200, 55, null, NOW);
    expect(r.dataPoints).toBe(11);
    expect(r.periodDays).toBe(10);
    expect(r.avgPerDay).toBe(5);
    expect(r.remaining).toBe(145);
    expect(r.forecastDays).toBe(29); // ceil(145 / 5)
  });

  it('produces identical result when input order is reversed (descending)', () => {
    const asc = generateHistory('2026-04-01', 30, 7);
    const desc = [...asc].reverse();
    expect(computePace(asc, 500, 210, null, NOW)).toEqual(computePace(desc, 500, 210, null, NOW));
  });

  it('flags forecastDays = 0 and "выполнено" when remaining is zero', () => {
    const hist = generateHistory('2026-04-01', 10, 10);
    const r = computePace(hist, 100, 100, null, NOW);
    expect(r.remaining).toBe(0);
    expect(r.forecastDays).toBe(0);
    expect(r.forecastDate).toBe('выполнено');
  });

  it('marks onTrack=true when forecast fits before deadline', () => {
    const hist = generateHistory('2026-04-01', 10, 10);
    const deadline = '2026-06-01';
    const r = computePace(hist, 200, 100, deadline, NOW);
    expect(r.onTrack).toBe(true);
    expect(r.requiredPace).toBeLessThanOrEqual(r.avgPerDay);
  });

  it('marks onTrack=false and surfaces requiredPace when deadline is too tight', () => {
    const hist = generateHistory('2026-04-01', 30, 1);
    const deadline = '2026-05-08'; // 7 days from NOW
    const r = computePace(hist, 1000, 30, deadline, NOW);
    expect(r.avgPerDay).toBe(1);
    expect(r.onTrack).toBe(false);
    expect(r.requiredPace).toBeGreaterThan(r.avgPerDay);
  });

  it('keeps sub-1 pace as fractional instead of rounding to 0', () => {
    // Регрессия: 3 лида за 14 дней = 0.214/день. Раньше Math.round даёт 0,
    // forecastDays=null, UI «темп 0, нет прогноза». 22% всех KPI-проектов
    // в мае 2026 страдали именно от этого.
    const hist: PaceHistoryPoint[] = [
      { value: 5, recorded_at: '2026-04-01' },
      { value: 8, recorded_at: '2026-04-15' },
    ];
    const r = computePace(hist, 50, 8, null, NOW);
    expect(r.avgPerDay).toBeGreaterThan(0);
    expect(r.avgPerDay).toBeLessThan(1);
    expect(r.forecastDays).not.toBeNull();
    expect(r.forecastDays).toBeGreaterThan(0);
  });

  it('calculates KPI growth after a reset instead of treating it as negative pace', () => {
    const history = [
      { value: 14, recorded_at: '2026-06-26' },
      { value: 15, recorded_at: '2026-08-18' },
      { value: 0, recorded_at: '2026-08-19' },
      { value: 1, recorded_at: '2026-09-09' },
      { value: 4, recorded_at: '2026-09-24' },
    ];
    const result = computePace([...history].reverse(), 15, 5, '2026-09-30', new Date('2026-09-24T12:00:00Z'));
    expect(result.dataPoints).toBe(3);
    expect(result.periodDays).toBe(36);
    expect(result.avgPerDay).toBeCloseTo(4 / 36);
    expect(result.forecastDays).toBe(90);
    // Correcting the negative pace must not hide a genuine missed KPI forecast.
    expect(summarizeProjectRisk({ contacts: null, kpi: result }, false).axes).toEqual(['kpi']);
  });

  it('uses only the segment after the latest decrease, including nonzero corrections', () => {
    const result = computePace([
      { value: 200, recorded_at: '2026-04-01' },
      { value: 0, recorded_at: '2026-04-10' },
      { value: 100, recorded_at: '2026-04-20' },
      { value: 50, recorded_at: '2026-04-25' },
      { value: 70, recorded_at: '2026-04-30' },
    ], 100, 70, null, NOW);
    expect(result.dataPoints).toBe(2);
    expect(result.periodDays).toBe(5);
    expect(result.avgPerDay).toBe(4);
    expect(result.forecastDays).toBe(8);
  });

  it('has insufficient history when the last snapshot is a reset', () => {
    const result = computePace([
      { value: 10, recorded_at: '2026-04-28' },
      { value: 20, recorded_at: '2026-04-29' },
      { value: 0, recorded_at: '2026-04-30' },
    ], 100, 0, '2026-05-08', NOW);
    expect(result.dataPoints).toBe(1);
    expect(result.avgPerDay).toBe(0);
    expect(result.forecastDays).toBeNull();
    expect(result.onTrack).toBeNull();
  });

  it('excludes the old baseline even after the new counter exceeds the old total', () => {
    const result = computePace([
      { value: 10, recorded_at: '2026-04-01' },
      { value: 0, recorded_at: '2026-04-28' },
      { value: 20, recorded_at: '2026-04-30' },
    ], 100, 20, '2026-05-15', NOW);
    expect(result.avgPerDay).toBe(10);
    expect(result.onTrack).toBe(true);
  });

  it('does not reuse old pace after a live counter reset not yet saved in history', () => {
    const result = computePace(generateHistory('2026-04-25', 5, 10), 100, 0, '2026-05-08', NOW);
    expect(result.dataPoints).toBe(0);
    expect(result.forecastDays).toBeNull();
    expect(result.onTrack).toBeNull();
  });

  it('includes elapsed overdue days in the forecast delay', () => {
    const result = computePace(generateHistory('2026-04-25', 5, 10), 90, 50, '2026-04-27', NOW);
    expect(result.forecastDays).toBe(4);
    expect(result.behindDays).toBe(8); // 4 days already overdue + 4 days remaining
    expect(result.requiredPace).toBeNull();
    expect(summarizeProjectRisk({ contacts: result, kpi: null }, false).axes).toEqual(['contacts']);
  });

  it('does not flag a fulfilled obligation after its deadline', () => {
    const result = computePace(generateHistory('2026-04-25', 5, 10), 50, 50, '2026-04-20', NOW);
    expect(result.onTrack).toBe(true);
    expect(result.behindDays).toBe(0);
  });
});

describe('isProjectAtRisk', () => {
  const input: ProjectPaceInput = {
    projectId: 'p1', contactsObligation: 100, contactsDone: 50,
    kpiPlan: 0, kpiFact: 0, deadline: '2026-05-08',
  };
  const flat = computePace(generateHistory('2026-04-25', 5, 0, 50), 100, 50, input.deadline, NOW);

  it.each([
    ['still loading or failed', undefined],
    ['no snapshots', { contacts: computePace([], 100, 50, input.deadline, NOW), kpi: null }],
    ['one snapshot', { contacts: computePace([{ value: 50, recorded_at: '2026-04-30' }], 100, 50, input.deadline, NOW), kpi: null }],
    ['last snapshot is a reset', { contacts: computePace([
      { value: 90, recorded_at: '2026-04-29' }, { value: 50, recorded_at: '2026-04-30' },
    ], 100, 50, input.deadline, NOW), kpi: null }],
    ['snapshots from only one day', { contacts: computePace([
      { value: 50, recorded_at: '2026-04-30' }, { value: 50, recorded_at: '2026-04-30' },
    ], 100, 50, input.deadline, NOW), kpi: null }],
  ] as const)('does not interpret %s as confirmed lack of progress', (_label, pace) => {
    expect(isProjectAtRisk(input, pace, false, NOW)).toBe(false);
  });

  it('flags confirmed zero pace near or after the deadline on either unfinished axis', () => {
    for (const deadline of ['2026-05-15', '2026-04-30']) {
      expect(isProjectAtRisk({ ...input, deadline }, { contacts: flat, kpi: null }, false, NOW)).toBe(true);
      expect(isProjectAtRisk({ ...input, deadline, contactsObligation: 0, kpiPlan: 100, kpiFact: 50 },
        { contacts: null, kpi: flat }, false, NOW)).toBe(true);
    }
  });

  it('does not flag a newly started zero-pace project with a distant deadline', () => {
    expect(isProjectAtRisk({ ...input, deadline: '2026-05-16' }, { contacts: flat, kpi: null }, false, NOW)).toBe(false);
  });

  it('keeps overdue obligations visible without history after the seven-day grace', () => {
    expect(isProjectAtRisk({ ...input, deadline: '2026-04-23' }, undefined, false, NOW)).toBe(true);
    expect(isProjectAtRisk({ ...input, deadline: '2026-04-24' }, undefined, false, NOW)).toBe(false);
  });

  it('ignores completed projects, fulfilled targets and projects without obligations', () => {
    expect(isProjectAtRisk(input, { contacts: flat, kpi: null }, true, NOW)).toBe(false);
    expect(isProjectAtRisk({ ...input, contactsDone: 100 }, undefined, false, NOW)).toBe(false);
    expect(isProjectAtRisk({ ...input, contactsObligation: 0 }, undefined, false, NOW)).toBe(false);
  });

  it('flags a forecast outside grace and preserves an on-time forecast', () => {
    const slow = computePace(generateHistory('2026-04-25', 5, 1), 100, 50, input.deadline, NOW);
    const fast = computePace(generateHistory('2026-04-25', 5, 10), 100, 50, input.deadline, NOW);
    expect(isProjectAtRisk(input, { contacts: slow, kpi: null }, false, NOW)).toBe(true);
    expect(isProjectAtRisk(input, { contacts: fast, kpi: null }, false, NOW)).toBe(false);
  });
});

/* ── Data loaders ──────────────────────────────────────────────────────── */

interface CallLogEntry {
  method: string;
  args: unknown[];
}

function makeRecordingClient<T>(rows: T[]): { client: PaceQueryClient; calls: CallLogEntry[] } {
  const calls: CallLogEntry[] = [];
  const builder: PaceQueryBuilder<T> = {
    select: (cols) => {
      calls.push({ method: 'select', args: [cols] });
      return builder;
    },
    eq: (col, val) => {
      calls.push({ method: 'eq', args: [col, val] });
      return builder;
    },
    in: (col, values) => {
      calls.push({ method: 'in', args: [col, values] });
      return builder;
    },
    gte: (col, val) => {
      calls.push({ method: 'gte', args: [col, val] });
      return builder;
    },
    not: (col, op, val) => {
      calls.push({ method: 'not', args: [col, op, val] });
      return builder;
    },
    order: (col, opts) => {
      calls.push({ method: 'order', args: [col, opts] });
      return builder;
    },
    limit: async (n) => {
      calls.push({ method: 'limit', args: [n] });
      return { data: rows, error: null };
    },
  };
  const client: PaceQueryClient = {
    from: (table: string) => {
      calls.push({ method: 'from', args: [table] });
      return builder;
    },
  };
  return { client, calls };
}

describe('loadContactsPaceData', () => {
  it('queries project_contacts_history with DESC order and LIMIT 90 (regression: Bug 1)', async () => {
    const { client, calls } = makeRecordingClient<{ contacts_done: number; recorded_at: string }>([
      { contacts_done: 100, recorded_at: '2026-04-30' },
      { contacts_done: 80, recorded_at: '2026-04-29' },
    ]);

    await loadContactsPaceData(client, {
      projectId: 'proj-1',
      obligation: 500,
      done: 100,
      deadline: null,
      now: NOW,
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'from', args: ['project_contacts_history'] },
        { method: 'select', args: ['contacts_done, recorded_at'] },
        { method: 'eq', args: ['project_id', 'proj-1'] },
        { method: 'order', args: ['recorded_at', { ascending: false }] },
        { method: 'limit', args: [PACE_HISTORY_LIMIT] },
      ]),
    );
  });

  it('filters contacts pace by period_id when a project period is active', async () => {
    const { client, calls } = makeRecordingClient<{ contacts_done: number; recorded_at: string }>([
      { contacts_done: 250, recorded_at: '2026-05-10' },
      { contacts_done: 100, recorded_at: '2026-05-01' },
    ]);

    const pace = await loadContactsPaceData(client, {
      projectId: 'proj-1',
      periodId: 'period-2',
      obligation: 500,
      done: 250,
      deadline: null,
      now: NOW,
    });

    expect(pace?.avgPerDay).toBeCloseTo(150 / 9, 4);
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'eq', args: ['project_id', 'proj-1'] },
        { method: 'eq', args: ['period_id', 'period-2'] },
      ]),
    );
  });

  it('feeds rows into computePace and returns the resulting pace', async () => {
    const { client } = makeRecordingClient<{ contacts_done: number; recorded_at: string }>([
      { contacts_done: 60, recorded_at: '2026-04-21' },
      { contacts_done: 40, recorded_at: '2026-04-11' },
      { contacts_done: 20, recorded_at: '2026-04-01' },
    ]);

    const pace = await loadContactsPaceData(client, {
      projectId: 'proj-1',
      obligation: 200,
      done: 60,
      deadline: null,
      now: NOW,
    });

    expect(pace).not.toBeNull();
    expect(pace!.dataPoints).toBe(3);
    expect(pace!.avgPerDay).toBe(2); // (60-20)/20 days
    expect(pace!.remaining).toBe(140);
  });

  it('returns null on Supabase error', async () => {
    const builder: PaceQueryBuilder<unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      not: () => builder,
      order: () => builder,
      limit: async () => ({ data: null, error: { message: 'boom' } }),
    };
    const client: PaceQueryClient = { from: () => builder as unknown };
    await expect(
      loadContactsPaceData(client, { projectId: 'p', obligation: 1, done: 0, deadline: null, now: NOW }),
    ).resolves.toBeNull();
  });
});

describe('loadKpiPaceData', () => {
  it('queries DESC + LIMIT 90 and filters NULL kpi_fact server-side', async () => {
    const { client, calls } = makeRecordingClient<{ kpi_fact: number | null; recorded_at: string }>([
      { kpi_fact: 12, recorded_at: '2026-04-30' },
      { kpi_fact: 10, recorded_at: '2026-04-20' },
    ]);

    await loadKpiPaceData(client, {
      projectId: 'proj-2',
      kpiPlan: 50,
      kpiFact: 12,
      deadline: null,
      now: NOW,
    });

    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'select', args: ['kpi_fact, recorded_at'] },
        { method: 'eq', args: ['project_id', 'proj-2'] },
        { method: 'not', args: ['kpi_fact', 'is', null] },
        { method: 'order', args: ['recorded_at', { ascending: false }] },
        { method: 'limit', args: [PACE_HISTORY_LIMIT] },
      ]),
    );
  });

  it('drops any residual NULL kpi_fact rows defensively', async () => {
    const { client } = makeRecordingClient<{ kpi_fact: number | null; recorded_at: string }>([
      { kpi_fact: 30, recorded_at: '2026-04-30' },
      { kpi_fact: null, recorded_at: '2026-04-25' },
      { kpi_fact: 10, recorded_at: '2026-04-01' },
    ]);

    const pace = await loadKpiPaceData(client, {
      projectId: 'p',
      kpiPlan: 100,
      kpiFact: 30,
      deadline: null,
      now: NOW,
    });

    expect(pace!.dataPoints).toBe(2);
    expect(pace!.periodDays).toBe(29);
    // (30-10)/29 ≈ 0.6896. Раньше Math.round давал 1; теперь — точное float.
    expect(pace!.avgPerDay).toBeCloseTo(20 / 29, 4);
  });
});

/* ── Bulk loader + risk summary ───────────────────────────────────────── */

describe('loadAllProjectsPace', () => {
  it('handles independent counter resets identically in the list and hover loaders', async () => {
    const rows = [
      { project_id: 'p1', contacts_done: 300, kpi_fact: 2, recorded_at: '2026-04-30' },
      { project_id: 'p1', contacts_done: 100, kpi_fact: 0, recorded_at: '2026-04-28' },
      { project_id: 'p1', contacts_done: 100, kpi_fact: 12, recorded_at: '2026-04-25' },
      { project_id: 'p1', contacts_done: 200, kpi_fact: 10, recorded_at: '2026-04-20' },
    ];
    const { client } = makeRecordingClient(rows);
    const inputs = [{ projectId: 'p1', contactsObligation: 1000, contactsDone: 300,
      kpiPlan: 20, kpiFact: 2, deadline: '2026-05-15' }];
    const listPace = (await loadAllProjectsPace(client, inputs, NOW)).get('p1');
    const contactPace = await loadContactsPaceData(client, {
      projectId: 'p1', obligation: 1000, done: 300, deadline: '2026-05-15', now: NOW,
    });
    const kpiPace = await loadKpiPaceData(client, {
      projectId: 'p1', kpiPlan: 20, kpiFact: 2, deadline: '2026-05-15', now: NOW,
    });
    expect(listPace).toEqual({ contacts: contactPace, kpi: kpiPace });
    expect(listPace?.contacts?.avgPerDay).toBe(40);
    expect(listPace?.kpi?.avgPerDay).toBe(1);
    expect(isProjectAtRisk(inputs[0], listPace, false, NOW)).toBe(false);
  });

  it('queries one batch with .in / .gte cutoff / DESC order', async () => {
    const { client, calls } = makeRecordingClient<{
      project_id: string;
      contacts_done: number;
      kpi_fact: number | null;
      recorded_at: string;
    }>([]);

    await loadAllProjectsPace(
      client,
      [
        { projectId: 'p1', contactsObligation: 100, contactsDone: 0, kpiPlan: 50, kpiFact: 0, deadline: null },
        { projectId: 'p2', contactsObligation: 200, contactsDone: 0, kpiPlan: 0, kpiFact: 0, deadline: null },
      ],
      NOW,
    );

    // Cutoff = NOW - 90 days = 2026-02-01 (Feb 2026 has 28 days, so go back 90 from May 1)
    const cutoff = new Date(NOW.getTime() - PACE_HISTORY_WINDOW_DAYS * 86_400_000)
      .toISOString()
      .slice(0, 10);
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'from', args: ['project_contacts_history'] },
        { method: 'select', args: ['project_id, contacts_done, kpi_fact, recorded_at'] },
        { method: 'in', args: ['project_id', ['p1', 'p2']] },
        { method: 'gte', args: ['recorded_at', cutoff] },
        { method: 'order', args: ['recorded_at', { ascending: false }] },
      ]),
    );
  });

  it('skips the query and returns empty map when inputs is empty', async () => {
    const { client, calls } = makeRecordingClient([]);
    const result = await loadAllProjectsPace(client, [], NOW);
    expect(result.size).toBe(0);
    expect(calls).toEqual([]);
  });

  it('groups rows by project_id and computes contacts + KPI pace per project', async () => {
    const rows = [
      // p1 — растёт по контактам и KPI
      { project_id: 'p1', contacts_done: 50, kpi_fact: 25, recorded_at: '2026-04-30' },
      { project_id: 'p1', contacts_done: 10, kpi_fact: 5, recorded_at: '2026-04-01' },
      // p2 — только контакты, KPI всегда null
      { project_id: 'p2', contacts_done: 200, kpi_fact: null, recorded_at: '2026-04-30' },
      { project_id: 'p2', contacts_done: 100, kpi_fact: null, recorded_at: '2026-04-01' },
    ];
    const { client } = makeRecordingClient(rows);

    const result = await loadAllProjectsPace(
      client,
      [
        { projectId: 'p1', contactsObligation: 200, contactsDone: 50, kpiPlan: 100, kpiFact: 25, deadline: null },
        { projectId: 'p2', contactsObligation: 500, contactsDone: 200, kpiPlan: 0, kpiFact: 0, deadline: null },
      ],
      NOW,
    );

    const p1 = result.get('p1');
    expect(p1?.contacts?.dataPoints).toBe(2);
    // (50-10)/29 ≈ 1.379 — теперь float, не округление до 1.
    expect(p1?.contacts?.avgPerDay).toBeCloseTo(40 / 29, 4);
    expect(p1?.kpi?.dataPoints).toBe(2);
    // (25-5)/29 ≈ 0.6896 — раньше округлялось до 1, теперь float.
    expect(p1?.kpi?.avgPerDay).toBeCloseTo(20 / 29, 4);

    const p2 = result.get('p2');
    expect(p2?.contacts?.dataPoints).toBe(2);
    // p2 has kpiPlan=0 → KPI ось отключена
    expect(p2?.kpi).toBeNull();
  });

  it('groups bulk pace by active period_id and ignores older project-period history', async () => {
    const rows = [
      { project_id: 'p1', period_id: 'period-1', contacts_done: 1000, kpi_fact: 20, recorded_at: '2026-04-30' },
      { project_id: 'p1', period_id: 'period-2', contacts_done: 250, kpi_fact: 5, recorded_at: '2026-05-10' },
      { project_id: 'p1', period_id: 'period-2', contacts_done: 100, kpi_fact: 2, recorded_at: '2026-05-01' },
    ];
    const { client, calls } = makeRecordingClient(rows);

    const result = await loadAllProjectsPace(
      client,
      [
        {
          projectId: 'p1',
          periodId: 'period-2',
          contactsObligation: 500,
          contactsDone: 250,
          kpiPlan: 20,
          kpiFact: 5,
          deadline: null,
        },
      ],
      NOW,
    );

    expect(calls).toEqual(expect.arrayContaining([
      { method: 'in', args: ['period_id', ['period-2']] },
    ]));
    const p1 = result.get('p1');
    expect(p1?.contacts?.dataPoints).toBe(2);
    expect(p1?.contacts?.avgPerDay).toBeCloseTo(150 / 9, 4);
    expect(p1?.kpi?.dataPoints).toBe(2);
    expect(p1?.kpi?.avgPerDay).toBeCloseTo(3 / 9, 4);
  });

  it('returns empty pace pair for projects without history rows', async () => {
    const { client } = makeRecordingClient<{
      project_id: string;
      contacts_done: number;
      kpi_fact: number | null;
      recorded_at: string;
    }>([]);

    const result = await loadAllProjectsPace(
      client,
      [
        { projectId: 'fresh', contactsObligation: 100, contactsDone: 0, kpiPlan: 50, kpiFact: 0, deadline: null },
      ],
      NOW,
    );

    const r = result.get('fresh');
    expect(r?.contacts?.dataPoints).toBe(0);
    expect(r?.contacts?.onTrack).toBeNull();
    expect(r?.kpi?.dataPoints).toBe(0);
    expect(r?.kpi?.onTrack).toBeNull();
  });

  it('returns empty map on Supabase error (graceful degradation, не валим всю страницу)', async () => {
    const builder: PaceQueryBuilder<unknown> = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      gte: () => builder,
      not: () => builder,
      order: () => builder,
      limit: async () => ({ data: null, error: { message: 'down' } }),
    };
    const client: PaceQueryClient = { from: () => builder as unknown };

    const result = await loadAllProjectsPace(
      client,
      [{ projectId: 'p1', contactsObligation: 100, contactsDone: 0, kpiPlan: 0, kpiFact: 0, deadline: null }],
      NOW,
    );
    expect(result.size).toBe(0);
  });
});

describe('summarizeProjectRisk', () => {
  function paceWith(overrides: Partial<PaceData> = {}): PaceData {
    return {
      avgPerDay: 1,
      remaining: 50,
      forecastDays: 50,
      forecastDate: 'тест',
      deadline: '2026-05-15',
      onTrack: true,
      requiredPace: 1,
      dataPoints: 5,
      periodDays: 5,
      behindDays: -5,
      ...overrides,
    };
  }

  it('returns no risk when pace is missing or project is completed', () => {
    expect(summarizeProjectRisk(undefined, false)).toEqual({ axes: [], daysBehind: 0 });
    const okPace: ProjectPace = { contacts: paceWith(), kpi: paceWith() };
    expect(summarizeProjectRisk(okPace, true)).toEqual({ axes: [], daysBehind: 0 });
  });

  it('returns no risk when both axes are on track', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: true, behindDays: -3 }),
      kpi: paceWith({ onTrack: true, behindDays: -1 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({ axes: [], daysBehind: 0 });
  });

  it('flags only contacts axis when KPI is on track', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: false, behindDays: 21 }),
      kpi: paceWith({ onTrack: true, behindDays: -2 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({ axes: ['contacts'], daysBehind: 21 });
  });

  it('flags only KPI axis when contacts is on track', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: true, behindDays: 0 }),
      kpi: paceWith({ onTrack: false, behindDays: 12 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({ axes: ['kpi'], daysBehind: 12 });
  });

  it('flags both axes and reports the worst behindDays when both miss', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: false, behindDays: 9 }),
      kpi: paceWith({ onTrack: false, behindDays: 18 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({ axes: ['contacts', 'kpi'], daysBehind: 18 });
  });

  it('treats axis with onTrack=null (нет дедлайна / мало точек) as not at risk', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: null, behindDays: null, deadline: null }),
      kpi: paceWith({ onTrack: false, behindDays: 15 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({ axes: ['kpi'], daysBehind: 15 });
  });

  it('treats null axis (отключена) as not at risk', () => {
    const pace: ProjectPace = {
      contacts: null,
      kpi: paceWith({ onTrack: false, behindDays: 13 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({ axes: ['kpi'], daysBehind: 13 });
  });

  /* ── Допуск отставания (RISK_GRACE_DAYS) ──────────────────────────────── */

  it('допуск по умолчанию — неделя', () => {
    expect(RISK_GRACE_DAYS).toBe(7);
  });

  it('не считает риском отставание в пределах допуска', () => {
    for (const behindDays of [1, 3, 5, 7]) {
      const pace: ProjectPace = {
        contacts: paceWith({ onTrack: false, behindDays }),
        kpi: paceWith({ onTrack: false, behindDays }),
      };
      expect(summarizeProjectRisk(pace, false)).toEqual({ axes: [], daysBehind: 0 });
    }
  });

  it('считает риском отставание строго больше допуска', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: false, behindDays: RISK_GRACE_DAYS + 1 }),
      kpi: paceWith({ onTrack: true, behindDays: -1 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({
      axes: ['contacts'],
      daysBehind: RISK_GRACE_DAYS + 1,
    });
  });

  it('игнорирует ось в пределах допуска, но флагает соседнюю за его границей', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: false, behindDays: 4 }),
      kpi: paceWith({ onTrack: false, behindDays: 30 }),
    };
    expect(summarizeProjectRisk(pace, false)).toEqual({ axes: ['kpi'], daysBehind: 30 });
  });

  it('graceDays=0 возвращает старое поведение (любое отставание — риск)', () => {
    const pace: ProjectPace = {
      contacts: paceWith({ onTrack: false, behindDays: 3 }),
      kpi: paceWith({ onTrack: true, behindDays: -1 }),
    };
    expect(summarizeProjectRisk(pace, false, 0)).toEqual({ axes: ['contacts'], daysBehind: 3 });
  });
});
