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
  loadContactsPaceData,
  loadKpiPaceData,
  PACE_HISTORY_LIMIT,
  type PaceQueryBuilder,
  type PaceQueryClient,
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
    expect(pace!.avgPerDay).toBe(1); // round((30-10)/29)
  });
});
