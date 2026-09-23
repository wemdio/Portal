/** @jest-environment node */

/**
 * The VE2 worker itself (worker/verticalEngineV2.ts) on the 23.09.2026 hang:
 * a stage that stalls on a database read, or that the inactivity guard has to
 * abort, goes back to the queue without spending an attempt, and the guard's
 * report says where the job stood. Only the queue, the stage and the
 * provider-facing modules are replaced; the watchdog, retry policy and stage
 * database client are the real ones.
 */
jest.mock('server-only', () => ({}));

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';
process.env.VE_STAGE_DB_TIMEOUT_MS = '120000';

type Row = Record<string, unknown>;
const mockLogs: string[] = [];
const mockTransitions: Row[] = [];
const mockUpdates: Array<{ table: string; values: Row }> = [];
const mockState = { jobStatus: 'running' };
const mockPool: { run?: (job: unknown) => Promise<void> } = {};
const mockRunVeStage = jest.fn();

/** Just enough of the admin client for the worker's own bookkeeping. */
function mockDb() {
  const from = (table: string) => {
    let op: 'select' | 'update' | 'insert' = 'select';
    let columns = '';
    let values: Row = {};
    const result = () => {
      if (op !== 'select') { mockUpdates.push({ table, values }); return { data: { id: 'x' }, error: null }; }
      if (table === 've_jobs' && columns === 'status') return { data: { status: mockState.jobStatus }, error: null };
      if (table === 've_jobs') return { data: [], error: null };
      if (table === 've_projects') return { data: { market: 'ru', tokens_used: 0, cost_usd: 0 }, error: null };
      return { data: null, error: null };
    };
    const builder: Row = new Proxy({}, {
      get(_target, prop) {
        if (prop === 'then') return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => Promise.resolve(result()).then(resolve, reject);
        if (prop === 'maybeSingle' || prop === 'single') return () => Promise.resolve(result());
        if (prop === 'select') return (cols = '') => { if (op === 'select') columns = cols; return builder; };
        if (prop === 'update' || prop === 'insert') return (next: Row) => { op = prop; values = next; return builder; };
        return () => builder;
      },
    });
    return builder;
  };
  return { from, rpc: async () => ({ data: null, error: null }) };
}

jest.mock('../../../worker/_shared', () => ({
  createWorkerLogger: () => (level: string, msg: string) => { mockLogs.push(`${level} ${msg}`); },
  requireSupabaseAdmin: () => mockDb(),
  setupGracefulShutdown: () => () => false,
  pollLoop: () => new Promise(() => {}),
  startWorkerHeartbeat: () => undefined,
}));
jest.mock('@/lib/verticalEngineV2/stages', () => ({
  runVeStage: (...args: unknown[]) => mockRunVeStage(...args),
  markSegmentationAuditFailed: jest.fn(),
}));
jest.mock('@/lib/verticalEngineV2/costTelemetry', () => ({
  withVeCostTelemetry: (_db: unknown, _job: unknown, work: () => Promise<unknown>) => work(),
}));
jest.mock('@/lib/verticalEngineV2/jobQueue', () => ({
  ...jest.requireActual('@/lib/verticalEngineV2/jobQueue'),
  createVeJobPool: (options: { run: (job: unknown) => Promise<void> }) => {
    mockPool.run = options.run;
    return { pollOnce: async () => false, drain: async () => {} };
  },
}));
jest.mock('@/lib/verticalEngineV2/jobFailureTransition', () => ({
  transitionVeJobFailure: async (_db: unknown, input: Row) => { mockTransitions.push(input); return { transitioned: true, error: null }; },
}));
jest.mock('@/lib/verticalEngineV2/contactDeliveryScheduler', () => ({
  createGuardedContactDeliveryTick: () => async () => false,
  runBoundContactDeliveries: jest.fn(),
}));
jest.mock('@/lib/supabaseInstantly', () => ({ supabaseInstantly: null }));
jest.mock('@/lib/verticalEngineV2/outreachPreparation', () => ({ runVeOutreachPreparations: async () => {} }));
jest.mock('@/lib/verticalEngineV2/outreachSetup', () => ({
  autoResumeVeTransientPreparations: async () => ({ resumed: 0 }),
  enqueueVeContactReprojections: async () => ({ queued: 0 }),
}));

const BASE_ID = '0482f88b-0c6d-4509-a6ce-22278847ad21';
// Job 896efda6 on production, with four failed attempts behind it.
const job = (extra: Row = {}) => ({
  id: '896efda6-4713-49e6-8003-bdc29510fd9d', project_id: 'p1', stage: 'base_collect', status: 'running',
  attempts: 4, error: null, started_at: null, tokens_used: 0, cost_usd: 0, result: null,
  created_at: '2026-09-23T05:42:33Z', updated_at: '2026-09-23T09:05:38Z',
  payload: { limit: 5000, base_id: BASE_ID, ready_target: 500, hypothesis_id: 'h1', collection_mode: 'target', ...extra },
});

/** PostgREST answers with headers; the body never completes and ignores the abort (gzip body on a busy pool). */
function stalledBody() {
  return async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('[{"data":[')); },
  }), { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
}

const realFetch = global.fetch;
let processExit: jest.SpyInstance;

beforeAll(() => {
  // Fake clocks for the guard's 20 minutes; promise and stream internals stay real.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  processExit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  // The worker starts itself on import (main()); load it once the fake clock is set.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  jest.isolateModules(() => { require('../../../worker/verticalEngineV2'); });
});
afterAll(() => {
  jest.useRealTimers();
  processExit.mockRestore();
});
beforeEach(() => {
  mockLogs.length = 0;
  mockTransitions.length = 0;
  mockUpdates.length = 0;
  mockState.jobStatus = 'running';
  mockRunVeStage.mockReset();
  global.fetch = realFetch;
});

async function runJob(claimed: ReturnType<typeof job>, advanceMs: number): Promise<void> {
  const done = mockPool.run!(claimed);
  await jest.advanceTimersByTimeAsync(advanceMs);
  await done;
}

describe('VE2 worker: hangs do not spend attempts', () => {
  it('a stage whose database read stalls goes back to the queue with the same attempts', async () => {
    global.fetch = stalledBody() as unknown as typeof fetch;
    let readError = '';
    mockRunVeStage.mockImplementation(async (_job: unknown, ctx: { supabase: { from: (t: string) => { select: (c: string) => { neq: (c: string, v: string) => Promise<{ error: { message: string } | null }> } } } }) => {
      const { error } = await ctx.supabase.from('ve_bases').select('data,columns,source,hypothesis_id,target_checkpoint').neq('id', BASE_ID);
      readError = error?.message ?? '';
      if (error) throw new Error(`other bases: ${error.message}`);
      return { result: {} };
    });
    await runJob(job(), 10 * 60_000);

    expect(readError).toMatch(/VE2 database GET request timeout after 120000ms/);
    expect(mockTransitions).toHaveLength(1);
    expect(mockTransitions[0]).toMatchObject({ status: 'pending', attempts: 4, payload: expect.objectContaining({ base_id: BASE_ID, interruptions: 1 }) });
    // The base is not failed.
    expect(mockUpdates.filter((u) => u.table === 've_bases')).toEqual([]);
    expect(mockLogs.join('\n')).toMatch(/interrupted \(1\/10 in a row, attempt not spent\)/);
  });

  it('the inactivity guard reports where the job stood and the aborted job keeps its attempts', async () => {
    global.fetch = (async () => new Response('[{"id":"0482f88b"}]', { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    mockRunVeStage.mockImplementation(async (_job: unknown, ctx: { supabase: { from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => Promise<unknown> } } }; signal: AbortSignal; log: (m: string) => void }) => {
      await ctx.supabase.from('ve_bases').select('id').eq('id', BASE_ID);
      ctx.log('[base_collect] dispatch companies_directory: done, строк: 100');
      // Then an await with no network behind it; it honours the abort with an error of its own.
      await new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(new Error('Requesty request aborted')), { once: true }));
      return { result: {} };
    });
    await runJob(job(), 20 * 60_000 + 1_000);

    const report = mockLogs.find((line) => line.includes('Inactivity timeout'));
    expect(report).toContain('last activity: [base_collect] dispatch companies_directory: done, строк: 100');
    expect(report).toMatch(/db: last GET ve_bases\?select=id&id=eq\.0482f88b\S* — done 1200s ago, 19 B;/);
    expect(report).toMatch(/active resources: \S+×\d+/);
    expect(mockTransitions).toHaveLength(1);
    expect(mockTransitions[0]).toMatchObject({ status: 'pending', attempts: 4, error: 'VE2 base_collect inactivity timeout after 1200000ms' });
    expect(processExit).not.toHaveBeenCalled();
  });

  it('the report shows a database read that is still open when the guard fires', async () => {
    // A body that keeps trickling (one small chunk a minute) never hits the pause deadline.
    global.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[{"data":['));
          timer = setInterval(() => controller.enqueue(new TextEncoder().encode('{"company":"Когнитус"},')), 60_000);
          init?.signal?.addEventListener('abort', () => { clearInterval(timer); controller.error(init.signal!.reason); }, { once: true });
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    mockRunVeStage.mockImplementation(async (_job: unknown, ctx: { supabase: { from: (t: string) => { select: (c: string) => { neq: (c: string, v: string) => Promise<{ error: { message: string } | null }> } } } }) => {
      const { error } = await ctx.supabase.from('ve_bases').select('data,columns,source,hypothesis_id,target_checkpoint').neq('id', BASE_ID);
      if (error) throw new Error(`other bases: ${error.message}`);
      return { result: {} };
    });
    await runJob(job(), 20 * 60_000 + 1_000);

    const report = mockLogs.find((line) => line.includes('Inactivity timeout'));
    expect(report).toMatch(/db: 1 open, oldest GET ve_bases\?select=data,columns,source,hypothesis_id,target_checkpoint&id=neq\.0482f88b\S* — reading body 1200s \(status 200, \d+ B\)/);
    expect(mockTransitions[0]).toMatchObject({ status: 'pending', attempts: 4 });
  });

  it('a normal run clears the count of interruptions in a row', async () => {
    mockState.jobStatus = 'pending'; // base_collect requeued itself to wait for its parsers
    mockRunVeStage.mockResolvedValue({ result: {}, tokensUsed: 0, costUsd: 0 });
    await runJob(job({ interruptions: 3 }), 1_000);

    const write = mockUpdates.find((u) => u.table === 've_jobs' && 'payload' in u.values);
    expect(write?.values.payload).toEqual({ limit: 5000, base_id: BASE_ID, ready_target: 500, hypothesis_id: 'h1', collection_mode: 'target' });
    expect(mockTransitions).toEqual([]);
  });
});
