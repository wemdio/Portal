/** @jest-environment node */

/**
 * Регрессия на транзиентный отказ провайдера (инцидент: стадия «Генерация
 * гипотез» падала на Requesty 502). rawCall обязан ретраить 408/425/429/5xx
 * с бэкоффом и НЕ ретраить постоянные 4xx.
 */

import { z } from 'zod';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import { withVeCostTelemetry } from '@/lib/verticalEngineV2/costTelemetry';
import { withProviderUsage } from '@/lib/providerUsage';
import { createVeSearchCapacity, searchVeRelevanceWebsites, VeSearchProviderError } from '@/lib/verticalEngineV2/relevanceSearch';

jest.mock('@/lib/clientDemo/personalize', () => ({ assertPublicWebsite: jest.fn() }));
jest.mock('@/lib/enrich/websiteParser', () => ({
  normalizeUrl: (url: string) => url,
  fetchAndExtract: jest.fn(),
}));

import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { fetchAndExtract } from '@/lib/enrich/websiteParser';
import { callLLMText, callLLMWithSchema, setVeActiveJobSignal, withVeActiveJobSignal, getVeActiveJobSignal } from '@/lib/verticalEngineV2/llm';
import { defaultFetchText, resolveFetchText, resolveSearch } from '@/lib/verticalEngineV2/stages/io';
import type { VeStageContext } from '@/lib/verticalEngineV2/stages/shared';
import { isRetryableStageError, maxAttemptsFor } from '@/lib/verticalEngineV2/jobRetry';
import { getVeCollectionFailure } from '@/lib/verticalEngineV2/collectionErrors';
import { findIrrelevantRows } from '@/lib/verticalEngineV2/relevanceGate';
import type { VeRelevanceCheckpoint } from '@/lib/verticalEngineV2/relevanceCheckpoint';
import { createVeJobShutdown } from '@/lib/verticalEngineV2/workerLiveness';
import { fetchVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceEvidence';
import { parseVeEvidencePage } from '@/lib/verticalEngineV2/relevancePage';
import { needsVeRelevanceEvidence } from '@/lib/verticalEngineV2/relevanceReserve';
import { recoverVeSourceContacts, hasPendingVeSourceContacts, type VeSourceContactCheckpoint } from '@/lib/verticalEngineV2/sourceContacts';

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
    for (const permanent of [false, true]) {
      const writes = new Map<string, number>();
      const upsert = jest.fn((row: { id: string; event: string }, options: unknown) => {
        expect(options).toEqual({ onConflict: 'id', ignoreDuplicates: true });
        const count = (writes.get(row.id) ?? 0) + 1;
        writes.set(row.id, count);
        return { abortSignal: async () => ({ error: count === 1 || (permanent && row.event === 'finished')
          ? { message: 'write response lost' } : null }) };
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
    }
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

    // A malformed semantic response used to poison the entire durable preview.
    // Recover legacy failed/interrupted reservations once, then quarantine only
    // that company; never pay a third time or promote its unconfirmed proposal.
    const reply = (data: unknown) => httpResponse(200, { choices: [{ message: { content: JSON.stringify(data) } }] });
    const classification = reply({ decisions: [{ i: 0, status: 'relevant', reason: 'Makes equipment',
      evidence: [{ field: 'description', quote: description }] }] });
    const confirmation = reply({ reviews: [{ i: 0, result: 'direct_match', reason: description }] });
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
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [0, 1].map((i) => ({
      i, status: 'relevant', reason: 'Makes equipment', evidence: [{ field: 'description', quote: description }],
    })) })).mockResolvedValueOnce(reply({ reviews: [] }))
      .mockResolvedValueOnce(reply({ reviews: [] })).mockResolvedValueOnce(confirmation);
    const isolated = await findIrrelevantRows(expanded);
    expect(isolated.error).toBeUndefined();
    expect([...isolated.decisions.values()].map((item) => item.status)).toEqual(['needs_review', 'relevant']);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(Object.values(isolated.checkpoint.semantic_reviews).map((item) => item.attempts)).toEqual([2, 2]);
    await findIrrelevantRows({ ...expanded, checkpoint: isolated.checkpoint });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(needsVeRelevanceEvidence({ ...input.rows[0], _email_status: 'ok', _ve_relevance: isolated.decisions.get(0) })).toBe(false);

    // Old unavailable website checks get one pass through the improved reader,
    // without invalidating initial paid classifications or completed matches.
    const unavailable = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'website_evidence_timeout' });
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'needs_review', reason: 'More facts needed', evidence: [] }] }));
    const old = await findIrrelevantRows({ ...input, fetchEvidence: unavailable });
    expect(needsVeRelevanceEvidence({ ...input.rows[0], _email_status: 'ok', _ve_relevance: old.decisions.get(0) })).toBe(false);
    await findIrrelevantRows({ ...input, checkpoint: old.checkpoint, fetchEvidence: unavailable });
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const legacy = JSON.parse(JSON.stringify(old.checkpoint)) as VeRelevanceCheckpoint;
    Object.values(legacy.website_evidence).forEach((website) => { delete website.reader_revision; website.review_attempt = 'f'.repeat(64); });
    Object.values(legacy.verdicts).forEach((verdict) => { delete verdict.website_review_version; });
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
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: [0, 1].map((i) => ({ i, status: 'needs_review', reason: 'Need own-site evidence', evidence: [] })) }));
    const noSite = jest.fn().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'not_confirmed' });
    const separateCities = await findIrrelevantRows({ ...sameBrand, fetchEvidence: noSite });
    expect(Object.keys(separateCities.checkpoint.website_evidence)).toHaveLength(2);
    expect(noSite).toHaveBeenCalledTimes(2);
    await findIrrelevantRows({ ...sameBrand, checkpoint: separateCities.checkpoint, fetchEvidence: noSite });
    expect(noSite).toHaveBeenCalledTimes(2);

    // An intermittent search timeout cannot discard a successful sibling's
    // evidence or stop the next website batch. The failed subset retries alone.
    const networkRows = Array.from({ length: 10 }, (_, i) => ({ company: `Network ${i}`, inn: String(7700000000 + i) }));
    const networkInput = { ...input, rows: networkRows };
    fetchMock.mockReset().mockResolvedValueOnce(reply({ decisions: networkRows.map((_row, i) => ({
      i, status: 'needs_review', reason: 'Need website evidence', evidence: [],
    })) })).mockResolvedValueOnce(reply({ decisions: [{ i: 0, status: 'relevant', reason: description, evidence_ids: [0] }] }))
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
    expect(fetchMock).toHaveBeenCalledTimes(3);
    evidence.mockClear().mockResolvedValue({ status: 'unavailable', text: '', url: '', reason: 'not_confirmed' });
    const extraRows = Array.from({ length: 33 }, (_, i) => ({ company: `Extra ${i}`, inn: String(7710000000 + i) }));
    fetchMock.mockReset();
    for (const size of [20, 13]) fetchMock.mockResolvedValueOnce(reply({ decisions: Array.from({ length: size }, (_, i) => ({
      i, status: 'needs_review', reason: 'Need website evidence', evidence: [],
    })) }));
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

    fetchMock.mockResolvedValueOnce(reply({ decisions: networkRows.map((_row, i) => ({
      i, status: 'needs_review', reason: 'Need website evidence', evidence: [],
    })) }));
    const billingEvidence = jest.fn().mockResolvedValue({ status: 'error', text: '', url: '', reason: 'billing',
      provider_error: { kind: 'billing', message: 'Serper billing: insufficient search credits.' } });
    const billing = await findIrrelevantRows({ ...networkInput, fetchEvidence: billingEvidence });
    expect(billingEvidence).toHaveBeenCalledTimes(8);
    expect(billing.retryable).toBe(false);
    expect(billing.error).toContain('Serper billing:');
    expect([...billing.decisions.values()].some((decision) => decision.status === 'relevant')).toBe(false);
    expect(billing.errored.size).toBe(8);
  });

  it('does not start website HTTP after a late DNS result, and aborts an active extraction', async () => {
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
