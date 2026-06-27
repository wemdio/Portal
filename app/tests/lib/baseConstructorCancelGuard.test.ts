/**
 * @jest-environment node
 *
 * Locks the cancel-stick guards added in commit 97e28152c so a future refactor
 * cannot silently drop them and reintroduce the "Люба" bug (cancel un-sticking).
 *
 * The base-constructor worker's OTHER unit tests use a pass-through Supabase mock
 * whose .in()/.neq() ignore the status filter — so they cannot see these guards
 * at all (deleting both guards left those suites green). This file uses a
 * FILTER-AWARE mock that applies an UPDATE only when the accumulated
 * .eq()/.in()/.neq() filters match the current row, exactly like Postgres — so:
 *   - updateJobProgress's .in('status',['pending','processing']) actually no-ops
 *     a cancelled row (heartbeat can't resurrect it), and
 *   - the failure path's .neq('status','cancelled') actually preserves a cancel.
 */

import { runBaseConstructorJob, updateJobProgress } from '@/lib/tools/baseConstructorWorker';

// Step hook: lets a test inject behaviour into the first pipeline step
// (mapped from 'remove_empty'). Must be `mock`-prefixed to be usable inside the
// hoisted jest.mock factory.
const mockStepHook: { fn: (data: string[][], onProgress: (n: number) => Promise<void>) => Promise<string[][]> } = {
  fn: async (data) => data,
};

jest.mock('@/lib/supabaseAdmin', () => {
  let row: Record<string, unknown> = {};
  const makeQuery = () => {
    let mode: 'read' | 'update' = 'read';
    let patch: Record<string, unknown> = {};
    const filters: Array<{ op: 'eq' | 'in' | 'neq'; col: string; val: unknown }> = [];
    const matches = () =>
      filters.every((f) => {
        const cur = row[f.col];
        if (f.op === 'eq') return cur === f.val;
        if (f.op === 'in') return Array.isArray(f.val) && (f.val as unknown[]).includes(cur);
        if (f.op === 'neq') return cur !== f.val;
        return true;
      });
    const q: Record<string, unknown> = {
      select: () => q,
      update: (p: Record<string, unknown>) => { mode = 'update'; patch = p; return q; },
      eq: (col: string, val: unknown) => { filters.push({ op: 'eq', col, val }); return q; },
      in: (col: string, val: unknown) => { filters.push({ op: 'in', col, val }); return q; },
      neq: (col: string, val: unknown) => { filters.push({ op: 'neq', col, val }); return q; },
      single: async () => ({ data: { ...row }, error: null }),
      maybeSingle: async () => ({ data: { ...row }, error: null }),
      // Awaiting an update chain applies the patch iff the filters match `row`.
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => {
        try {
          if (mode === 'update' && matches()) row = { ...row, ...patch };
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        } catch (e) {
          return Promise.reject(e).then(resolve, reject);
        }
      },
    };
    return q;
  };
  return {
    supabaseAdmin: {
      from: () => makeQuery(),
      __setRow: (r: Record<string, unknown>) => { row = { ...r }; },
      __getRow: () => row,
      __cancel: () => { row = { ...row, status: 'cancelled' }; },
    },
  };
});

// Light step mock — avoids importing scrapers/cheerio. Only 'remove_empty'
// (→ stepRemoveEmpty) is driven by the hook; the rest are no-ops.
jest.mock('@/lib/tools/processingSteps', () => ({
  FOUND_EMAIL_COL: 'Найденный Email',
  stepRemoveEmpty: (data: string[][], onProgress: (n: number) => Promise<void>) => mockStepHook.fn(data, onProgress),
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
  __cancel: () => void;
};

beforeEach(() => {
  mockStepHook.fn = async (data) => data;
});

describe('cancel-stick guard — heartbeat (updateJobProgress)', () => {
  it('does NOT resurrect a cancelled job back to processing', async () => {
    supa.__setRow({ id: 'j1', status: 'cancelled', current_step_progress: 8 });
    await updateJobProgress('j1', 0, 'remove_empty', 50);
    const row = supa.__getRow();
    expect(row.status).toBe('cancelled'); // guard held: .in('status',['pending','processing']) no-op'd it
    expect(row.current_step_progress).toBe(8); // patch not applied either
  });

  it('still updates progress for a live (processing) job', async () => {
    supa.__setRow({ id: 'j1', status: 'processing', current_step_progress: 0 });
    await updateJobProgress('j1', 1, 'dedup_full', 50);
    const row = supa.__getRow();
    expect(row.status).toBe('processing');
    expect(row.current_step).toBe(2); // stepIndex + 1
    expect(row.current_step_progress).toBe(50);
  });
});

describe('cancel-stick guard — failure path (runBaseConstructorJob catch)', () => {
  const baseJob = {
    id: 'j2',
    status: 'processing',
    current_step: 0,
    current_step_progress: 0,
    selected_steps: ['remove_empty', 'dedup_full'],
    step_config: {},
    data: [['компания'], ['Acme']],
  };

  it('keeps status=cancelled when a step is cancelled mid-run (not overwritten to failed)', async () => {
    supa.__setRow({ ...baseJob });
    // Simulate the user cancelling during the step, then the step erroring out.
    mockStepHook.fn = async () => {
      supa.__cancel();
      throw new Error('boom after cancel');
    };
    await runBaseConstructorJob('j2');
    expect(supa.__getRow().status).toBe('cancelled'); // .neq('status','cancelled') preserved it
  });

  it('still marks a genuinely failing job as failed (guard does not swallow real errors)', async () => {
    supa.__setRow({ ...baseJob });
    mockStepHook.fn = async () => {
      throw new Error('genuine failure');
    };
    await runBaseConstructorJob('j2');
    const row = supa.__getRow();
    expect(row.status).toBe('failed');
    expect(String(row.error_message)).toContain('genuine failure');
  });
});
