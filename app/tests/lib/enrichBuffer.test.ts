/**
 * @jest-environment node
 *
 * enrichBuffer.ts — producer/consumer API для coordinator-pattern буфера.
 * Тестируется чистая часть (planFlush) + producer-смысл через лёгкий mock.
 *
 * planFlush — самая важная для корректности часть: она группирует drained
 * rows в три side-effect'а (queue UPDATE, cache UPSERT, jobs counter inc).
 * Любой баг тут = расхождение прогресса в UI / double-counting / залипший
 * cache. Тестируется без БД.
 */

import {
  planFlush,
  writeEnrichResult,
  type EnrichBufferDrainedRow,
} from '@/lib/enrich/enrichBuffer';

// ─── planFlush — чистая логика группировки ──────────────────────────────────

function mkRow(over: Partial<EnrichBufferDrainedRow>): EnrichBufferDrainedRow {
  return {
    id: 1,
    queue_id: 'q-1',
    job_id: 'j-1',
    status: 'completed',
    result_text: 'hello',
    last_error: null,
    cache_url_normalized: 'https://example.com',
    cache_source_url: 'https://example.com/about',
    attempt_count: 1,
    ...over,
  };
}

describe('enrichBuffer.planFlush', () => {
  it('queue UPDATE one entry per drained row (except cache_only)', () => {
    const rows = [
      mkRow({ id: 1, queue_id: 'q-1', status: 'completed' }),
      mkRow({ id: 2, queue_id: 'q-2', status: 'failed', result_text: null, last_error: 'boom' }),
      mkRow({ id: 3, queue_id: 'q-3', status: 'skipped', result_text: null, last_error: 'no-html' }),
      mkRow({ id: 4, queue_id: 'q-4', status: 'cache_only' }),
    ];
    const p = planFlush(rows);
    expect(p.queueUpdates.length).toBe(3); // cache_only skipped
    expect(p.queueUpdates.map((u) => u.queue_id).sort()).toEqual(['q-1', 'q-2', 'q-3']);
  });

  it('completed row stores result_text and nullifies last_error', () => {
    const p = planFlush([mkRow({ status: 'completed', result_text: 'hi', last_error: 'old' })]);
    expect(p.queueUpdates[0]).toEqual(
      expect.objectContaining({ status: 'completed', result_text: 'hi', last_error: null }),
    );
  });

  it('failed/skipped row stores last_error and nullifies result_text', () => {
    const p = planFlush([
      mkRow({ id: 1, queue_id: 'q-1', status: 'failed', result_text: 'partial', last_error: 'err' }),
      mkRow({ id: 2, queue_id: 'q-2', status: 'skipped', result_text: 'partial', last_error: 'too small' }),
    ]);
    expect(p.queueUpdates[0]).toEqual(
      expect.objectContaining({ status: 'failed', result_text: null, last_error: 'err' }),
    );
    expect(p.queueUpdates[1]).toEqual(
      expect.objectContaining({ status: 'skipped', result_text: null, last_error: 'too small' }),
    );
  });

  it('jobs counter: processed += rows, success += completed, error += failed (skipped is neither)', () => {
    const rows = [
      mkRow({ id: 1, status: 'completed' }),
      mkRow({ id: 2, status: 'completed' }),
      mkRow({ id: 3, status: 'failed' }),
      mkRow({ id: 4, status: 'skipped' }),
      mkRow({ id: 5, status: 'cache_only' }), // ignored
    ];
    const p = planFlush(rows);
    expect(p.jobsProcessedInc.get('j-1')).toEqual({ processed: 4, success: 2, error: 1 });
  });

  it('jobs counter: independent per job_id', () => {
    const rows = [
      mkRow({ id: 1, job_id: 'jobA', status: 'completed' }),
      mkRow({ id: 2, job_id: 'jobB', status: 'failed' }),
      mkRow({ id: 3, job_id: 'jobA', status: 'completed' }),
    ];
    const p = planFlush(rows);
    expect(p.jobsProcessedInc.get('jobA')).toEqual({ processed: 2, success: 2, error: 0 });
    expect(p.jobsProcessedInc.get('jobB')).toEqual({ processed: 1, success: 0, error: 1 });
  });

  it('cache UPSERT only for rows with cache_url_normalized', () => {
    const rows = [
      mkRow({ id: 1, cache_url_normalized: 'https://a' }),
      mkRow({ id: 2, cache_url_normalized: null }),
      mkRow({ id: 3, cache_url_normalized: 'https://b' }),
    ];
    const p = planFlush(rows);
    expect(p.cacheUpserts.map((c) => c.url_normalized)).toEqual(['https://a', 'https://b']);
  });

  it('cache row: completed → text set, last_error=null; failed → text from buffer (null typically), last_error set', () => {
    const p = planFlush([
      mkRow({ id: 1, status: 'completed', result_text: 'got text', cache_url_normalized: 'u1', last_error: null }),
      mkRow({ id: 2, status: 'failed', result_text: null, cache_url_normalized: 'u2', last_error: 'oops' }),
    ]);
    expect(p.cacheUpserts[0]).toEqual(
      expect.objectContaining({ url_normalized: 'u1', text: 'got text', last_error: null }),
    );
    expect(p.cacheUpserts[1]).toEqual(
      expect.objectContaining({ url_normalized: 'u2', text: null, last_error: 'oops' }),
    );
  });

  it('cache_only row updates cache but NOT queue/jobs counter', () => {
    const rows = [
      mkRow({ id: 1, status: 'cache_only', cache_url_normalized: 'https://x', result_text: 'side-effect cache' }),
    ];
    const p = planFlush(rows);
    expect(p.queueUpdates).toHaveLength(0);
    expect(p.jobsProcessedInc.size).toBe(0);
    expect(p.cacheUpserts).toHaveLength(1);
    expect(p.cacheUpserts[0].text).toBe('side-effect cache');
  });

  it('empty input → empty plan', () => {
    const p = planFlush([]);
    expect(p.queueUpdates).toHaveLength(0);
    expect(p.cacheUpserts).toHaveLength(0);
    expect(p.jobsProcessedInc.size).toBe(0);
  });
});

// ─── writeEnrichResult — producer side-effect & error path ─────────────────

describe('enrichBuffer.writeEnrichResult', () => {
  it('inserts one row with denormalized cache + queue fields', async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const fakeDb = {
      from: (table: string) => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, ...row });
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as Parameters<typeof writeEnrichResult>[0];

    const r = await writeEnrichResult(fakeDb, {
      queue_id: 'q-1',
      job_id: 'j-1',
      status: 'completed',
      result_text: 'hi',
      cache_url_normalized: 'https://x',
      cache_source_url: 'https://x/about',
      attempt_count: 2,
    });

    expect(r).toEqual({ ok: true });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toEqual(
      expect.objectContaining({
        table: 'website_enrichment_results_buffer',
        queue_id: 'q-1',
        job_id: 'j-1',
        status: 'completed',
        result_text: 'hi',
        cache_url_normalized: 'https://x',
        cache_source_url: 'https://x/about',
        attempt_count: 2,
      }),
    );
  });

  it('returns {ok:false, error} on DB error (does not throw)', async () => {
    const fakeDb = {
      from: () => ({
        insert: () => Promise.resolve({ error: { message: 'unique violation' } }),
      }),
    } as unknown as Parameters<typeof writeEnrichResult>[0];

    const r = await writeEnrichResult(fakeDb, {
      queue_id: 'q-1',
      job_id: 'j-1',
      status: 'failed',
      last_error: 'boom',
    });
    expect(r).toEqual({ ok: false, error: 'unique violation' });
  });

  it('handles missing optional fields gracefully (no result_text/cache → nulls)', async () => {
    let captured: Record<string, unknown> | null = null;
    const fakeDb = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          captured = row;
          return Promise.resolve({ error: null });
        },
      }),
    } as unknown as Parameters<typeof writeEnrichResult>[0];

    await writeEnrichResult(fakeDb, { queue_id: 'q', job_id: 'j', status: 'skipped' });
    expect(captured).toEqual(
      expect.objectContaining({
        result_text: null,
        last_error: null,
        cache_url_normalized: null,
        cache_source_url: null,
        attempt_count: 1, // default
      }),
    );
  });
});
