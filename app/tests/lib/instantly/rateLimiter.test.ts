/** @jest-environment node */

/**
 * Tests for the Instantly distributed rate limiter (Postgres token-bucket).
 *
 * Three layers:
 *   1) rateLimiterMath — pure helpers, no DB.
 *   2) acquireInstantlyToken — kill-switch flag + bounded wait-loop + fail-open
 *      semantics, with supabaseAdmin fully mocked (no real DB).
 *   3) client.request() integration — proves the gate is a NO-OP by default and
 *      consults the RPC (with account "main") only when the flag is enabled.
 *
 * Cardinal contract under test: the limiter may DELAY a request but must NEVER
 * throw or hard-block it. Every failure mode degrades to "request proceeds".
 */

import { refill, waitSeconds, computeSleepMs } from '@/lib/instantly/rateLimiterMath';

describe('rateLimiterMath (pure, mirrors the SQL token-bucket)', () => {
  it('refill = tokens + max(0,elapsed)*rate, capped at max', () => {
    expect(refill(0, 12, 0.2, 10)).toBeCloseTo(2);   // 0 + 10*0.2
    expect(refill(11, 12, 0.2, 100)).toBe(12);       // capped at max
    expect(refill(5, 12, 0.2, 0)).toBe(5);           // no elapsed → unchanged
    expect(refill(5, 12, 0.2, -10)).toBe(5);         // negative elapsed clamped to 0
  });

  it('waitSeconds = 0 when enough tokens, else (cost-tokens)/rate; Infinity if rate 0', () => {
    expect(waitSeconds(1, 1, 0.2)).toBe(0);
    expect(waitSeconds(5, 1, 0.2)).toBe(0);
    expect(waitSeconds(0, 1, 0.2)).toBeCloseTo(5);   // 1 / 0.2
    expect(waitSeconds(0, 1, 0)).toBe(Infinity);     // refill disabled → never
  });

  it('computeSleepMs clamps to floor & remaining, applies ±25% jitter', () => {
    expect(computeSleepMs(0.5, 10_000, 0.5)).toBeCloseTo(500);  // base 500, jitter 1.0x
    expect(computeSleepMs(0.01, 10_000, 0.5)).toBe(100);        // floored at 100ms
    expect(computeSleepMs(100, 300, 0.5)).toBe(300);            // capped at remaining
    expect(computeSleepMs(5, 0, 0.5)).toBe(0);                  // no budget left
    expect(computeSleepMs(1, 10_000, 0)).toBeCloseTo(750);      // jitter low bound 0.75x
    expect(computeSleepMs(1, 10_000, 1)).toBeCloseTo(1250);     // jitter high bound 1.25x
  });
});

describe('acquireInstantlyToken (mocked supabaseAdmin)', () => {
  const ORIG_FLAG = process.env.INSTANTLY_RATE_LIMITER_ENABLED;
  const ORIG_WAIT = process.env.INSTANTLY_RATE_LIMITER_MAX_WAIT_MS;
  let origTimeout: typeof AbortSignal.timeout;

  beforeEach(() => {
    jest.resetModules();
    // Inert AbortSignal.timeout so the limiter never schedules a real timer in tests.
    origTimeout = AbortSignal.timeout;
    (AbortSignal as unknown as { timeout: () => AbortSignal }).timeout = () => new AbortController().signal;
  });

  afterEach(() => {
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = origTimeout;
    if (ORIG_FLAG === undefined) delete process.env.INSTANTLY_RATE_LIMITER_ENABLED;
    else process.env.INSTANTLY_RATE_LIMITER_ENABLED = ORIG_FLAG;
    if (ORIG_WAIT === undefined) delete process.env.INSTANTLY_RATE_LIMITER_MAX_WAIT_MS;
    else process.env.INSTANTLY_RATE_LIMITER_MAX_WAIT_MS = ORIG_WAIT;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  // Builds a fake supabaseAdmin.rpc(...).abortSignal(...) chain returning a
  // sequence of results. Each step is {data}/{error}, or an Error to reject with.
  function rpcReturning(...seq: Array<Record<string, unknown> | Error>) {
    let i = 0;
    return jest.fn(() => {
      const step = seq[Math.min(i, seq.length - 1)];
      i += 1;
      return {
        abortSignal: () => (step instanceof Error ? Promise.reject(step) : Promise.resolve(step)),
      };
    });
  }

  async function loadWith(admin: unknown) {
    jest.doMock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: admin }));
    const mod = await import('@/lib/instantly/rateLimiter');
    return mod.acquireInstantlyToken;
  }

  it('flag OFF (default) → returns immediately, never touches the DB', async () => {
    delete process.env.INSTANTLY_RATE_LIMITER_ENABLED;
    const rpc = rpcReturning({ data: 0 });
    const acquire = await loadWith({ rpc });
    await acquire('main');
    expect(rpc).not.toHaveBeenCalled();
  });

  it('supabaseAdmin null → returns immediately (fail-open)', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    const acquire = await loadWith(null);
    await expect(acquire('main')).resolves.toBeUndefined();
  });

  it('grant (wait 0) → one rpc call, correct args, proceeds', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    const rpc = rpcReturning({ data: 0 });
    const acquire = await loadWith({ rpc });
    await acquire('main');
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith('instantly_acquire_token', { p_account: 'main' });
  });

  it('rpc error branch → warn + proceed, no throw', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = rpcReturning({ error: { message: 'PGRST202 function not found' } });
    const acquire = await loadWith({ rpc });
    await expect(acquire('main')).resolves.toBeUndefined();
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });

  it('rpc rejects (timeout/throw) → caught, proceed', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = rpcReturning(new Error('AbortError'));
    const acquire = await loadWith({ rpc });
    await expect(acquire('main')).resolves.toBeUndefined();
  });

  it('garbage return (NaN) → treated as granted, proceed', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    const rpc = rpcReturning({ data: 'garbage' });
    const acquire = await loadWith({ rpc });
    await acquire('main');
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('wait>0 then grant → sleeps once, then proceeds (2 calls)', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    const rpc = rpcReturning({ data: 0.3 }, { data: 0 });
    const acquire = await loadWith({ rpc });
    jest.useFakeTimers();
    const p = acquire('main');
    await jest.advanceTimersByTimeAsync(2000);
    await p;
    expect(rpc).toHaveBeenCalledTimes(2);
  });

  it('persistent wait>0 → returns after max-wait cap, never loops forever', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    process.env.INSTANTLY_RATE_LIMITER_MAX_WAIT_MS = '500';
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const rpc = rpcReturning({ data: 100 }); // always "wait 100s"
    const acquire = await loadWith({ rpc });
    jest.useFakeTimers();
    const p = acquire('main');
    await jest.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBeUndefined();
    expect(rpc.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('client.request() rate-limit gate integration', () => {
  const ORIG_KEY = process.env.INSTANTLY_API_KEY;
  const ORIG_FLAG = process.env.INSTANTLY_RATE_LIMITER_ENABLED;
  let origTimeout: typeof AbortSignal.timeout;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    process.env.INSTANTLY_API_KEY = 'test-key';
    origTimeout = AbortSignal.timeout;
    (AbortSignal as unknown as { timeout: () => AbortSignal }).timeout = () => new AbortController().signal;
    fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [], next_starting_after: null }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    (AbortSignal as unknown as { timeout: typeof AbortSignal.timeout }).timeout = origTimeout;
    if (ORIG_KEY === undefined) delete process.env.INSTANTLY_API_KEY;
    else process.env.INSTANTLY_API_KEY = ORIG_KEY;
    if (ORIG_FLAG === undefined) delete process.env.INSTANTLY_RATE_LIMITER_ENABLED;
    else process.env.INSTANTLY_RATE_LIMITER_ENABLED = ORIG_FLAG;
    jest.restoreAllMocks();
  });

  function rpcSpy() {
    return jest.fn(() => ({ abortSignal: () => Promise.resolve({ data: 0 }) }));
  }

  async function loadClient(admin: unknown) {
    jest.doMock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: admin }));
    return import('@/lib/instantly/client');
  }

  it('flag OFF (default): request() goes straight to fetch, RPC never consulted', async () => {
    delete process.env.INSTANTLY_RATE_LIMITER_ENABLED;
    const rpc = rpcSpy();
    const { listCampaigns } = await loadClient({ rpc });
    await listCampaigns();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('flag ON: request() acquires a token (account "main") before fetch', async () => {
    process.env.INSTANTLY_RATE_LIMITER_ENABLED = '1';
    const rpc = rpcSpy();
    const { listCampaigns } = await loadClient({ rpc });
    await listCampaigns();
    expect(rpc).toHaveBeenCalledWith('instantly_acquire_token', { p_account: 'main' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
