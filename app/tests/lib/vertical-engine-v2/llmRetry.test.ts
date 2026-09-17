/** @jest-environment node */

/**
 * Регрессия на транзиентный отказ провайдера (инцидент: стадия «Генерация
 * гипотез» падала на Requesty 502). rawCall обязан ретраить 408/425/429/5xx
 * с бэкоффом и НЕ ретраить постоянные 4xx.
 */

import { z } from 'zod';
import { Resolver } from 'node:dns/promises';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import { withVeCostTelemetry } from '@/lib/verticalEngineV2/costTelemetry';
import { withProviderUsage } from '@/lib/providerUsage';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { createVeSearchCapacity, searchVeRelevanceWebsites, VeSearchProviderError } from '@/lib/verticalEngineV2/relevanceSearch';
import { createVeCachedSearch, freshVeSearchCacheItems, VE_EMPTY_SEARCH_CACHE_TTL_MS, VE_SEARCH_CACHE_TTL_MS } from '@/lib/verticalEngineV2/relevanceSearchCache';

jest.mock('@/lib/clientDemo/personalize', () => ({ assertPublicWebsite: jest.fn() }));
jest.mock('@/lib/enrich/websiteParser', () => ({
  normalizeUrl: (url: string) => url,
  fetchAndExtract: jest.fn(),
}));

import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import { callLLMText, callLLMWithSchema, setVeActiveJobSignal, withVeActiveJobSignal, getVeActiveJobSignal, VE_COLLECTION_MODEL } from '@/lib/verticalEngineV2/llm';
import { defaultFetchText, resolveFetchText, resolveSearch } from '@/lib/verticalEngineV2/stages/io';
import type { VeStageContext } from '@/lib/verticalEngineV2/stages/shared';
import { isRetryableStageError, maxAttemptsFor } from '@/lib/verticalEngineV2/jobRetry';
import { getVeCollectionFailure } from '@/lib/verticalEngineV2/collectionErrors';
import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import type { VeRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { createVeJobShutdown } from '@/lib/verticalEngineV2/workerLiveness';
import { fetchVeRelevanceEvidence, resolveVeEvidenceAddress } from '@/lib/verticalEngineV2/relevanceEvidence';
import { veCompanyFactKey, veFactPageKey, freshVeCompanyFact, focusVeCompanyFact, createVeSharedPageReader, VE_COMPANY_FACT_TTL_MS, type VeCompanyFactRecord } from '@/lib/verticalEngineV2/companyFacts';
import { parseVeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';
import { needsVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceReserve';
import { recoverVeSourceContacts, hasPendingVeSourceContacts, evaluateVeSourceDiscoveryBudget, type VeSourceContactCheckpoint } from '@/lib/verticalEngineV2/sourceContacts';
import { cleanVeCompanyNames } from '@/lib/verticalEngineV2/companyNameCleanup';

const schema = z.object({ ok: z.boolean() });

function httpResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body),
  } as unknown as Response;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('llm rawCall retry', () => {
  const envBackup = { ...process.env };
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
    process.env.VE_MODEL_GATE = 'openai/gpt-4o-mini';
    process.env.VE_MODEL_RELEVANCE_REVIEW = 'openai/gpt-5-mini';
    delete process.env.VE_LLM_TIMEOUT_MS;
    jest.useFakeTimers();
  });

  afterEach(() => {
    process.env = { ...envBackup };
    setVeActiveJobSignal(null);
    global.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
    jest.clearAllMocks();
  });

  it('retries a transient 502 and succeeds on the next attempt', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(
        httpResponse(502, { error: { origin: 'provider', message: 'unavailable' } }),
      )
      .mockResolvedValueOnce(
        httpResponse(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: {} }),
      );
    global.fetch = fetchMock as unknown as typeof fetch;
    const pending = callLLMWithSchema(
      [{ role: 'user', content: 'json' }],
      schema,
      { model: 'test-model' },
    );
    await jest.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A committed journal write whose response was lost must be retried with
    // one stable ID, without repeating the successful paid request.
    const journalWarning = jest.spyOn(console, 'warn').mockImplementation(() => {});
    for (const permanent of [false, true]) {
      journalWarning.mockClear();
      const writes = new Map<string, number>();
      const upsert = jest.fn((row: { id: string; event: string }, options: unknown) => {
        expect(options).toEqual({ onConflict: 'id', ignoreDuplicates: true });
        const count = (writes.get(row.id) ?? 0) + 1;
        writes.set(row.id, count);
        return { abortSignal: async () => ({ error: count === 1 || (permanent && row.event === 'finished')
          ? { code: 'UND_ERR_CONNECT_TIMEOUT', message: 'private diagnostic details' } : null }) };
      });
      const db = { from: (table: string) => {
        expect(table).toBe('application_logs');
        return { upsert };
      } } as unknown as SupabaseClient;
      const job = { id: 'job', project_id: 'project', stage: 'base_analyze', payload: { provider_usage_origin: { runId: 'origin' } } } as unknown as VeJob;
      fetchMock.mockClear().mockResolvedValue(httpResponse(200, { choices: [{ message: { content: '{"ok":true}' } }], usage: {} }));
      const operation = withVeCostTelemetry(db, job, () => callLLMWithSchema(
        [{ role: 'user', content: 'json' }], schema, { model: 'test-model' },
      ));
      const assertion = permanent ? expect(operation).rejects.toThrow('Provider usage journal could not be saved.')
        : expect(operation).resolves.toMatchObject({ data: { ok: true } });
      await jest.advanceTimersByTimeAsync(5000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect([...writes.values()].sort()).toEqual(permanent ? [2, 2, 2, 3] : [2, 2, 2, 2]);
      expect(maxAttemptsFor('Provider usage journal could not be saved.')).toBe(1);
      expect(journalWarning).toHaveBeenCalledTimes(permanent ? 1 : 0);
      if (permanent) {
        expect(journalWarning).toHaveBeenCalledWith(expect.stringContaining('code=UND_ERR_CONNECT_TIMEOUT'));
        expect(JSON.stringify(journalWarning.mock.calls)).not.toContain('private diagnostic details');
      }
    }
    // A model-expanded brand must not discard the other verified names.
    // Preserve the safe source words; do not infer the name from its domain.
    const companyRows = [
      { company: 'ОАО "БХЗ"', website: 'bhz.test' },
      { company: 'ООО "ПГ"ФОСФОРИТ"', website: 'different.test' },
      { company: '<unsafe>', website: 'unsafe.test' },
    ];
    fetchMock.mockReset().mockResolvedValue(httpResponse(200, {
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ cleaned: [
        { idx: 0, name: 'Выдуманный химический завод' }, { idx: 1, name: 'ПГ Фосфорит' }, { idx: 2, name: '<unsafe>' },
      ] }) } }], usage: {},
    }));
    const checkpoint = jest.fn(async () => {});
    const cleaned = await cleanVeCompanyNames({ rows: companyRows, language: 'ru', scope: 'test', onCheckpoint: checkpoint });
    expect(cleaned.summary).toMatchObject({ checked: 2, failed: 1 });
    expect(cleaned.rows.map((row) => row._ve_company_name)).toMatchObject([
      { status: 'ready', value: companyRows[0].company }, { status: 'ready', value: 'ПГ Фосфорит' }, { status: 'failed', value: '' },
    ]);
    expect(cleaned.rows.map((row) => row.company)).toEqual(companyRows.map((row) => row.company));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).response_format.type).toBe('json_schema');
    fetchMock.mockClear();
    await cleanVeCompanyNames({ rows: companyRows.slice(0, 2), language: 'ru', scope: 'test',
      checkpoint: cleaned.checkpoint, onCheckpoint: checkpoint });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(httpResponse(400, { error: 'configuration' }));
    const stopped = await cleanVeCompanyNames({ rows: Array.from({ length: 81 }, (_, i) => ({ company: `Factory ${i}` })),
      language: 'ru', scope: 'test', onCheckpoint: checkpoint });
    expect(stopped.summary.checked).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockReset().mockResolvedValue(httpResponse(429, {}));
    const delayedNames = cleanVeCompanyNames({ rows: companyRows.slice(0, 2), language: 'ru', scope: 'test', onCheckpoint: checkpoint });
    await jest.advanceTimersByTimeAsync(14_000);
    expect((await delayedNames).summary).toMatchObject({ status: 'partial', retryable: true, checked: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(stopped.summary.retryable).toBeUndefined();
  });

  it('does not retry a permanent 4xx', async () => {
    const fetchMock = jest.fn().mockResolvedValue(httpResponse(400, { error: 'bad request' }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' }),
    ).rejects.toThrow(/Requesty 400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops Requesty billing failures on the first job attempt and shows only a safe actionable reason', async () => {
    const fetchMock = jest.fn().mockResolvedValue(httpResponse(402, {
      error: { message: 'Insufficient funds; account detail must stay private', amount: 500 },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const error = await callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' })
      .then(() => { throw new Error('Expected billing failure'); }, (reason: Error) => reason);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error.message).toContain('Requesty 402');
    expect(maxAttemptsFor(error.message)).toBe(1);
    expect(isRetryableStageError(error.message)).toBe(false);
    const visible = getVeCollectionFailure(error, { relevanceCoverageComplete: false });
    expect(visible.kind).toBe('billing');
    expect(visible.message).toMatch(/пополнить баланс/);
    expect(visible.message).not.toMatch(/account detail|500|\{|\}/);
    expect(getVeCollectionFailure('Проверка релевантности завершилась не полностью').kind).toBe('incomplete_checks');
    expect(getVeCollectionFailure('Авто-сборка не дала строк: source details').kind).toBe('source');
    expect(getVeCollectionFailure('private database error').message).not.toContain('private database');
    expect(maxAttemptsFor('Requesty 502: unavailable')).toBe(5);
    expect(maxAttemptsFor('Invalid candidate 402')).toBe(3);

    fetchMock.mockClear();
    const rows = Array.from({ length: 102 }, (_, i) => ({
      company: `Company ${Math.floor(i / 2)}`, email: `contact${i}@example.org`,
      description: 'Manufactures industrial equipment',
      inn: String(7700000000 + Math.floor(i / 2)),
    }));
    const gate = await findIrrelevantRows({ rows, verticalName: 'Equipment', language: 'en' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(gate.error).toContain('Requesty 402');
    expect(gate.coverage).toEqual({ checkedCompanies: 0, totalCompanies: 51, complete: false });
    expect(gate.unchecked).toEqual(new Set(rows.map((_, i) => i)));
    expect(gate.flagged.size).toBe(0);
  });

  it('gives up after exhausting retries on 502', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValue(httpResponse(502, { error: { message: 'unavailable' } }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const assertion = expect(
      callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' }),
    ).rejects.toThrow(/Requesty 502/);
    await jest.advanceTimersByTimeAsync(14_000);
    await assertion;
    // 1 исходный + 3 повтора = 4.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('bounds headers and response bodies, including the schema-repair attempt, with one deadline', async () => {
    for (const phase of ['headers', 'body', 'error-body', 'repair'] as const) {
      const response = deferred<Response>();
      const body = deferred<unknown>();
      const parent = new AbortController();
      setVeActiveJobSignal(parent.signal);
      const fetchMock = jest.fn().mockImplementation(() => phase === 'headers'
        ? response.promise
        : Promise.resolve({
            ...httpResponse(phase === 'error-body' ? 502 : 200, {}),
            json: () => body.promise,
            text: () => body.promise,
          }));
      if (phase === 'repair') fetchMock.mockImplementationOnce(() => response.promise);
      global.fetch = fetchMock as unknown as typeof fetch;
      let failure: unknown;
      const pending = phase === 'error-body'
        ? callLLMText([{ role: 'user', content: 'text' }], { model: 'test-model' })
        : callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' });
      void pending.catch((error) => { failure = error; });
      await jest.advanceTimersByTimeAsync(200_000);
      if (phase === 'repair') {
        response.resolve(httpResponse(200, { choices: [{ message: { content: '{"ok":"invalid"}' } }] }));
        await jest.advanceTimersByTimeAsync(0);
      }
      expect(failure).toBeUndefined();
      await jest.advanceTimersByTimeAsync(100_000);
      expect(failure).toEqual(expect.objectContaining({ name: 'VeOperationTimeoutError', message: expect.stringMatching(/timeout/i) }));
      const requestSignal = (fetchMock.mock.calls.at(-1)?.[1] as RequestInit).signal;
      expect(requestSignal?.aborted).toBe(true);
      expect(parent.signal.aborted).toBe(false);
      // Late transport completion must neither retry nor repair with a new job's signal.
      setVeActiveJobSignal(new AbortController().signal);
      response.resolve(httpResponse(502, {}));
      body.resolve({ choices: [{ message: { content: '{"ok":"invalid"}' } }] });
      await jest.advanceTimersByTimeAsync(14_000);
      expect(fetchMock).toHaveBeenCalledTimes(phase === 'repair' ? 2 : 1);
      expect(jest.getTimerCount()).toBe(0);
    }
    setVeActiveJobSignal(null);
    const controllers = [new AbortController(), new AbortController()];
    const replies = [deferred<Response>(), deferred<Response>()];
    const calls = jest.fn().mockImplementationOnce(() => replies[0].promise).mockImplementationOnce(() => replies[1].promise);
    global.fetch = calls as unknown as typeof fetch;
    const parallel = controllers.map((controller) => withVeActiveJobSignal(controller.signal, async () => {
      await Promise.resolve();
      expect(getVeActiveJobSignal()).toBe(controller.signal);
      return callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' });
    }));
    const cancelled = expect(parallel[0]).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(0);
    expect(calls).toHaveBeenCalledTimes(2);
    controllers[0].abort();
    await cancelled;
    expect(calls.mock.calls[0][1].signal.aborted).toBe(true);
    expect(calls.mock.calls[1][1].signal.aborted).toBe(false);
    replies[1].resolve(httpResponse(200, { choices: [{ message: { content: '{"ok":true}' } }] }));
    expect((await parallel[1]).data).toEqual({ ok: true });
    replies[0].resolve(httpResponse(200, { choices: [{ message: { content: '{"ok":false}' } }] }));
    await jest.advanceTimersByTimeAsync(0);
    expect(getVeActiveJobSignal()).toBeNull();
    expect(calls).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);

    // A slow but successful search must finish without buying a second request.
    process.env.SERPER_API_KEY = 'test-search-key';
    const response = deferred<Response>();
    const searchFetch = jest.fn().mockReturnValue(response.promise);
    global.fetch = searchFetch as unknown as typeof fetch;
    const events: Array<{ phase: string; status?: string }> = [];
    const scope = { projectId: 'project', baseId: 'base', jobId: 'job', stage: 'base_collect' };
    const searching = withProviderUsage(scope, async (_scope, event) => { events.push(event); },
      () => searchVeRelevanceWebsites('company'));
    await jest.advanceTimersByTimeAsync(20_000);
    expect(searchFetch.mock.calls[0][1].signal.aborted).toBe(false);
    response.resolve(httpResponse(200, { organic: [{ link: 'https://company.test/' }], credits: 1 }));
    await expect(searching).resolves.toEqual([{ link: 'https://company.test/' }]);
    expect(searchFetch).toHaveBeenCalledTimes(1);
    expect(events.map((event) => [event.phase, event.status])).toEqual([['started', undefined], ['finished', 'success']]);
    searchFetch.mockClear().mockReturnValue(new Promise<never>(() => {}));
    const timedOut = expect(searchVeRelevanceWebsites('company')).rejects.toThrow('Serper transient: timeout.');
    await jest.advanceTimersByTimeAsync(30_001);
    await timedOut;
    expect(searchFetch).toHaveBeenCalledTimes(1);
    expect(searchFetch.mock.calls[0][1].signal.aborted).toBe(true);

    // Shared capacity releases on errors, removes cancelled waiters and rejects
    // outage traffic before metering/HTTP. Advancing time reopens it naturally.
    const capacity = createVeSearchCapacity(2, 2, 60_000);
    const releases = [deferred<void>(), deferred<void>()];
    const paid = jest.fn().mockImplementationOnce(async () => {
      await releases[0].promise; throw new VeSearchProviderError('transient', 'timeout');
    }).mockImplementationOnce(async () => {
      await releases[1].promise; throw new VeSearchProviderError('transient', 'transport');
    }).mockResolvedValue('ok');
    const first = expect(capacity(undefined, paid)).rejects.toThrow('timeout');
    const second = expect(capacity(undefined, paid)).rejects.toThrow('transport');
    const queuedAbort = new AbortController();
    const queued = expect(capacity(queuedAbort.signal, paid)).rejects.toMatchObject({ name: 'AbortError' });
    queuedAbort.abort();
    await queued;
    releases[0].resolve(); releases[1].resolve();
    await Promise.all([first, second]);
    await expect(capacity(undefined, paid)).rejects.toThrow('cooldown');
    expect(paid).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(60_001);
    await expect(capacity(undefined, paid)).resolves.toBe('ok');
    expect(paid).toHaveBeenCalledTimes(3);
    const outageCapacity = createVeSearchCapacity(1, 1, 60_000);
    const releaseOutage = deferred<void>();
    const outage = expect(outageCapacity(undefined, async () => {
      await releaseOutage.promise; throw new VeSearchProviderError('transient', 'timeout');
    })).rejects.toThrow('timeout');
    const waitingWork = jest.fn();
    const rejectedQueue = expect(outageCapacity(undefined, waitingWork)).rejects.toThrow('cooldown');
    releaseOutage.resolve();
    await Promise.all([outage, rejectedQueue]);
    expect(waitingWork).not.toHaveBeenCalled();

    // Concurrent bases share one discovery request, while each cancellation
    // affects only its own waiter. Completed results survive another call.
    const delivered: SerperOrganicItem[] = [{ link: 'https://company.test/' }];
    const paidSearch = deferred<typeof delivered>();
    let cachedItems: typeof delivered | null = null;
    const readCache = jest.fn(async () => cachedItems);
    const writeCache = jest.fn(async (_query: string, items: typeof delivered) => { cachedItems = items; });
    const search = jest.fn((_query: string, _signal?: AbortSignal) => paidSearch.promise);
    const cachedSearch = createVeCachedSearch({ read: readCache, write: writeCache, search });
    const cancelledBase = new AbortController();
    const firstWaiter = expect(cachedSearch('  COMPANY  ', cancelledBase.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const otherWaiters = Array.from({ length: 12 }, () => cachedSearch('company'));
    await jest.advanceTimersByTimeAsync(0);
    expect(search).toHaveBeenCalledTimes(1);
    cancelledBase.abort();
    await firstWaiter;
    expect(search.mock.calls[0][1]?.aborted).toBe(false);
    paidSearch.resolve(delivered);
    expect(await Promise.all(otherWaiters)).toEqual(Array.from({ length: 12 }, () => delivered));
    expect(writeCache).toHaveBeenCalledTimes(1);
    const fromCache = await cachedSearch('company');
    fromCache[0].link = 'https://changed.test/';
    expect((await cachedSearch('company'))[0].link).toBe('https://company.test/');
    expect(search).toHaveBeenCalledTimes(1);
    expect(readCache).toHaveBeenCalledTimes(3);

    // Successful empty results are reusable; provider failures are not.
    cachedItems = null;
    search.mockRejectedValueOnce(new VeSearchProviderError('transient'));
    await expect(cachedSearch('different')).rejects.toThrow('Serper transient');
    expect(cachedItems).toBeNull();
    search.mockResolvedValueOnce([]);
    expect(await cachedSearch('different')).toEqual([]);
    expect(await cachedSearch('different')).toEqual([]);
    expect(search).toHaveBeenCalledTimes(3);
    const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
    const before = readCache.mock.calls.length;
    await expect(cachedSearch('different', alreadyCancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(readCache).toHaveBeenCalledTimes(before);

    cachedItems = null;
    const lastWaiter = new AbortController();
    search.mockImplementationOnce((_query, signal) => new Promise((_, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
    }));
    const abandoned = expect(cachedSearch('abandoned', lastWaiter.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(0);
    lastWaiter.abort(); await abandoned;
    expect(search.mock.calls.at(-1)?.[1]?.aborted).toBe(true);
    search.mockResolvedValueOnce(delivered);
    expect(await cachedSearch('abandoned')).toEqual(delivered);
    const now = Date.now();
    const record = (items: unknown, age: number) => ({ results: items, created_at: new Date(now - age).toISOString() });
    expect(freshVeSearchCacheItems(record([], VE_EMPTY_SEARCH_CACHE_TTL_MS - 1), now)).toEqual([]);
    expect(freshVeSearchCacheItems(record([], VE_EMPTY_SEARCH_CACHE_TTL_MS), now)).toBeNull();
    expect(freshVeSearchCacheItems(record(delivered, VE_SEARCH_CACHE_TTL_MS - 1), now)).toEqual(delivered);
    expect(freshVeSearchCacheItems(record(delivered, VE_SEARCH_CACHE_TTL_MS), now)).toBeNull();
    expect(freshVeSearchCacheItems(record(delivered, -1), now)).toBeNull();
    expect(freshVeSearchCacheItems(record([{}], 0), now)).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('cancels backoff immediately and never starts a retry or a pre-cancelled request', async () => {
    const parent = new AbortController();
    setVeActiveJobSignal(parent.signal);
    const fetchMock = jest.fn().mockResolvedValue(httpResponse(502, {}));
    global.fetch = fetchMock as unknown as typeof fetch;
    let failure: unknown;
    void callLLMWithSchema([{ role: 'user', content: 'json' }], schema, { model: 'test-model' })
      .catch((error) => { failure = error; });
    await jest.advanceTimersByTimeAsync(0);
    parent.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(failure).toEqual(expect.objectContaining({ name: 'AbortError' }));
    await jest.advanceTimersByTimeAsync(14_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(callLLMText([], { model: 'test-model' })).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);

    // Deployment yields after the reserved paid review has saved its result,
    // never between reserving that review and actually sending its request.
    setVeActiveJobSignal(null);
    const abort = new AbortController();
    const shutdown = createVeJobShutdown({ abort, graceMs: 240_000, onDeadline: jest.fn() });
    const description = 'Manufactures industrial equipment';
    fetchMock.mockReset()
      .mockResolvedValueOnce(httpResponse(200, { choices: [{ message: { content: JSON.stringify({ decisions: [
        { i: 0, status: 'relevant', reason: 'Manufactures equipment', evidence: [{ field: 'description', quote: description }] },
      ] }) } }] }))
      .mockResolvedValueOnce(httpResponse(200, { choices: [{ message: { content: JSON.stringify({ reviews: [
        { i: 0, result: 'direct_match', reason: 'Manufactures industrial equipment' },
      ] }) } }] }));
    const input = { rows: [{ company: 'Factory', inn: '7700000001', description }], verticalName: 'Equipment', language: 'en' as const };
    let saved: VeRelevanceCheckpoint | undefined;
    await expect(findIrrelevantRows({ ...input, signal: abort.signal, onCheckpoint: async (checkpoint, options) => {
      saved = JSON.parse(JSON.stringify(checkpoint)) as VeRelevanceCheckpoint;
      if (options?.canYield === false) shutdown.request();
      else shutdown.checkpoint();
    } })).rejects.toMatchObject({ name: 'VeWorkerShutdownError' });
    shutdown.stop();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Object.values(saved!.semantic_reviews)).toEqual([expect.objectContaining({ status: 'finished' })]);
    const resumed = await findIrrelevantRows({ ...input, checkpoint: saved });
    expect(resumed.decisions.get(0)?.status).toBe('relevant');
    expect(resumed.coverage.complete).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const requests = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(requests.map((request) => request.model)).toEqual(['openai/gpt-4o-mini', 'openai/gpt-5-mini']);
    expect(requests.map((request) => request.response_format.type)).toEqual(['json_schema', 'json_schema']);
    expect(requests[0].reasoning_effort).toBeUndefined();
    expect(requests[1].reasoning_effort).toBeUndefined();
    // Forward rollout and rollback both retain paid evidence and terminal
    // decisions; a changed target still invalidates them in the normal path.
    process.env.VE_MODEL_GATE = 'openai/gpt-4o-mini';
    process.env.VE_MODEL_RELEVANCE_REVIEW = 'openai/gpt-5-mini';
    const oldModelReplay = await findIrrelevantRows({ ...input, checkpoint: saved });
    expect(oldModelReplay.decisions.get(0)?.status).toBe('relevant');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    delete process.env.VE_MODEL_GATE;
    delete process.env.VE_MODEL_RELEVANCE_REVIEW;
    await findIrrelevantRows({ ...input, checkpoint: oldModelReplay.checkpoint });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    process.env.VE_MODEL_GATE = 'openai/gpt-4o-mini';
    process.env.VE_MODEL_RELEVANCE_REVIEW = 'openai/gpt-5-mini';

    // A malformed semantic response used to poison the entire durable preview.
    // Recover legacy failed/interrupted reservations once, then quarantine only
    // that company; never pay a third time or promote its unconfirmed proposal.
    const reply = (data: unknown) => httpResponse(200, { choices: [{ message: { content: JSON.stringify(data) } }] });
    const classification = reply({ decisions: [{ i: 0, status: 'relevant', reason: 'Makes equipment',
      evidence: [{ field: 'description', quote: description }] }] });
    const confirmation = reply({ reviews: [{ i: 0, result: 'direct_match', reason: description }] });
    // Admission/contradiction gets one durably reserved GPT check. Missing facts do not
    // trigger a costly second opinion and are never turned into acceptance.
    const noWebsite = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'offline' });
    delete process.env.VE_MODEL_GATE;
    delete process.env.VE_MODEL_RELEVANCE_REVIEW;
    for (const firstResult of ['direct_match', 'direct_conflict', 'insufficient'] as const) {
      fetchMock.mockReset().mockResolvedValueOnce(classification)
        .mockResolvedValueOnce(reply({ reviews: [{ i: 0, result: firstResult, reason: 'Unconfirmed activity' }] }))
        .mockResolvedValueOnce(confirmation);
      let confirmationCheckpoint: VeRelevanceCheckpoint | undefined;
      const checked = await findIrrelevantRows({ ...input, fetchEvidence: noWebsite, onCheckpoint: async (checkpoint) => {
        if (Object.values(checkpoint.semantic_reviews).some((review) => review.status === 'pending' && review.attempts === 1 && review.result)) {
          confirmationCheckpoint = JSON.parse(JSON.stringify(checkpoint)) as VeRelevanceCheckpoint;
        }
      } });
      const models = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).model);
      expect(models).toEqual(firstResult !== 'insufficient'
        ? [VE_COLLECTION_MODEL, VE_COLLECTION_MODEL, 'openai/gpt-5-mini'] : [VE_COLLECTION_MODEL, VE_COLLECTION_MODEL]);
      expect(checked.decisions.get(0)?.status).toBe(firstResult !== 'insufficient' ? 'relevant' : 'needs_review');
      expect(fetchMock.mock.calls.slice(0, 2).map((call) => JSON.parse(call[1].body).response_format.type))
        .toEqual(['json_schema', 'json_schema']);
      await findIrrelevantRows({ ...input, fetchEvidence: noWebsite, checkpoint: checked.checkpoint });
      expect(fetchMock).toHaveBeenCalledTimes(models.length);
      if (confirmationCheckpoint) {
        fetchMock.mockReset().mockResolvedValueOnce(confirmation);
        const recovered = await findIrrelevantRows({ ...input, fetchEvidence: noWebsite, checkpoint: confirmationCheckpoint });
        expect(recovered.decisions.get(0)?.status).toBe('relevant');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('openai/gpt-5-mini');
      }
    }
    const pair = { ...input, rows: [...input.rows, { company: 'Second factory', inn: '7700000002', description }] };
    const pairReview = reply({ reviews: [0, 1].map((i) => ({ i, result: 'direct_match', reason: description })) });
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [0, 1].map((i) => ({
      i, status: 'relevant', reason: 'Makes equipment', evidence: [{ field: 'description', quote: description }],
    })) })).mockResolvedValueOnce(pairReview).mockResolvedValueOnce(pairReview);
    const confirmedPair = await findIrrelevantRows(pair);
    expect([...confirmedPair.decisions.values()].map((item) => item.status)).toEqual(['relevant', 'relevant']);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).model))
      .toEqual([VE_COLLECTION_MODEL, VE_COLLECTION_MODEL, 'openai/gpt-5-mini']);
    process.env.VE_MODEL_GATE = 'openai/gpt-4o-mini';
    process.env.VE_MODEL_RELEVANCE_REVIEW = 'openai/gpt-5-mini';
    const expanded = { ...input, rows: [...input.rows, { company: 'Second factory', inn: '7700000002', description }] };
    for (const outcome of ['success', 'malformed', 'interrupted', 'exhausted', 'transport', 'billing'] as const) {
      const legacy = JSON.parse(JSON.stringify(saved)) as VeRelevanceCheckpoint;
      const review = Object.values(legacy.semantic_reviews)[0];
      review.status = ['interrupted', 'exhausted'].includes(outcome) ? 'started' : 'failed';
      review.failure_code = 'invalid_response';
      delete review.result; delete review.attempts;
      if (outcome === 'exhausted') review.attempts = 2;
      fetchMock.mockReset();
      if (outcome === 'billing') fetchMock.mockResolvedValueOnce(httpResponse(402, {}));
      else if (outcome === 'transport') fetchMock.mockRejectedValueOnce(new Error('fetch failed'));
      else if (outcome !== 'exhausted') fetchMock.mockResolvedValueOnce(outcome === 'malformed' ? reply({ reviews: [] }) : confirmation);
      fetchMock.mockResolvedValueOnce(classification).mockResolvedValueOnce(confirmation);
      let checked = await findIrrelevantRows({ ...expanded, checkpoint: legacy });
      if (outcome === 'billing') {
        expect(checked.error).toContain('Requesty 402');
        expect(checked.retryable).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        continue;
      }
      if (outcome === 'transport') {
        expect(checked.retryable).toBe(true);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        checked = await findIrrelevantRows({ ...expanded, checkpoint: checked.checkpoint });
      }
      expect(checked.error).toBeUndefined();
      expect(checked.coverage.complete).toBe(true);
      expect(checked.decisions.get(0)?.status).toBe(['malformed', 'transport', 'exhausted'].includes(outcome) ? 'needs_review' : 'relevant');
      expect(checked.decisions.get(1)?.status).toBe('relevant');
      expect(fetchMock).toHaveBeenCalledTimes(outcome === 'exhausted' ? 2 : 3);
      expect(Object.values(checked.checkpoint.semantic_reviews).find((item) => item.company_key === review.company_key)?.attempts).toBe(2);
      await findIrrelevantRows({ ...expanded, checkpoint: checked.checkpoint });
      expect(fetchMock).toHaveBeenCalledTimes(outcome === 'exhausted' ? 2 : 3);
    }

    // Fresh invalid batches split into isolated retries without replaying the
    // initial classifier, including when only one sibling remains malformed.
    delete process.env.VE_MODEL_GATE;
    delete process.env.VE_MODEL_RELEVANCE_REVIEW;
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [0, 1].map((i) => ({
      i, status: 'relevant', reason: 'Makes equipment', evidence: [{ field: 'description', quote: description }],
    })) })).mockResolvedValueOnce(reply({ reviews: [] }))
      .mockResolvedValueOnce(reply({ reviews: [] })).mockResolvedValueOnce(confirmation);
    const isolated = await findIrrelevantRows(expanded);
    expect(isolated.error).toBeUndefined();
    expect([...isolated.decisions.values()].map((item) => item.status)).toEqual(['needs_review', 'relevant']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(Object.values(isolated.checkpoint.semantic_reviews).map((item) => item.attempts)).toEqual([2, 2]);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body).model)).toEqual([
      VE_COLLECTION_MODEL, VE_COLLECTION_MODEL, 'openai/gpt-5-mini', 'openai/gpt-5-mini',
    ]);
    await findIrrelevantRows({ ...expanded, checkpoint: isolated.checkpoint });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(needsVeRelevanceEvidence({ ...input.rows[0], _email_status: 'ok', _ve_relevance: isolated.decisions.get(0) })).toBe(false);
    process.env.VE_MODEL_GATE = 'openai/gpt-4o-mini';
    process.env.VE_MODEL_RELEVANCE_REVIEW = 'openai/gpt-5-mini';

    // Malformed classifier output isolates one company instead of failing all
    // siblings. Unsupported output is saved, never admitted or repaid on retry.
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [] }))
      .mockResolvedValueOnce(reply({ decisions: [] }))
      .mockResolvedValueOnce(reply({ decisions: [] }))
      .mockResolvedValueOnce(classification).mockResolvedValueOnce(confirmation);
    const malformedInput = { ...expanded, fetchEvidence: jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'offline' }) };
    const repairedBatch = await findIrrelevantRows(malformedInput);
    expect(repairedBatch.error).toBeUndefined();
    expect([...repairedBatch.decisions.values()].map((item) => item.status)).toEqual(['needs_review', 'relevant']);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    await findIrrelevantRows({ ...malformedInput, checkpoint: repairedBatch.checkpoint });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    fetchMock.mockReset().mockResolvedValue(reply({ decisions: [] }));
    const outage = await findIrrelevantRows({ ...malformedInput, rows: Array.from({ length: 30 }, (_, i) => ({ company: `Factory ${i}`, description })) });
    expect(outage.error).toContain('invalid_response');
    expect(outage.coverage.complete).toBe(false);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(8);

    // Citation selection has one unambiguous field, constrained at the provider
    // AND locally. Empty IDs abstain; duplicates/unknown IDs stay quarantined.
    for (const selected of [[0], [], [999], [0, 0]]) {
      fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'needs_review', reason: 'Need facts', evidence: [] }] }))
        .mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'relevant', reason: 'Makes equipment', evidence_ids: [] }] }))
        .mockResolvedValueOnce(reply({ evidence_ids: selected }));
      if (selected.length === 1 && selected[0] === 0) fetchMock.mockResolvedValueOnce(confirmation);
      const citationInput = { ...input, fetchEvidence: jest.fn().mockResolvedValue({
        status: 'ok', text: description, url: 'https://factory.test/', reason: 'identity_verified_website',
      }) };
      const citations = await findIrrelevantRows(citationInput);
      expect(citations.error).toBeUndefined();
      expect(citations.decisions.get(0)?.status).toBe(selected.length === 1 && selected[0] === 0 ? 'relevant' : 'needs_review');
      const request = JSON.parse(fetchMock.mock.calls[2][1].body as string);
      expect(request.response_format).toMatchObject({ type: 'json_schema', json_schema: {
        strict: true, schema: { required: ['evidence_ids'], additionalProperties: false },
      } });
      const callCount = fetchMock.mock.calls.length;
      await findIrrelevantRows({ ...citationInput, checkpoint: citations.checkpoint });
      expect(fetchMock).toHaveBeenCalledTimes(callCount);
    }

    // A consumed citation attempt cannot be charged again or admitted after
    // a provider outage, but it must not permanently block other companies.
    for (const status of [429, 502, 402, 401]) {
      fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'needs_review', reason: 'Need facts', evidence: [] }] }))
        .mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'relevant', reason: 'Makes equipment', evidence_ids: [] }] }))
        .mockResolvedValueOnce(httpResponse(status, {}));
      const citationInput = { ...input, fetchEvidence: jest.fn().mockResolvedValue({
        status: 'ok', text: description, url: 'https://factory.test/', reason: 'identity_verified_website',
      }) };
      const failed = await findIrrelevantRows(citationInput);
      expect(failed.retryable).toBe(status === 429 || status === 502);
      expect(failed.decisions.get(0)?.status).toBe('error');
      const resumed = await findIrrelevantRows({ ...citationInput, checkpoint: failed.checkpoint });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      if (status === 429 || status === 502) {
        expect(resumed.error).toBeUndefined();
        expect(resumed.decisions.get(0)?.status).toBe('needs_review');
      } else {
        expect(resumed.error).toBeDefined();
        expect(resumed.decisions.get(0)?.status).toBe('error');
      }
    }

    // Old unavailable website checks get one pass through the improved reader,
    // without invalidating initial paid classifications or completed matches.
    const unavailable = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'website_evidence_timeout' });
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'needs_review', reason: 'More facts needed', evidence: [] }] }));
    const old = await findIrrelevantRows({ ...input, fetchEvidence: unavailable });
    expect(needsVeRelevanceEvidence({ ...input.rows[0], _email_status: 'ok', _ve_relevance: old.decisions.get(0) })).toBe(true);
    const timedOutAgain = await findIrrelevantRows({ ...input, checkpoint: structuredClone(old.checkpoint), fetchEvidence: unavailable });
    expect(needsVeRelevanceEvidence({ ...input.rows[0], _email_status: 'ok', _ve_relevance: timedOutAgain.decisions.get(0) })).toBe(false);
    await findIrrelevantRows({ ...input, checkpoint: timedOutAgain.checkpoint, fetchEvidence: unavailable });
    expect(unavailable).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const legacy = JSON.parse(JSON.stringify(old.checkpoint)) as VeRelevanceCheckpoint;
    Object.values(legacy.website_evidence).forEach((website) => { website.reader_revision = 3; website.review_attempt = 'f'.repeat(64); });
    Object.values(legacy.verdicts).forEach((verdict) => { verdict.website_review_version = 3; });
    const legacyRow = { ...input.rows[0], _email_status: 'ok', _ve_relevance: Object.values(legacy.verdicts)[0] };
    expect(needsVeRelevanceEvidence(legacyRow)).toBe(true);
    const websiteText = (description + '. 🏭 ').padEnd(5999, 'x') + '😀 tail\u0000\ud83d';
    const available = jest.fn().mockResolvedValue({ status: 'ok', text: websiteText, url: 'https://factory.test/', reason: 'identity_verified_website' });
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'relevant', reason: 'x'.repeat(399) + '😀', evidence_ids: [0] }] })).mockResolvedValueOnce(confirmation);
    const upgraded = await findIrrelevantRows({ ...input, rows: [legacyRow], checkpoint: legacy, fetchEvidence: available,
      onCheckpoint: async (checkpoint) => {
        expect(JSON.stringify(checkpoint)).not.toMatch(/\\u(?:0000|d[89a-f][0-9a-f]{2})/i);
        const pending = Object.values(checkpoint.website_evidence).find((item) => item.text);
        if (pending) expect(pending.text).toContain('🏭');
      },
    });
    expect(upgraded.decisions.get(0)?.status).toBe('relevant');
    expect(available).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await findIrrelevantRows({ ...input, rows: [legacyRow], checkpoint: upgraded.checkpoint, fetchEvidence: available });
    expect(available).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(jest.getTimerCount()).toBe(0);
    // Numbered excerpts are selected on the company's own bounded evidence;
    // the independent reviewer receives the exact text, never a model quote.
    const secondRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(secondRequest.messages[1].content).toContain('"excerpts"');
    const reviewRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(reviewRequest.messages[1].content).toContain(description);
    expect(reviewRequest.messages[1].content).not.toContain('"status":"relevant"');
    const sameBrand = { ...input, rows: ['Тула', 'Омск'].map((address) => ({ company: 'Домком', address })) };
    fetchMock.mockReset();
    const noSite = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'not_confirmed' });
    const separateCities = await findIrrelevantRows({ ...sameBrand, fetchEvidence: noSite });
    expect(Object.keys(separateCities.checkpoint.website_evidence)).toHaveLength(2);
    expect(noSite).toHaveBeenCalledTimes(2);
    await findIrrelevantRows({ ...sameBrand, checkpoint: separateCities.checkpoint, fetchEvidence: noSite });
    expect(noSite).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
    expect([...separateCities.decisions.values()].every((decision) => decision.status === 'needs_review')).toBe(true);

    // Postponing a paid search is neither a rejection nor a provider failure.
    // Resume only that evidence lookup once the ready-contact deficit requires it.
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'needs_review', reason: 'Need website evidence', evidence: [] }] }));
    const deferredEvidence = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '',
      reason: 'paid_search_deferred', search_deferred: true });
    const deferredSearch = await findIrrelevantRows({ ...input, allowPaidSearch: false, fetchEvidence: deferredEvidence });
    expect(deferredSearch.decisions.get(0)).toMatchObject({ status: 'needs_review', search_deferred: true });
    expect(deferredSearch.decisions.get(0)).not.toHaveProperty('website_review_version');
    expect(deferredSearch.retryable).toBe(false);
    expect(deferredSearch.coverage.complete).toBe(true);
    await findIrrelevantRows({ ...input, allowPaidSearch: false, checkpoint: structuredClone(deferredSearch.checkpoint), fetchEvidence: deferredEvidence });
    expect(deferredEvidence).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    deferredEvidence.mockResolvedValue({ status: 'ok', text: description, url: 'https://factory.test/', reason: 'identity_verified_website' });
    fetchMock.mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'relevant', reason: description, evidence_ids: [0] }] }))
      .mockResolvedValueOnce(confirmation);
    const resumedSearch = await findIrrelevantRows({ ...input, allowPaidSearch: true, checkpoint: deferredSearch.checkpoint, fetchEvidence: deferredEvidence });
    expect(deferredEvidence).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(resumedSearch.decisions.get(0)?.status).toBe('relevant');
    expect(resumedSearch.decisions.get(0)).not.toHaveProperty('search_deferred');

    // An intermittent search timeout cannot discard a successful sibling's
    // evidence or stop the next website batch. The failed subset retries alone.
    const networkRows = Array.from({ length: 10 }, (_, i) => ({ company: `Network ${i}`, inn: String(7700000000 + i), category: 'ОКВЭД 86.21' }));
    const networkInput = { ...input, rows: networkRows };
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'relevant', reason: description, evidence_ids: [0] }] }))
      .mockResolvedValueOnce(confirmation);
    const evidence = jest.fn(async (_url, options) => options?.companyInn === '7700000000'
      ? { status: 'error' as const, text: '', url: '', reason: 'timeout', provider_error: { kind: 'transient' as const, message: 'Serper transient: timeout.' } }
      : options?.companyInn === '7700000001'
        ? { status: 'ok' as const, text: description, url: 'https://factory.test/', reason: 'identity_verified_website' }
        : { status: 'unavailable' as const, text: '', url: '', reason: 'not_confirmed' });
    const partial = await findIrrelevantRows({ ...networkInput, fetchEvidence: evidence });
    expect(evidence).toHaveBeenCalledTimes(10);
    expect(partial.decisions.get(0)?.status).toBe('error');
    expect(partial.decisions.get(1)?.status).toBe('relevant');
    expect(partial.decisions.get(9)?.status).toBe('needs_review');
    expect(partial.retryable).toBe(true);
    expect(partial.coverage.complete).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    evidence.mockClear().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'not_confirmed' });
    const extraRows = Array.from({ length: 33 }, (_, i) => ({ company: `Extra ${i}`, inn: String(7710000000 + i) }));
    fetchMock.mockReset();
    const rotated = await findIrrelevantRows({ ...networkInput, rows: [...networkRows, ...extraRows], checkpoint: partial.checkpoint, fetchEvidence: evidence });
    expect(evidence).toHaveBeenCalledTimes(32);
    expect(evidence.mock.calls.every(([, options]) => options?.companyInn !== '7700000000')).toBe(true);
    expect(rotated.retryable).toBe(true);
    expect(rotated.decisions.get(0)?.status).toBe('error');
    expect(rotated.decisions.get(1)?.status).toBe('relevant');
    fetchMock.mockClear(); evidence.mockClear();
    await findIrrelevantRows({ ...networkInput, checkpoint: partial.checkpoint, fetchEvidence: evidence });
    expect(evidence).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();

    // Exhausting one company's search retries must release the rest of the
    // base. Replaying its checkpoint neither pays again nor admits that row.
    const exhaustedSearch = jest.fn().mockResolvedValue({ status: 'error', text: '', url: '', reason: 'timeout',
      provider_error: { kind: 'transient', message: 'Serper transient: timeout.' } });
    const failedSearchInput = { ...networkInput, rows: [networkRows[0]], fetchEvidence: exhaustedSearch };
    let failedSearch = await findIrrelevantRows(failedSearchInput);
    for (let attempt = 1; attempt < 3; attempt++) {
      failedSearch = await findIrrelevantRows({ ...failedSearchInput, checkpoint: failedSearch.checkpoint });
    }
    const releasedSearch = await findIrrelevantRows({ ...failedSearchInput, checkpoint: failedSearch.checkpoint });
    expect(exhaustedSearch).toHaveBeenCalledTimes(3);
    expect([releasedSearch.error, releasedSearch.retryable, releasedSearch.coverage.complete]).toEqual([undefined, false, true]);
    expect(releasedSearch.decisions.get(0)?.status).toBe('needs_review');
    expect(needsVeRelevanceEvidence({ ...networkRows[0], _email_status: 'ok', _ve_relevance: releasedSearch.decisions.get(0) })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    // A malformed-output storm backs off, then resumes only the remaining
    // companies. Already quarantined outputs are not re-purchased or admitted.
    fetchMock.mockReset().mockResolvedValue(reply({ decisions: [] }));
    const formatStormInput = { ...input, rows: Array.from({ length: 5 }, (_, i) => ({
      company: `Malformed ${i}`, inn: String(7730000000 + i), description,
    })), fetchEvidence: jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'not_confirmed' }) };
    const malformed = await findIrrelevantRows(formatStormInput);
    expect(malformed.retryable).toBe(true);
    expect(malformed.error).toContain('invalid_response');
    fetchMock.mockReset().mockResolvedValue(reply({ decisions: [{ i: 0, status: 'needs_review', reason: 'No proof', evidence: [] }] }));
    const afterMalformed = await findIrrelevantRows({ ...formatStormInput, checkpoint: malformed.checkpoint });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(afterMalformed.error).toBeUndefined();
    expect([...afterMalformed.decisions.values()].every((decision) => decision.status === 'needs_review')).toBe(true);

    const billingEvidence = jest.fn().mockResolvedValue({ status: 'error', text: '', url: '', reason: 'billing',
      provider_error: { kind: 'billing', message: 'Serper billing: insufficient search credits.' } });
    const billing = await findIrrelevantRows({ ...networkInput, fetchEvidence: billingEvidence });
    expect(billingEvidence).toHaveBeenCalledTimes(8);
    expect(billing.retryable).toBe(false);
    expect(billing.error).toContain('Serper billing:');
    expect([...billing.decisions.values()].some((decision) => decision.status === 'relevant')).toBe(false);
    expect(billing.errored.size).toBe(8);

    // A resume must not report an old billing/key refusal as a fresh outage.
    // More saved failures than the per-pass cap remain excluded and reviewable;
    // they recover before fresh candidates without repaying classification.
    for (const kind of ['billing', 'configuration'] as const) {
      const saved = structuredClone(billing.checkpoint);
      for (const item of Object.values(saved.website_evidence)) {
        item.provider_error = { kind, message: kind === 'billing'
          ? 'Serper billing: insufficient search credits.' : 'Serper configuration: invalid key.' };
        item.provider_error_attempts = 3;
        delete item.reader_revision;
      }
      fetchMock.mockReset();
      const resumeEvidence = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '',
        reason: 'paid_search_deferred', search_deferred: true });
      const cappedInput = { ...networkInput, rows: [...extraRows, ...networkRows], allowPaidSearch: false,
        websiteLimit: 1, fetchEvidence: resumeEvidence };
      let persisted: VeRelevanceCheckpoint | undefined;
      const capped = await findIrrelevantRows({ ...cappedInput, checkpoint: saved,
        onCheckpoint: async (checkpoint) => { persisted = structuredClone(checkpoint); } });
      expect(resumeEvidence).toHaveBeenCalledTimes(1);
      expect(resumeEvidence.mock.calls[0][1]).toMatchObject({ companyInn: '7700000000', allowPaidSearch: false });
      expect([capped.error, capped.retryable, capped.errored.size, capped.unchecked.size])
        .toEqual([undefined, false, 0, cappedInput.rows.length]);
      const remaining = capped.decisions.get(extraRows.length + 1)!;
      expect(remaining.status).toBe('needs_review');
      expect(needsVeRelevanceEvidence({ ...networkRows[1], _email_status: 'ok', _ve_relevance: remaining })).toBe(true);
      expect(Object.values(persisted!.website_evidence).filter((item) => item.provider_error)).toHaveLength(7);
      const resumed = await findIrrelevantRows({ ...cappedInput, checkpoint: persisted });
      expect(resumeEvidence.mock.calls[1][1]).toMatchObject({ companyInn: '7700000001', allowPaidSearch: false });
      expect(resumed.error).toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();

      // A new refusal still blocks, even after a previous per-company cap.
      const refused = await findIrrelevantRows({ ...networkInput, checkpoint: structuredClone(saved),
        fetchEvidence: billingEvidence });
      expect([refused.retryable, refused.coverage.complete, refused.error])
        .toEqual([false, false, 'Serper billing: insufficient search credits.']);
    }

    // Code-only inputs go directly to the same evidence reader. Small semantic
    // remainders share a batch and the final remainder is confirmed before return.
    const packedRows = Array.from({ length: 24 }, (_, i) => ({ company: `Factory ${i}`, inn: String(7720000000 + i), category: 'ОКВЭД 28.99' }));
    fetchMock.mockReset().mockImplementation(async (_url, init) => {
      const body = JSON.parse(init.body as string);
      if (body.response_format.json_schema.name === 've_relevance_review') {
        return reply({ reviews: Array.from({ length: 6 }, (_, i) => ({ i, result: 'direct_match', reason: description })) });
      }
      return reply({ decisions: Array.from({ length: 8 }, (_, i) => ({ i,
        status: i < 2 ? 'relevant' : 'needs_review', reason: description, evidence_ids: i < 2 ? [0] : [],
      })) });
    });
    const packedEvidence = jest.fn().mockResolvedValue({ status: 'ok', text: description, url: 'https://factory.test/', reason: 'identity_verified_website' });
    const packed = await findIrrelevantRows({ ...input, rows: packedRows, fetchEvidence: packedEvidence });
    expect(packed.error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4); // Three website classifications, one independent review.
    expect(packedEvidence).toHaveBeenCalledTimes(24);
    expect([...packed.decisions.values()].filter((decision) => decision.status === 'relevant')).toHaveLength(6);
    expect(Object.values(packed.checkpoint.semantic_reviews).every((review) => review.status === 'finished')).toBe(true);
    await findIrrelevantRows({ ...input, rows: packedRows, fetchEvidence: packedEvidence, checkpoint: packed.checkpoint });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(packedEvidence).toHaveBeenCalledTimes(24);
  });

  it('does not start website HTTP after a late DNS result, and aborts an active extraction', async () => {
    // Evidence lookups use cancellable DNS queries, not the OS lookup pool
    // shared with database/provider connections. One site's abort cannot
    // cancel a sibling, and mixed public/private answers never reach HTTP.
    const resolvers: Resolver[] = [];
    const answers = new Map<Resolver, (value: string[]) => void>();
    const rejects = new Map<Resolver, (reason: Error) => void>();
    const resolve4 = jest.spyOn(Resolver.prototype, 'resolve4').mockImplementation(function (this: Resolver) {
      resolvers.push(this);
      return new Promise<string[]>((resolve, reject) => { answers.set(this, resolve); rejects.set(this, reject); });
    });
    const resolverCancel = jest.spyOn(Resolver.prototype, 'cancel').mockImplementation(function (this: Resolver) {
      rejects.get(this)?.(new Error('queryA ECANCELLED'));
    });
    const abort = new AbortController();
    const cancelledLookup = resolveVeEvidenceAddress('slow.test', abort.signal);
    const cancelledAssertion = expect(cancelledLookup).rejects.toThrow('page expired');
    const sibling = resolveVeEvidenceAddress('good.test', new AbortController().signal);
    abort.abort(new Error('page expired'));
    await cancelledAssertion;
    expect(resolverCancel.mock.contexts).not.toContain(resolvers[1]);
    answers.get(resolvers[1])!(['93.184.216.34']);
    await expect(sibling).resolves.toBe('93.184.216.34');
    for (const addresses of [[], ['93.184.216.34', '127.0.0.1'], ['169.254.169.254'], ['10.0.0.1'], ['::1']]) {
      const pending = resolveVeEvidenceAddress('mixed.test', new AbortController().signal);
      answers.get(resolvers[resolvers.length - 1])!(addresses);
      await expect(pending).rejects.toThrow('website_address_unavailable');
    }
    const calls = resolve4.mock.calls.length;
    await expect(resolveVeEvidenceAddress('cancelled.test', abort.signal)).rejects.toThrow('page expired');
    expect(resolve4).toHaveBeenCalledTimes(calls);
    resolve4.mockRestore(); resolverCancel.mockRestore();

    const dns = deferred<void>();
    jest.mocked(assertPublicWebsite).mockReturnValueOnce(dns.promise);
    let failure: unknown;
    void defaultFetchText('https://example.org').catch((error) => { failure = error; });
    await jest.advanceTimersByTimeAsync(8000);
    expect(failure).toEqual(expect.objectContaining({ name: 'VeOperationTimeoutError' }));
    dns.resolve();
    await jest.advanceTimersByTimeAsync(0);
    expect(fetchAndExtract).not.toHaveBeenCalled();

    jest.mocked(assertPublicWebsite).mockResolvedValue(undefined);
    jest.mocked(fetchAndExtract).mockReturnValue(new Promise(() => {}));
    const parent = new AbortController();
    failure = undefined;
    void defaultFetchText('https://example.org', parent.signal).catch((error) => { failure = error; });
    await jest.advanceTimersByTimeAsync(0);
    parent.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(failure).toEqual(expect.objectContaining({ name: 'AbortError' }));
    expect(jest.mocked(fetchAndExtract).mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);

    // Name-only search is discovery, not identity proof. Brand AND original
    // geography must match on the site's own page; directory snippets cannot.
    for (const [brand, city, expected] of [['Домком', 'Тула', 'ok'], ['Другая компания', 'Тула', 'unavailable'], ['Домком', 'Омск', 'unavailable']]) {
      const found = await fetchVeRelevanceEvidence('mailto:wrong@elsewhere.test', {
        companyName: 'ООО Домком', companyAddress: 'Тула',
        search: async () => [{ link: 'https://hh.ru/employer/1' }, { link: 'https://domkom.test/' }],
        fetchPage: async (url) => {
          if (new URL(url).hostname !== 'domkom.test') throw new Error('Unexpected directory fetch');
          return parseVeEvidencePage(Buffer.from(`<title>${brand} — агентство недвижимости</title><main>Наш адрес: ${city}. Оказываем услуги по продаже недвижимости и подбору жилья покупателям.</main>`), url, 'text/html');
        },
      });
      expect(found.status).toBe(expected);
      if (expected === 'unavailable') expect(found.text).toBe('');
    }
    // Discovery is bounded, resumes without repaying successful siblings, and
    // provider failure does not erase already completed searches.
    const paidSearch = jest.fn().mockResolvedValue([]);
    const cacheSearch = jest.fn().mockResolvedValue(null);
    const freeOptions = { companyName: 'Домком', companyAddress: 'Тула', allowPaidSearch: false,
      search: paidSearch, searchCache: cacheSearch, fetchPage: async (url: string) => parseVeEvidencePage(Buffer.from(
        '<title>Домком — агентство недвижимости</title><main>Наш адрес: Тула. Продажа недвижимости и подбор жилья покупателям.</main>'), url, 'text/html') };
    expect(await fetchVeRelevanceEvidence('', freeOptions)).toMatchObject({ search_deferred: true, status: 'unavailable' });
    expect(paidSearch).not.toHaveBeenCalled();
    cacheSearch.mockResolvedValue([{ link: 'https://domkom.test/' }]);
    expect(await fetchVeRelevanceEvidence('', freeOptions)).toMatchObject({ status: 'ok' });
    expect(paidSearch).not.toHaveBeenCalled();
    const sourceRows = Array.from({ length: 18 }, (_, i) => ({ company: `Agency ${i}`, address: 'Тула',
      website: '', email: '', inn: '', source_detail: 'hh' }));
    let discoveryState: VeSourceContactCheckpoint | undefined;
    const findSite = jest.fn(async (_website: string, opts?: { companyName?: string }) => ({
      status: 'ok' as const, text: 'Verified own business', url: `https://agency-${opts?.companyName?.split(' ')[1]}.test/`, reason: 'discovered_verified_website',
    }));
    const save = async (state: VeSourceContactCheckpoint) => { discoveryState = structuredClone(state); };
    const firstDiscovery = await recoverVeSourceContacts({ rows: sourceRows, fetchEvidence: findSite, save });
    expect(firstDiscovery.waiting).toBe(true);
    expect(findSite).toHaveBeenCalledTimes(16);
    const finalDiscovery = await recoverVeSourceContacts({ rows: sourceRows, state: discoveryState, fetchEvidence: findSite, save });
    expect(finalDiscovery.waiting).toBe(false);
    expect(finalDiscovery.rows.every((row) => row.website && !row.email)).toBe(true);
    expect(hasPendingVeSourceContacts(sourceRows, discoveryState)).toBe(false);
    await recoverVeSourceContacts({ rows: sourceRows, state: discoveryState, fetchEvidence: findSite, save });
    expect(findSite).toHaveBeenCalledTimes(18);
    expect(sourceRows.every((row) => row.website === '')).toBe(true);
    const partial = jest.fn().mockResolvedValueOnce({ status: 'ok', text: 'Own business', url: 'https://first.test/', reason: 'verified' })
      .mockResolvedValueOnce({ status: 'error', text: '', url: '', reason: 'billing', provider_error: { kind: 'billing', message: 'Serper billing: no credits' } });
    await expect(recoverVeSourceContacts({ rows: sourceRows.slice(0, 2), fetchEvidence: partial, save })).rejects.toThrow('Serper billing');
    expect(Object.keys(discoveryState!.checked)).toHaveLength(1);
    // Completed lookups are a bounded cohort, not a claim about paid credits.
    // Restart/Continue or a drop and recovery of the same ready count cannot
    // purchase another cohort. Actual net growth permits further discovery.
    const initialBudget = evaluateVeSourceDiscoveryBudget({ readyRows: 23 }).budget;
    const checkedCohort: VeSourceContactCheckpoint = { version: 1, checked: Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [String(i), { website: '', reason: 'identity_unverified' }])) };
    const stopped = evaluateVeSourceDiscoveryBudget({ budget: initialBudget, checkpoint: checkedCohort, readyRows: 23 });
    expect(stopped).toMatchObject({ remaining: 0, budget: { paused: true, ready_high_water: 23 } });
    for (const readyRows of [10, 23]) expect(evaluateVeSourceDiscoveryBudget({
      budget: JSON.parse(JSON.stringify(stopped.budget)), checkpoint: checkedCohort, readyRows,
    }).remaining).toBe(0);
    expect(evaluateVeSourceDiscoveryBudget({ budget: stopped.budget, checkpoint: checkedCohort, readyRows: 24 }))
      .toMatchObject({ remaining: 200, budget: { paused: false, checked_at_growth: 200, ready_high_water: 24 } });
    expect(evaluateVeSourceDiscoveryBudget({ checkpoint: checkedCohort, readyRows: 23 }))
      .toMatchObject({ remaining: 200, budget: { checked_at_growth: 200 } });
    for (const budget of [null, { ...initialBudget, version: 2 }, { ...initialBudget, checked_at_growth: 201 }]) {
      expect(() => evaluateVeSourceDiscoveryBudget({ budget, checkpoint: checkedCohort, readyRows: 23 }))
        .toThrow('Source discovery budget checkpoint is invalid');
    }
    expect(jest.getTimerCount()).toBe(0);

    // Real progress includes successful/error IO, but never a still-pending await.
    const activity = jest.fn();
    const page = deferred<string>();
    const customFetch = jest.fn().mockReturnValueOnce(page.promise).mockRejectedValueOnce(new Error('source failed'));
    const customSearch = jest.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('search failed'));
    const ctx = { fetchText: customFetch, search: customSearch, onActivity: activity } as unknown as VeStageContext;
    const fetchText = resolveFetchText(ctx);
    const search = resolveSearch(ctx);
    const fetching = fetchText('https://example.org');
    await jest.advanceTimersByTimeAsync(1000);
    expect(activity).not.toHaveBeenCalled();
    page.resolve('page text');
    await expect(fetching).resolves.toBe('page text');
    expect(activity).toHaveBeenCalledTimes(1);
    await expect(fetchText('https://example.org')).rejects.toThrow('source failed');
    expect(activity).toHaveBeenCalledTimes(2);
    await expect(search('market')).resolves.toEqual([]);
    await expect(search('market')).rejects.toThrow('search failed');
    expect(activity).toHaveBeenCalledTimes(4);

    // Use the actual HTML parser and reader across industries. Facts live on
    // nested company/locations pages, behind a distracting product menu.
    for (const [focus, section, label, evidence] of [
      ['Сети частных клиник', 'branches', 'Наши филиалы', 'Сеть частных клиник объединяет три филиала в разных районах города. В каждом филиале ведут приём пациентов врачи нескольких специальностей.'],
      ['Industrial equipment manufacturers', 'manufacturing', 'Production facilities', 'Our production facilities manufacture industrial equipment in two factories. We design and build machinery for industrial customers.'],
      ['Розничные сети мебели', 'stores', 'Наши магазины', 'Наша розничная сеть мебели включает пять собственных магазинов. Адреса магазинов и часы работы опубликованы для покупателей.'],
    ]) {
      const origin = 'https://business.test';
      const html: Record<string, string> = {
        '/': `<main>Добро пожаловать на официальный сайт нашей компании. Здесь опубликованы сведения о деятельности и контактах.</main><nav>${Array.from({ length: 90 }, (_, i) => `<a href="/products/${i}">${focus}</a>`).join('')}<a href="/contacts">Контакты</a><a href="/company">О компании</a><a href="https://foreign.test/branches">${label}</a></nav>`,
        '/contacts': '<h1>Контакты</h1><p>Полные юридические реквизиты компании и адрес для обращений посетителей. ИНН 7700000001.</p>',
        '/company': `<h1>О компании</h1><p>Информация о структуре нашей компании, истории развития и подразделениях представлена в отдельных разделах.</p><a href="/company/${section}">${label}</a>`,
        [`/company/${section}`]: `<h1>${label}</h1><p>${evidence}</p>`,
      };
      const read = jest.fn(async (url: string) => {
        const body = html[new URL(url).pathname];
        if (!body || new URL(url).origin !== origin) throw new Error('website_content_unavailable');
        return parseVeEvidencePage(Buffer.from(body), url, 'text/html; charset=utf-8', focus);
      });
      const search = jest.fn().mockResolvedValue([]);
      const checked = await fetchVeRelevanceEvidence(origin, { companyInn: '7700000001', focus, fetchPage: read, search });
      expect(checked.status).toBe('ok');
      expect(checked.text).toContain(evidence);
      expect(checked.text).not.toContain(Array(3).fill(focus).join(' '));
      expect(search).not.toHaveBeenCalled();
      expect(read.mock.calls.every(([url]) => new URL(url).origin === origin)).toBe(true);
      expect(read.mock.calls.length).toBeLessThanOrEqual(10);

      // A real conflict discovered on a later page invalidates the entire
      // site's evidence; useful activity text cannot override wrong ownership.
      html[`/company/${section}`] += '<footer>ИНН 7700000002</footer>';
      const conflict = await fetchVeRelevanceEvidence(origin, { companyInn: '7700000001', focus, fetchPage: read, search });
      expect(conflict.status).toBe('unavailable');
      expect(conflict.text).toBe('');
    }

    // Share only dated public facts. Each new hypothesis reselects evidence
    // from the full document and still verifies legal ownership independently.
    const sharedRoot = 'https://shared.test/';
    const sharedKey = veCompanyFactKey({ inn: '7700000001' })!;
    const records: VeCompanyFactRecord[] = [];
    const readFacts = jest.fn(async () => records);
    const writeFacts = jest.fn(async (key: string, pages: ReturnType<typeof parseVeEvidencePage>[], observedAt: string) => {
      for (const page of pages) records.push({ company_key: key, page_key: veFactPageKey(page.url), reader_version: 1,
        observed_at: observedAt, expires_at: new Date(Date.parse(observedAt) + VE_COMPANY_FACT_TTL_MS).toISOString(), page });
    });
    const factsTransport = jest.fn(async (url: string) => parseVeEvidencePage(Buffer.from(
      '<main><p>Сеть частных клиник: три филиала принимают пациентов.</p>'
      + '<p>О компании и наших услугах для клиентов.</p>'.repeat(200)
      + '<p>Производство оборудования: собственный завод выпускает лабораторные приборы.</p></main><footer>ИНН 7700000001</footer>'), url, 'text/html'));
    const factsSearch = jest.fn().mockResolvedValue([]);
    const factsOptions = { companyInn: '7700000001', fetchPage: factsTransport, search: factsSearch,
      companyFacts: { read: readFacts, write: writeFacts } };
    expect((await fetchVeRelevanceEvidence(sharedRoot, { ...factsOptions, focus: 'Сеть частных клиник' })).status).toBe('ok');
    expect(records.length).toBeGreaterThan(0);
    expect(readFacts).toHaveBeenCalledWith([sharedKey], undefined);
    const requests = factsTransport.mock.calls.length;
    const firstObservation = records[0].observed_at;
    const secondHypothesis = await fetchVeRelevanceEvidence('', { ...factsOptions, focus: 'Производство оборудования собственный завод' });
    expect(secondHypothesis.status).toBe('ok');
    expect(secondHypothesis.text).toContain('собственный завод');
    expect(factsTransport).toHaveBeenCalledTimes(requests);
    expect(factsSearch).not.toHaveBeenCalled();
    expect(writeFacts).toHaveBeenCalledTimes(1);
    expect(records[0].observed_at).toBe(firstObservation);
    expect(freshVeCompanyFact(records[0], Date.parse(firstObservation) + VE_COMPANY_FACT_TTL_MS)).toBeNull();
    expect(freshVeCompanyFact({ ...records[0], reader_version: 99 })).toBeNull();
    expect(freshVeCompanyFact({ ...records[0], observed_at: new Date(Date.now() + 1000).toISOString() })).toBeNull();
    expect(veCompanyFactKey({ company: 'Same Brand' })).toBeNull();
    expect(veCompanyFactKey({ company: 'Same Brand', address: 'Москва' })).toBeNull();
    expect(veCompanyFactKey({ company: 'Same Brand', address: 'Москва, Ленина 10' })).not.toBe(veCompanyFactKey({ company: 'Same Brand', address: 'Тула, Ленина 10' }));
    const factPage = freshVeCompanyFact(records[0])!;
    expect(focusVeCompanyFact(factPage, 'Производство оборудования завод').text).toContain('лабораторные приборы');
    const wrongTransport = jest.fn(async (url: string) => parseVeEvidencePage(Buffer.from(
      '<main>Мы выпускаем приборы для лабораторий и предоставляем подробную информацию о нашей деятельности.</main><footer>ИНН 7700000002</footer>'), url, 'text/html'));
    const writtenBefore = writeFacts.mock.calls.length;
    expect((await fetchVeRelevanceEvidence('https://different.test/', { ...factsOptions, companyInn: '7700000003', fetchPage: wrongTransport })).status)
      .toBe('unavailable');
    expect(writeFacts).toHaveBeenCalledTimes(writtenBefore);

    const sharedPage = deferred<ReturnType<typeof parseVeEvidencePage>>();
    const transport = jest.fn().mockReturnValue(sharedPage.promise);
    const sharedRead = createVeSharedPageReader(transport);
    const leave = new AbortController(), stay = new AbortController();
    const cancelledRead = expect(sharedRead(new URL(sharedRoot), leave.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const remainingRead = sharedRead(new URL(sharedRoot), stay.signal);
    leave.abort();
    await cancelledRead;
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][1].aborted).toBe(false);
    sharedPage.resolve(factPage);
    const isolatedPage = await remainingRead;
    isolatedPage.text = 'changed by one hypothesis';
    expect(factPage.text).not.toBe(isolatedPage.text);
    const finalCancel = new AbortController();
    transport.mockImplementation((_url, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))));
    const abandonedRead = expect(sharedRead(new URL('https://abandoned.test'), finalCancel.signal)).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(0);
    finalCancel.abort(); await abandonedRead;
    expect(transport.mock.calls.at(-1)?.[1].aborted).toBe(true);
    const immediateCancel = new AbortController();
    const neverStarted = jest.fn();
    const immediateRead = expect(createVeSharedPageReader(neverStarted)(new URL(sharedRoot), immediateCancel.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
    immediateCancel.abort(); await immediateRead;
    expect(neverStarted).not.toHaveBeenCalled();

    const root = 'https://retry.test/';
    const source = '<main>Мы производим промышленное оборудование на собственном заводе и поставляем его клиентам по всей стране.</main><footer>ИНН 7700000001</footer>';
    const signals: AbortSignal[] = [];
    const retryRead = jest.fn(async (url: string, signal: AbortSignal) => {
      if (url !== root) throw new Error('website_content_unavailable');
      signals.push(signal);
      if (signals.length === 1) return new Promise<never>(() => {});
      return parseVeEvidencePage(Buffer.from(source), url, 'text/html');
    });
    const retried = fetchVeRelevanceEvidence(root, { companyInn: '7700000001', fetchPage: retryRead, search: async () => [] });
    await jest.advanceTimersByTimeAsync(5_001);
    expect((await retried).status).toBe('ok');
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);

    const stalled = jest.fn(() => new Promise<never>(() => {}));
    const bounded = fetchVeRelevanceEvidence(root, { companyInn: '7700000001', fetchPage: stalled,
      search: async () => [1, 2, 3].map((i) => ({ link: `https://candidate${i}.test/` })) });
    await jest.advanceTimersByTimeAsync(120_001);
    expect((await bounded).status).toBe('unavailable');
    expect(stalled.mock.calls.length).toBeLessThanOrEqual(12);
    // A queued/injected search deadline remains a provider failure, not a
    // completed empty website result that would permanently consume the review.
    const stalledSearch = fetchVeRelevanceEvidence('', { companyInn: '7700000001', search: stalled });
    await jest.advanceTimersByTimeAsync(90_001);
    expect((await stalledSearch).provider_error).toEqual({ kind: 'transient', message: 'Serper transient: timeout.' });
    const cancel = new AbortController();
    const cancelled = fetchVeRelevanceEvidence(root, { signal: cancel.signal, fetchPage: stalled });
    const cancellation = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    await jest.advanceTimersByTimeAsync(0);
    const beforeCancel = stalled.mock.calls.length;
    cancel.abort();
    await cancellation;
    await jest.advanceTimersByTimeAsync(40_001);
    expect(stalled.mock.calls.length).toBe(beforeCancel);
    expect(jest.getTimerCount()).toBe(0);
  });
});
