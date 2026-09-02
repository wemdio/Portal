/**
 * @jest-environment node
 *
 * Locks the shutdown heartbeat guard (incident 11.08.2026, jobs b35d5785 /
 * 8b198c11 / 5c8c1dd1).
 *
 * What broke back then: handoff to the next replica went through backdating
 * `started_at`, but the jobs keep running for the whole Docker stop grace and
 * their heartbeat — `updateJobProgress` — rewrote `started_at` back to now,
 * undoing it. All three jobs of the 15:10 deploy waited the full 15 minutes and
 * tripped the "Долго висит" monitor at 15:25.
 *
 * Handoff now goes through the lease (`lease_until`, lib/jobs/lifecycle.ts),
 * which the heartbeat never touches — but the guard still matters, now for the
 * readers of `started_at`: the health monitor and the lease's stall threshold.
 * A process that keeps writing "I am alive" until SIGKILL hides the job's
 * standstill from both.
 *
 * The guard: once the process is marked as shutting down, the heartbeat stops
 * touching `started_at`; progress itself is still recorded.
 */

import { updateJobProgress } from '@/lib/tools/baseConstructorWorker';
import { markShuttingDown, __resetShutdownStateForTests } from '@/lib/workerShutdown';

jest.mock('@/lib/supabaseAdmin', () => {
  let row: Record<string, unknown> = {};
  const makeQuery = () => {
    let mode: 'read' | 'update' = 'read';
    let patch: Record<string, unknown> = {};
    const filters: Array<{ op: 'eq' | 'in'; col: string; val: unknown }> = [];
    const matches = () =>
      filters.every((f) => {
        const cur = row[f.col];
        if (f.op === 'eq') return cur === f.val;
        return Array.isArray(f.val) && (f.val as unknown[]).includes(cur);
      });
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Record<string, unknown>) => { mode = 'update'; patch = p; return q; },
      eq: (col: string, val: unknown) => { filters.push({ op: 'eq', col, val }); return q; },
      in: (col: string, val: unknown) => { filters.push({ op: 'in', col, val }); return q; },
      single: async () => ({ data: { ...row }, error: null }),
      maybeSingle: async () => ({ data: { ...row }, error: null }),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        if (mode === 'update' && matches()) row = { ...row, ...patch };
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return q;
  };
  return {
    supabaseAdmin: {
      from: () => makeQuery(),
      __setRow: (r: Record<string, unknown>) => { row = { ...r }; },
      __getRow: () => row,
    },
  };
});

// Light step mock — keeps cheerio/scrapers out of this suite.
jest.mock('@/lib/tools/processingSteps', () => ({
  FOUND_EMAIL_COL: 'Найденный Email',
  foundEmailColForLocale: () => 'Найденный Email',
  normalizeConstructorLocale: () => 'ru',
  stepRemoveEmpty: async (data: string[][]) => data,
  stepFullDedup: async (data: string[][]) => data,
  stepEmailDedup: async (data: string[][]) => data,
  stepFindEmails: async (data: string[][]) => data,
  stepSplitEmails: async (data: string[][]) => data,
  stepRemoveSupportEmails: async (data: string[][]) => data,
  stepSiteCheck: async (data: string[][]) => data,
  stepEnrich: async (data: string[][]) => data,
  stepTAScore: async (data: string[][]) => data,
  stepNameCleanup: async (data: string[][]) => data,
  stepPersonalize: async (data: string[][]) => data,
  stepValidateEmails: async (data: string[][]) => data,
}));

const supa = jest.requireMock('@/lib/supabaseAdmin').supabaseAdmin as {
  __setRow: (r: Record<string, unknown>) => void;
  __getRow: () => Record<string, unknown>;
};

/** Any timestamp older than the stall threshold — stands for a job that has
 *  not moved for a while; the guard must leave it exactly as it is. */
const BACKDATED = new Date(Date.now() - 60 * 60_000).toISOString();

beforeEach(() => {
  __resetShutdownStateForTests();
});

describe('base-constructor heartbeat — normal operation', () => {
  it('bumps started_at on every progress tick', async () => {
    supa.__setRow({ id: 'j1', status: 'processing', started_at: BACKDATED, current_step_progress: 0 });
    await updateJobProgress('j1', 1, 'dedup_full', 40);
    const row = supa.__getRow();
    expect(row.started_at).not.toBe(BACKDATED); // heartbeat is alive
    expect(row.current_step_progress).toBe(40);
  });
});

describe('base-constructor heartbeat — redeploy fast handoff', () => {
  it('stops bumping started_at once the worker is shutting down', async () => {
    supa.__setRow({ id: 'j1', status: 'processing', started_at: BACKDATED, current_step_progress: 10 });
    markShuttingDown(); // SIGTERM arrived; backdate already written
    await updateJobProgress('j1', 1, 'dedup_full', 40);
    const row = supa.__getRow();
    // The old timestamp must survive — otherwise a stopping process reports
    // progress it is not making, to the monitor and to the lease alike.
    expect(row.started_at).toBe(BACKDATED);
    // Progress itself is still worth recording — resume restarts from it.
    expect(row.current_step_progress).toBe(40);
  });

  it('keeps the cancel guard while shutting down', async () => {
    supa.__setRow({ id: 'j1', status: 'cancelled', started_at: BACKDATED, current_step_progress: 10 });
    markShuttingDown();
    await updateJobProgress('j1', 1, 'dedup_full', 40);
    expect(supa.__getRow().status).toBe('cancelled');
    expect(supa.__getRow().current_step_progress).toBe(10);
  });
});
