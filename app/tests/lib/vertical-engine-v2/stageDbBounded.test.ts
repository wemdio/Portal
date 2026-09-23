/** @jest-environment node */
jest.mock('server-only', () => ({}));

// A short header timeout makes the old behaviour observable: it expires, yet
// the body read that follows is still unbounded.
process.env.SUPABASE_FETCH_TIMEOUT_MS = '40';
process.env.SUPABASE_RETRY_MAX_ATTEMPTS = '1';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test';

import { getEventListeners } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { supabaseAdminFetchWithRetry } from '@/lib/supabaseAdmin';
import {
  createVeStageFetch,
  createVeStageSupabase,
  describeVeStageDbActivity,
  isVeStageDbInterruption,
} from '@/lib/verticalEngineV2/stageDb';
import { getVeScopedJobSignal, withVeActiveJobSignal } from '@/lib/verticalEngineV2/llm';

/**
 * 23.09.2026: nginx had sent a 5.4 MB `ve_bases` response in full, the worker
 * never finished reading it, and the job stayed silent until the inactivity
 * guard aborted it; the await ignored the abort and the process exited. This
 * response reproduces that read: headers arrive, the body never completes, and
 * (like undici) it only errors when the request's signal aborts.
 */
function stalledFetch() {
  return jest.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const signal = init?.signal ?? undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('[{"data":['));
        signal?.addEventListener('abort', () => controller.error(signal.reason), { once: true });
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

/**
 * The transport of the live case: headers arrived, the small gzip body waits
 * for the busy libuv pool, and the body stream does not react to the abort
 * at all (the same holds for a transport that never answers).
 */
function deafFetch(options: { headers: boolean }) {
  return jest.fn(async (): Promise<Response> => {
    if (!options.headers) return new Promise<Response>(() => {});
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('[{"id":')); } });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
  });
}

/** A body that keeps moving, one chunk every `everyMs`, and ends after `chunks` chunks; like undici it errors on abort. */
function tricklingFetch(chunks: number, everyMs: number) {
  return jest.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let sent = 0;
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        init?.signal?.addEventListener('abort', () => controller.error(init.signal!.reason), { once: true });
      },
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, everyMs));
        sent += 1;
        if (sent === 1) controller.enqueue(encoder.encode('['));
        else if (sent < chunks) controller.enqueue(encoder.encode(`{"i":${sent}},`));
        else { controller.enqueue(encoder.encode(`{"i":${sent}}]`)); controller.close(); }
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

const PENDING = Symbol('pending');
async function settleWithin<T>(promise: Promise<T>, ms: number): Promise<T | typeof PENDING> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<typeof PENDING>((resolve) => { timer = setTimeout(() => resolve(PENDING), ms); })]);
  } finally { clearTimeout(timer); }
}

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('VE2 stage database client', () => {
  it('root cause: the shared admin client bounds only the headers, a stalled body read never ends', async () => {
    const stalled = stalledFetch();
    global.fetch = stalled as unknown as typeof fetch;
    const db = createClient('https://db.example.test', 'service-role-test', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: supabaseAdminFetchWithRetry },
    });
    const job = new AbortController();
    const query = withVeActiveJobSignal(job.signal, async () => db.from('ve_bases').select('data').neq('id', 'b1'));
    // Far beyond the 40 ms header timeout, and even after the job is aborted.
    expect(await settleWithin(query, 150)).toBe(PENDING);
    job.abort(new Error('VE2 base_collect inactivity timeout after 1200000ms'));
    expect(await settleWithin(query, 150)).toBe(PENDING);
  });

  it('releases a stalled read as soon as the job is aborted', async () => {
    const stalled = stalledFetch();
    const db = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k',
      jobSignal: getVeScopedJobSignal, fetchImpl: stalled as unknown as typeof fetch, timeoutMs: 60_000 });
    const job = new AbortController();
    const query = withVeActiveJobSignal(job.signal, async () => db.from('ve_bases').select('data').neq('id', 'b1'));
    expect(await settleWithin(query, 50)).toBe(PENDING);
    job.abort(new Error('VE2 base_collect inactivity timeout after 1200000ms'));
    const result = await settleWithin(query, 200);
    expect(result).not.toBe(PENDING);
    const { data, error } = result as Awaited<typeof query>;
    expect(data).toBeNull();
    expect(error?.message).toMatch(/aborted/i);
    expect(error?.message).toMatch(/inactivity timeout/);
    // An aborted job never retries the request.
    expect(stalled).toHaveBeenCalledTimes(1);
  });

  it('turns a stalled body read into a transient timeout error within the deadline', async () => {
    const stalled = stalledFetch();
    const fetchImpl = createVeStageFetch({ jobSignal: () => null, fetchImpl: stalled as unknown as typeof fetch, timeoutMs: 60 });
    const started = Date.now();
    const response = await fetchImpl('https://db.example.test/rest/v1/ve_bases');
    const outcome = await settleWithin(response.text().then(() => 'resolved', (error: Error) => error), 1_000);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/timeout after 60ms/);
    expect(Date.now() - started).toBeLessThan(900);
  });

  it('refuses to start a request for an already aborted job', async () => {
    const stalled = stalledFetch();
    const job = new AbortController();
    job.abort(new Error('cancelled'));
    const fetchImpl = createVeStageFetch({ jobSignal: () => job.signal, fetchImpl: stalled as unknown as typeof fetch });
    await expect(fetchImpl('https://db.example.test/rest/v1/ve_jobs')).rejects.toMatchObject({ name: 'AbortError' });
    expect(stalled).not.toHaveBeenCalled();
  });

  it('passes complete responses through unchanged, including empty ones', async () => {
    const fetchImpl = createVeStageFetch({ jobSignal: () => null, timeoutMs: 1_000,
      fetchImpl: (async (_input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PATCH'
        ? new Response(null, { status: 204 })
        : new Response('[{"id":"b1"}]', { status: 200, headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } }))) as typeof fetch });
    const db = createClient('https://db.example.test', 'k', { auth: { persistSession: false }, global: { fetch: fetchImpl } });
    await expect(db.from('ve_bases').select('id')).resolves.toMatchObject({ data: [{ id: 'b1' }], error: null });
    await expect(db.from('ve_bases').update({ status: 'collecting' }).eq('id', 'b1')).resolves.toMatchObject({ error: null, status: 204 });
  });

  it('a job only aborts its own requests, not those of a parallel job', async () => {
    const stalled = stalledFetch();
    const db = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k',
      jobSignal: getVeScopedJobSignal, fetchImpl: stalled as unknown as typeof fetch, timeoutMs: 60_000 });
    const first = new AbortController();
    const second = new AbortController();
    const firstQuery = withVeActiveJobSignal(first.signal, async () => db.from('ve_bases').select('data'));
    const secondQuery = withVeActiveJobSignal(second.signal, async () => db.from('ve_bases').select('data'));
    first.abort(new Error('cancelled'));
    expect(await settleWithin(firstQuery, 200)).not.toBe(PENDING);
    expect(await settleWithin(secondQuery, 50)).toBe(PENDING);
    second.abort(new Error('done'));
    await settleWithin(secondQuery, 200);
  });

  it('leaves no abort listener on the long-lived job signal after its requests finish', async () => {
    const job = new AbortController();
    const fetchImpl = createVeStageFetch({ jobSignal: () => job.signal, timeoutMs: 1_000,
      fetchImpl: (async () => new Response('[]', { status: 200 })) as typeof fetch });
    // postgrest-js always reads the body; a read to the end releases the request.
    for (let i = 0; i < 20; i += 1) await (await fetchImpl('https://db.example.test/rest/v1/ve_bases')).text();
    await expect(fetchImpl('https://db.example.test/rest/v1/ve_bases', { signal: AbortSignal.abort(new Error('x')) }))
      .rejects.toBeDefined();
    expect(getEventListeners(job.signal, 'abort')).toHaveLength(0);
  });

  it('releases the caller on the job abort even when the transport ignores it (no headers, or a stalled gzip body)', async () => {
    for (const headers of [false, true]) {
      const deaf = deafFetch({ headers });
      const db = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k',
        jobSignal: getVeScopedJobSignal, fetchImpl: deaf as unknown as typeof fetch, timeoutMs: 60_000 });
      const job = new AbortController();
      const query = withVeActiveJobSignal(job.signal, async () => db.from('ve_bases').select('id').eq('id', '0482f88b'));
      expect(await settleWithin(query, 50)).toBe(PENDING);
      job.abort(new Error('VE2 base_collect inactivity timeout after 1200000ms'));
      const result = await settleWithin(query, 200);
      expect(result).not.toBe(PENDING);
      expect((result as Awaited<typeof query>).error?.message).toMatch(/VE2 job aborted: VE2 base_collect inactivity timeout/);
    }
  });

  it('a stalled body read ends once, without re-downloading the response', async () => {
    const stalled = deafFetch({ headers: true });
    const db = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k',
      jobSignal: getVeScopedJobSignal, fetchImpl: stalled as unknown as typeof fetch, timeoutMs: 80 });
    const job = new AbortController();
    const started = Date.now();
    const { data, error } = await withVeActiveJobSignal(job.signal, async () => db.from('ve_bases').select('data'));
    expect(data).toBeNull();
    expect(error?.message).toMatch(/VE2 database GET request timeout after 80ms \(response body stalled\)/);
    // postgrest-js retries a GET that fails before the headers; a stalled body is not fetched again.
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('streams the body: the caller gets the first bytes before the response is complete', async () => {
    let finish: (() => void) | undefined;
    const fetchImpl = createVeStageFetch({ jobSignal: () => null, timeoutMs: 60_000,
      fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('first chunk'));
          finish = () => { controller.enqueue(new TextEncoder().encode(', rest')); controller.close(); };
        },
      }), { status: 200 })) as typeof fetch });
    const response = await fetchImpl('https://db.example.test/rest/v1/ve_bases?select=*');
    const reader = response.body!.getReader();
    const first = await settleWithin(reader.read(), 200);
    expect(first).not.toBe(PENDING);
    expect(new TextDecoder().decode((first as ReadableStreamReadResult<Uint8Array>).value)).toBe('first chunk');
    finish!();
    const rest = await reader.read();
    expect(new TextDecoder().decode(rest.value)).toBe(', rest');
    expect((await reader.read()).done).toBe(true);
  });

  it('does not cut off a slow body that keeps moving (the deadline is a pause between chunks)', async () => {
    const trickle = tricklingFetch(8, 30);
    const db = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k',
      jobSignal: getVeScopedJobSignal, fetchImpl: trickle as unknown as typeof fetch, timeoutMs: 100 });
    const job = new AbortController();
    // 8 chunks x 30 ms = 240 ms in total, more than the 100 ms deadline.
    const { data, error } = await withVeActiveJobSignal(job.signal, async () => db.from('ve_bases').select('data'));
    expect(error).toBeNull();
    expect(data).toHaveLength(7);
    expect(trickle).toHaveBeenCalledTimes(1);
  });

  it('marks timeouts and lost connections of stage requests so the worker does not spend an attempt', async () => {
    const stalled = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k',
      jobSignal: getVeScopedJobSignal, fetchImpl: deafFetch({ headers: true }) as unknown as typeof fetch, timeoutMs: 50 });
    const timedOut = await stalled.from('ve_bases').select('data,columns,source,hypothesis_id,target_checkpoint').neq('id', '0482f88b');
    // Stages rethrow the message with their own prefix.
    expect(isVeStageDbInterruption(`other bases: ${timedOut.error?.message}`)).toBe(true);

    const reset = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    const broken = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k', jobSignal: () => null, timeoutMs: 1_000,
      fetchImpl: (async () => { throw reset; }) as typeof fetch });
    const lost = await broken.from('ve_bases').update({ status: 'collecting' }).eq('id', '0482f88b');
    expect(lost.error?.message).toBe('VeStageDbConnectionError: VE2 database PATCH request connection lost: fetch failed (ECONNRESET)');
    expect(isVeStageDbInterruption(lost.error!.message)).toBe(true);

    const rejected = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k', jobSignal: () => null, timeoutMs: 1_000,
      fetchImpl: (async () => new Response('{"code":"23505","message":"duplicate key value violates unique constraint"}',
        { status: 409, headers: { 'content-type': 'application/json' } })) as typeof fetch });
    const conflict = await rejected.from('ve_jobs').insert({ id: 'j1' });
    expect(isVeStageDbInterruption(conflict.error!.message)).toBe(false);
  });

  it('describes what the job\'s database requests were doing, for the inactivity guard', async () => {
    const stalled = stalledFetch();
    const db = createVeStageSupabase({ url: 'https://db.example.test', serviceRoleKey: 'k',
      jobSignal: getVeScopedJobSignal, fetchImpl: stalled as unknown as typeof fetch, timeoutMs: 60_000 });
    const job = new AbortController();
    expect(describeVeStageDbActivity(job.signal)).toBe('no database requests');
    const query = withVeActiveJobSignal(job.signal, async () => db.from('ve_bases')
      .select('data,columns,source,hypothesis_id,target_checkpoint').eq('project_id', 'p1').neq('id', '0482f88b'));
    await settleWithin(query, 30);
    const open = describeVeStageDbActivity(job.signal, Date.now() + 1_200_000);
    expect(open).toMatch(/^1 open, oldest GET ve_bases\?select=data,columns,source,hypothesis_id,target_checkpoint&project_id=eq\.p1/);
    expect(open).toMatch(/reading body 120\ds \(status 200/);
    job.abort(new Error('VE2 base_collect inactivity timeout after 1200000ms'));
    await settleWithin(query, 200);
    expect(describeVeStageDbActivity(job.signal)).toMatch(/^last GET ve_bases\?select=data.* — failed 0s ago/);
    // Another job's activity is separate.
    expect(describeVeStageDbActivity(new AbortController().signal)).toBe('no database requests');
  });

  it('over a real socket: decodes gzip bodies, streams a 5 MB body, and times out a body that stops', async () => {
    const bigRows = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({ id: i, data: 'x'.repeat(90) })));
    const server = http.createServer((req, res) => {
      if (req.url?.includes('small')) {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(zlib.gzipSync(Buffer.from('[{"id":"0482f88b-0c6d-4509-a6ce-22278847ad21"}]')));
      } else if (req.url?.includes('big')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(bigRows);
      } else {
        // Headers and the start of the body, then silence (the socket stays open).
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('[{"data":[');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const db = createVeStageSupabase({ url, serviceRoleKey: 'k', jobSignal: getVeScopedJobSignal, fetchImpl: realFetch, timeoutMs: 150 });
      const job = new AbortController();
      await withVeActiveJobSignal(job.signal, async () => {
        await expect(db.from('small').select('id')).resolves.toMatchObject({ error: null, data: [{ id: '0482f88b-0c6d-4509-a6ce-22278847ad21' }] });
        const big = await db.from('big').select('data');
        expect(big.error).toBeNull();
        expect(big.data).toHaveLength(50_000);
        const started = Date.now();
        const stalled = await db.from('stalled').select('data');
        expect(stalled.error?.message).toMatch(/VE2 database GET request timeout after 150ms \(response body stalled\)/);
        expect(Date.now() - started).toBeLessThan(2_000);
      });
      expect(describeVeStageDbActivity(job.signal)).toMatch(/^last GET stalled\?select=data — failed/);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('the VE2 worker hands stages the bounded client, scoped to the running job', () => {
    const worker = readFileSync(join(__dirname, '../../../worker/verticalEngineV2.ts'), 'utf8');
    expect(worker).toMatch(/const stageDb = createVeStageSupabase\(\{[\s\S]*?jobSignal: getVeScopedJobSignal,/);
    const stageCall = worker.slice(worker.indexOf('runVeStage(job, {'), worker.indexOf('runVeStage(job, {') + 80);
    expect(stageCall).toContain('supabase: stageDb,');
    // Bookkeeping after an abort (failure transition, usage journal) keeps the shared client.
    expect(worker).toContain('withVeCostTelemetry(db, job,');
  });
});
