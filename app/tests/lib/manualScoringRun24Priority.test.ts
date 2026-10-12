/** @jest-environment node */

import {
  claimRun24Priority, isRun24PriorityEnabled, RUN24_PRIORITY_TARGET,
  Run24PrioritySelector, type ManualPendingRun, type PriorityDbClient,
  type Run24PriorityClaim,
} from '@/lib/jobs/manualScoringRun24Priority';

const target = RUN24_PRIORITY_TARGET;
const run: ManualPendingRun = {
  id: target.id, client_user_id: target.clientUserId,
  source_filename: target.sourceFilename, unique_count: target.totalRows,
};
const ordinaryRun = { ...run, id: 'ordinary-run' };

type Fixture = {
  run?: Record<string, unknown>;
  counts?: Record<string, unknown>;
  receipts?: Record<string, unknown>;
  commitError?: Error;
};

function database(changes: Fixture = {}) {
  const runRow = {
    ...run, status: 'pending', is_no_email_retry: true,
    route_to_instantly: true, ...changes.run,
  };
  const counts = {
    total_rows: 100, remaining_rows: 12, row_errors: 0, saved_rows: 88,
    processed_saved_rows: 88, saved_result_md5: target.savedResultMd5,
    ...changes.counts,
  };
  const receipts = { snapshots: 0, batches: 0, ledger_events: 0, ...changes.receipts };
  const query = jest.fn(async (sql: string, _values?: unknown[]) => {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    if (normalized === 'COMMIT' && changes.commitError) throw changes.commitError;
    if (normalized.includes('pg_try_advisory_xact_lock')) return { rows: [{ acquired: true }], rowCount: 1 };
    if (normalized.includes('FOR UPDATE NOWAIT')) return { rows: [runRow], rowCount: 1 };
    if (normalized.includes("WHERE status = 'processing'")) return { rows: [], rowCount: 0 };
    if (normalized.includes('AS total_rows')) return { rows: [counts], rowCount: 1 };
    if (normalized.includes('AS snapshots')) return { rows: [receipts], rowCount: 1 };
    if (normalized.startsWith('UPDATE')) return { rows: [run], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const client: PriorityDbClient = { query, release: jest.fn() };
  return { pool: { connect: jest.fn(async () => client) }, client, query };
}

const mutationCalls = (query: ReturnType<typeof database>['query']) => query.mock.calls
  .filter(([sql]) => /^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP)\b/i.test(sql));

describe('one-shot run24 dispatch', () => {
  it('is opt-in and leaves the disabled ordinary selector untouched', async () => {
    for (const value of [undefined, '', '0']) expect(isRun24PriorityEnabled(value)).toBe(false);
    expect(isRun24PriorityEnabled('1')).toBe(true);
    expect(() => isRun24PriorityEnabled('true')).toThrow();
    const selector = new Run24PrioritySelector(false);
    const ordinary = jest.fn(async () => ordinaryRun);
    const claim = jest.fn<Promise<Run24PriorityClaim>, []>();
    expect(await selector.selectNext(ordinary, claim)).toBe(ordinaryRun);
    expect(await selector.selectNext(ordinary, claim)).toBe(ordinaryRun);
    expect(claim).not.toHaveBeenCalled();
    expect(ordinary).toHaveBeenCalledTimes(2);
  });

  it('consumes the preferred claim once and then resumes ordinary selection', async () => {
    const selector = new Run24PrioritySelector(true);
    const ordinary = jest.fn(async () => ordinaryRun);
    const claim = jest.fn(async (): Promise<Run24PriorityClaim> => ({ kind: 'claimed', run }));
    expect(await selector.selectNext(ordinary, claim)).toBe(run);
    expect(ordinary).not.toHaveBeenCalled();
    expect(await selector.selectNext(ordinary, claim)).toBe(ordinaryRun);
    expect(claim).toHaveBeenCalledTimes(1);
  });

  it('retains the request on busy or preservation failure without falling through', async () => {
    const selector = new Run24PrioritySelector(true);
    const ordinary = jest.fn(async () => ordinaryRun);
    const claim = jest.fn<Promise<Run24PriorityClaim>, []>()
      .mockResolvedValueOnce({ kind: 'busy' })
      .mockRejectedValueOnce(new Error('preservation mismatch'))
      .mockResolvedValueOnce({ kind: 'claimed', run });
    expect(await selector.selectNext(ordinary, claim)).toBeNull();
    await expect(selector.selectNext(ordinary, claim)).rejects.toThrow('preservation mismatch');
    expect(ordinary).not.toHaveBeenCalled();
    expect(await selector.selectNext(ordinary, claim)).toBe(run);
    expect(claim).toHaveBeenCalledTimes(3);
  });

  it.each(['processing', 'completed', 'failed'])('does not requeue an already %s target', async (status) => {
    const db = database({ run: { status } });
    const selector = new Run24PrioritySelector(true);
    const ordinary = jest.fn(async () => ordinaryRun);
    const claim = jest.fn(() => claimRun24Priority(db.pool));
    expect(await selector.selectNext(ordinary, claim)).toBe(ordinaryRun);
    expect(await selector.selectNext(ordinary, claim)).toBe(ordinaryRun);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(mutationCalls(db.query)).toHaveLength(0);
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping selector calls instead of starting a second claim', async () => {
    const selector = new Run24PrioritySelector(true);
    let resolveClaim!: (value: Run24PriorityClaim) => void;
    const pendingClaim = new Promise<Run24PriorityClaim>((resolve) => { resolveClaim = resolve; });
    const claim = jest.fn(() => pendingClaim);
    const ordinary = jest.fn(async () => ordinaryRun);
    const first = selector.selectNext(ordinary, claim);
    await expect(selector.selectNext(ordinary, claim)).rejects.toThrow('must be serial');
    resolveClaim({ kind: 'claimed', run });
    expect(await first).toBe(run);
    expect(claim).toHaveBeenCalledTimes(1);
    expect(ordinary).not.toHaveBeenCalled();
  });

  it('commits only the exact target status after preservation and receipt checks', async () => {
    const db = database();
    expect(await claimRun24Priority(db.pool)).toEqual({ kind: 'claimed', run });
    const writes = mutationCalls(db.query);
    expect(writes).toHaveLength(1);
    expect(writes[0][0].replace(/\s+/g, ' ')).toContain("SET status = 'processing' WHERE");
    expect(writes[0][1]).toEqual([target.id, target.clientUserId, target.sourceFilename]);
    const statements = db.query.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());
    const parentLock = statements.findIndex((sql) => sql.includes('FOR UPDATE NOWAIT'));
    const childLock = statements.findIndex((sql) => sql.includes('ORDER BY id FOR UPDATE'));
    const preservationCheck = statements.findIndex((sql) => sql.includes('AS total_rows'));
    const receiptCheck = statements.findIndex((sql) => sql.includes('AS snapshots'));
    const statusWrite = statements.findIndex((sql) => sql.startsWith('UPDATE'));
    expect(parentLock).toBeGreaterThan(-1);
    expect(childLock).toBeGreaterThan(parentLock);
    expect(preservationCheck).toBeGreaterThan(childLock);
    expect(receiptCheck).toBeGreaterThan(preservationCheck);
    expect(statusWrite).toBeGreaterThan(receiptCheck);
    expect(db.query).toHaveBeenCalledWith('COMMIT');
    expect(db.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });

  it.each<[string, Fixture]>([
    ['wrong owner', { run: { client_user_id: 'different-client' } }],
    ['changed total', { counts: { total_rows: 101 } }],
    ['changed remainder', { counts: { remaining_rows: 13 } }],
    ['missing preserved row', { counts: { processed_saved_rows: 87 } }],
    ['changed saved result', { counts: { saved_result_md5: 'changed' } }],
    ['prior delivery receipt', { receipts: { batches: 1 } }],
  ])('rolls back without any mutation on %s', async (_label, fixture) => {
    const db = database(fixture);
    await expect(claimRun24Priority(db.pool)).rejects.toThrow('Run24 preflight');
    expect(mutationCalls(db.query)).toHaveLength(0);
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
    expect(db.query).not.toHaveBeenCalledWith('COMMIT');
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });

  it('does not return a runnable claim after an uncertain commit', async () => {
    const db = database({ commitError: new Error('connection lost during commit') });
    await expect(claimRun24Priority(db.pool)).rejects.toThrow('connection lost during commit');
    expect(db.query).toHaveBeenCalledWith('ROLLBACK');
    expect(db.client.release).toHaveBeenCalledTimes(1);
  });
});
