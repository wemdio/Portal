/** @jest-environment node */
import type { SupabaseClient } from '@supabase/supabase-js';
import { claimManualScoreRun, ManualScoringLease, processClaimedManualRun } from '@/lib/jobs/manualScoringLease';
import { manualDbRequest } from '@/lib/jobs/manualScoringDbRequest';

const mockProcess = jest.fn();
jest.mock('@/lib/jobs/manualScoringRunner', () => ({
  processManualRun: (...args: unknown[]) => mockProcess(...args),
  isTransientManualDbError: (error: { message?: string }) => /upstream|fetch failed/.test(error.message ?? ''),
  manualRowPayloadMatches: (row: Record<string, unknown>, payload: Record<string, unknown>) =>
    Object.entries(payload).every(([key, value]) => row[key] === value),
}));

const token = 'b64e4374-d5aa-43f4-96b7-229b1e35db3c';
const run = () => ({ id: 'run-1', client_user_id: 'client-1', source_filename: null,
  status: 'processing', unique_count: 2, worker_token: token, worker_phase: 'scoring' as const,
  worker_lease_until: new Date(Date.now() + 300_000).toISOString() });
const paused = { status: 'paused', total: 1, buckets: { storage: 1, medium: 0, high: 0, top: 0, invalid: 0 } };
const endpoint = { url: 'https://example.test', apiKey: 'test', authScheme: 'CodeRequest', timeoutMs: 10 };
const db = (rpc: jest.Mock, from = jest.fn()) => ({ rpc, from } as unknown as SupabaseClient);
beforeEach(() => { mockProcess.mockReset(); });

it('retries an ambiguous claim with the same token and never retries permission failures', async () => {
  const rpc = jest.fn().mockResolvedValueOnce({ data: null, error: { message: 'upstream unavailable' } })
    .mockResolvedValueOnce({ data: run(), error: null });
  await expect(claimManualScoreRun(db(rpc), token, { delayMs: 0 })).resolves.toMatchObject({ id: 'run-1' });
  expect(rpc.mock.calls.map((call) => call[1].p_token)).toEqual([token, token]);
  rpc.mockReset().mockResolvedValue({ data: null, error: { message: 'permission denied', code: '42501' } });
  await expect(claimManualScoreRun(db(rpc), token, { delayMs: 0 })).rejects.toThrow('permission denied');
  expect(rpc).toHaveBeenCalledTimes(1);
});

it('binds writes to the claimed token, proves lost terminal responses, and rejects a different saved result', async () => {
  const claimed = run();
  const finishedAt = '2026-10-13T12:00:00.000Z';
  const rpc = jest.fn().mockImplementation(async (name: string, args: Record<string, unknown>) => {
    if (name === 'save_manual_score_row') return { data: { bucket: 'high' }, error: null };
    if (args.p_action === 'update') return { data: null, error: { message: 'fetch failed' } };
    return { data: { ...claimed, worker_phase: args.p_action === 'routing' ? 'routing' : claimed.worker_phase }, error: null };
  });
  const read = { maybeSingle: async () => ({ data: { id: claimed.id, status: 'completed', worker_token: null,
    worker_lease_until: null, worker_phase: null,
    finished_at: '2026-10-13T12:00:00+00:00', processed_count: 2 }, error: null }) };
  const from = jest.fn(() => ({ select: () => ({ eq: () => read }) }));
  const lease = new ManualScoringLease(db(rpc, from), claimed, { delayMs: 0 });
  await lease.beforeReconcile();
  expect(rpc.mock.calls[1][1]).toMatchObject({ p_token: token, p_run_id: claimed.id, p_action: 'routing' });
  // Payload comparison is not a count/receipt shortcut.
  await expect(lease.persistRow(42, { bucket: 'medium' } as never)).rejects.toThrow('different saved result');
  await lease.updateRunState({ status: 'completed', finished_at: finishedAt, processed_count: 2 });
  await expect(lease.assertOwnership()).rejects.toThrow('closed');
  const badReceipt = new ManualScoringLease(db(jest.fn().mockResolvedValue({ data: {}, error: null })), run());
  await expect(badReceipt.updateRunState({ status: 'completed' })).rejects.toThrow('Invalid manual scoring lease receipt');
});

it('releases only after a paused pool settles and propagates unsafe release as fatal', async () => {
  const rpc = jest.fn().mockResolvedValue({ data: { id: 'run-1', status: 'pending',
    worker_token: null, worker_phase: null, worker_lease_until: null }, error: null });
  let settle!: () => void;
  mockProcess.mockImplementation(() => new Promise((resolve) => { settle = () => resolve(paused); }));
  const work = processClaimedManualRun(db(rpc), run(), { endpoint, shouldStop: () => true, onLeaseError: jest.fn() });
  expect(rpc).not.toHaveBeenCalled();
  settle();
  await expect(work).resolves.toEqual(paused);
  expect(rpc.mock.calls[0][1]).toMatchObject({ p_action: 'release', p_token: token });
  mockProcess.mockResolvedValue(paused);
  rpc.mockReset().mockResolvedValue({ data: null, error: { message: 'Manual scoring lease lost', code: 'P0001' } });
  await expect(processClaimedManualRun(db(rpc), run(), { endpoint, shouldStop: () => true, onLeaseError: jest.fn() }))
    .rejects.toThrow('lease lost');
});

it('bounds a stalled response body even when the transport ignores abort', async () => {
  jest.useFakeTimers();
  try {
    let signal!: AbortSignal;
    const never = new Promise(() => {}) as Promise<unknown> & { abortSignal?: (s: AbortSignal) => Promise<unknown> };
    never.abortSignal = (value) => { signal = value; return never; };
    const work = manualDbRequest(never, 30_000);
    const rejected = expect(work).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await jest.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(signal.aborted).toBe(true);
  } finally { jest.useRealTimers(); }
});

it('coalesces parallel ownership checks with heartbeats instead of queuing renewals', async () => {
  let settle!: (value: unknown) => void;
  const rpc = jest.fn(() => new Promise((resolve) => { settle = resolve; }));
  const lease = new ManualScoringLease(db(rpc), run());
  const checks = [lease.assertOwnership(), lease.assertOwnership(), lease.renew()];
  await Promise.resolve();
  expect(rpc).toHaveBeenCalledTimes(1);
  settle({ data: run(), error: null });
  await Promise.all(checks);
  await lease.stopHeartbeat();
  expect(rpc).toHaveBeenCalledTimes(1);
});
