/** @jest-environment node */

/**
 * json_object-режим Requesty отклоняет запрос с 400, если ни одно сообщение не
 * содержит слова «json». Все промпты v2 формат упоминают, кроме досье (его
 * system собирается прямо в stages/dossier.ts) — стадия dossier падала на
 * каждом прогоне. Гейт живёт в llm.ts, а не в промпте: так защищён и любой
 * следующий инлайновый промпт.
 */

import { z } from 'zod';

import { callLLMWithSchema } from '@/lib/verticalEngineV2/llm';
import { runEvidenceStage } from '@/lib/verticalEngineV2/stages/evidence';
import { loadMarkupHistory, loadPortfolioProfile } from '@/lib/verticalEngineV2/stages/hypotheses';
import { createMockSupabase, type MockSupabaseSeed } from '@/../tests/helpers/mockSupabase';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import type { VeStageContext } from '@/lib/verticalEngineV2/stages/shared';
import { VeOperationTimeoutError } from '@/lib/verticalEngineV2/operationDeadline';

jest.mock('@/lib/verticalEngineV2/llm', () => {
  const actual = jest.requireActual('@/lib/verticalEngineV2/llm');
  return { ...actual, callLLMWithSchema: jest.fn(actual.callLLMWithSchema) };
});
jest.mock('@/lib/verticalEngineV2/stages/io', () => ({
  resolveSearch: (ctx: VeStageContext) => ctx.search,
  resolveFetchText: (ctx: VeStageContext) => ctx.fetchText,
}));
jest.mock('@/lib/verticalEngineV2/stages/hypotheses', () => ({
  loadPortfolioProfile: jest.fn(async () => []),
  loadMarkupHistory: jest.fn(async () => ({ accepted: ['prior'], rejected: [] })),
}));
jest.mock('@/lib/verticalEngineV2/scoreAnchor', () => ({
  anchorPotentialPct: jest.fn(async (pct: number) => ({ pct, applied: false })),
}));

const schema = z.object({ ok: z.boolean() });

function mockOk(payload: unknown) {
  return jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      choices: [{ message: { content: JSON.stringify(payload) } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
  });
}

function sentBody(fetchMock: jest.Mock): { messages: Array<{ role: string; content: string }>; response_format?: unknown } {
  return JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
}

describe('callLLMWithSchema — json_object guard', () => {
  const envBackup = { ...process.env };

  beforeEach(() => {
    process.env.OPENROUTER_HYPOTHESIS_ENGINE_API_KEY = 'test-key';
  });

  afterEach(() => {
    process.env = { ...envBackup };
    jest.restoreAllMocks();
  });

  it('injects a JSON instruction when the prompt never mentions the format', async () => {
    const fetchMock = mockOk({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    await callLLMWithSchema(
      [
        { role: 'system', content: 'Опиши сегмент по присланным счётчикам.' },
        { role: 'user', content: '{"counters":{"companies_total":10}}' },
      ],
      schema,
      { model: 'test-model' },
    );

    const body = sentBody(fetchMock);
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(JSON.stringify(body.messages)).toMatch(/json/i);
  });

  it('leaves prompts that already mention JSON untouched', async () => {
    const fetchMock = mockOk({ ok: true });
    global.fetch = fetchMock as unknown as typeof fetch;

    const messages = [
      { role: 'system' as const, content: 'Верни JSON строго по схеме.' },
      { role: 'user' as const, content: 'сегмент' },
    ];
    await callLLMWithSchema(messages, schema, { model: 'test-model' });

    expect(sentBody(fetchMock).messages).toEqual(messages);
  });
});

describe('evidence resumable candidate checkpoints', () => {
  afterEach(() => { jest.restoreAllMocks(); jest.clearAllMocks(); jest.useRealTimers(); });

  function fixture() {
    const candidates = ['A', 'B', 'C'].map((title) => ({
      tier: 1, title, description: title, fit_rationale: 'fit', rationale: '', potential_pct: 50, search_queries: [title],
    }));
    const job = { id: 'evidence-job', project_id: 'project', stage: 'evidence', status: 'running',
      result: { preserved: 'metadata' }, payload: {}, attempts: 1, tokens_used: 0, cost_usd: 0 } as unknown as VeJob;
    const errorUpdates: NonNullable<MockSupabaseSeed['errorUpdates']> = {};
    const db = createMockSupabase({ tables: {
      ve_projects: [{ id: 'project', market: 'ru', brief: { site_profile: { company_name: 'Client', product_summary: 'Product' } } }],
      ve_jobs: [job as unknown as Record<string, unknown>, { id: 'hypotheses-job', project_id: 'project', stage: 'hypotheses', status: 'done', result: { candidates } }],
    }, errorUpdates });
    const search = jest.fn(async (query: string) => [{ title: query, link: `https://source.test/${query[0]}` }]);
    const ctx = { supabase: db, market: 'ru', search, fetchText: jest.fn(async (url: string) => `verified source quote-${url.at(-1)}`) } as unknown as VeStageContext;
    const verdict = (title: string, merge = false) => ({
      data: { verdict: merge ? 'merge' : 'keep', merge_with_title: merge ? 'A' : null,
        fit_rationale: 'verified fit', potential_pct: 60, seasonality: null,
        evidence: [{ claim: title, source_url: `https://source.test/${title}`, quote: `verified source quote-${title}` }] },
      tokensUsed: 15, costUsd: 0.01, promptTokens: 10, completionTokens: 5, rawResponse: {},
    });
    return { db, job, ctx, candidates, search, verdict, errorUpdates };
  }

  it('resumes after cancellation with merged accepted evidence, fixed calibration, truthful progress and cumulative usage', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-04T20:00:00Z'));
    const f = fixture();
    const controller = new AbortController();
    const cancelled = new DOMException('stop evidence', 'AbortError');
    f.search.mockImplementation(async (query) => {
      if (query.startsWith('C')) { controller.abort(cancelled); throw cancelled; }
      return [{ title: query, link: `https://source.test/${query[0]}` }];
    });
    const llm = jest.mocked(callLLMWithSchema).mockReset().mockResolvedValueOnce(f.verdict('A')).mockResolvedValueOnce(f.verdict('B', true));
    await expect(runEvidenceStage(f.job, { ...f.ctx, signal: controller.signal })).rejects.toBe(cancelled);
    expect(llm.mock.calls[0][2]?.signal).toBe(controller.signal);
    const saved = f.db.getRows('ve_jobs').find((row) => row.id === f.job.id)!;
    expect(saved).toMatchObject({ tokens_used: 0, cost_usd: 0, progress: { done: 2, total: 3 }, result: {
      preserved: 'metadata', evidence_checkpoint: { version: 1, next_index: 2, merged: 1, dropped: 0,
        usage: { tokensUsed: 30, costUsd: 0.02 }, accepted: [{ title: 'A', evidence: [{ claim: 'A' }, { claim: 'B' }] }] },
    } });
    expect(f.db.getRows('ve_hypotheses')).toEqual([]);
    const previousCheckpoint = (saved.result as Record<string, unknown>).evidence_checkpoint;
    f.search.mockImplementation(async (query) => [{ title: query, link: `https://source.test/${query[0]}` }]);
    jest.setSystemTime(new Date('2026-09-05T20:00:00Z'));
    // Object key order is not an input change; a different date must retain calibration.
    await f.db.from('ve_projects').update({ brief: { site_profile: { product_summary: 'Product', company_name: 'Client' } } }).eq('id', 'project');
    for (const failure of [new VeOperationTimeoutError('LLM', 100), new Error('Requesty 502 provider unavailable')]) {
      llm.mockRejectedValueOnce(failure);
      await expect(runEvidenceStage(saved as unknown as VeJob, f.ctx)).rejects.toBe(failure);
      expect((f.db.getRows('ve_jobs').find((row) => row.id === f.job.id)!.result as Record<string, unknown>).evidence_checkpoint).toMatchObject({ next_index: 2, dropped: 0, usage: { tokensUsed: 30, costUsd: 0.02 } });
    }
    llm.mockResolvedValueOnce(f.verdict('C'));
    const result = await runEvidenceStage(saved as unknown as VeJob, f.ctx);
    expect(result).toMatchObject({ tokensUsed: 45, costUsd: 0.03, result: { kept: 2, merged: 1, dropped: 0 } });
    expect(llm).toHaveBeenCalledTimes(5);
    expect(loadPortfolioProfile).toHaveBeenCalledTimes(1);
    expect(loadMarkupHistory).toHaveBeenCalledTimes(1);
    expect(f.db.getRows('ve_hypotheses').map((row) => row.title)).toEqual(['A', 'C']);
    expect((f.db.getRows('ve_jobs').find((row) => row.id === f.job.id)!.result as Record<string, unknown>).evidence_checkpoint).toMatchObject({
      ...(previousCheckpoint as object), next_index: 3, accepted: [{ title: 'A' }, { title: 'C' }], usage: { tokensUsed: 45, costUsd: 0.03 },
    });
    await f.db.from('ve_projects').update({ brief: { site_profile: { product_summary: 'Changed offer', company_name: 'Client' } } }).eq('id', 'project');
    await expect(runEvidenceStage(saved as unknown as VeJob, f.ctx)).rejects.toThrow(/checkpoint input changed/);
    expect(llm).toHaveBeenCalledTimes(5);
    expect(f.db.getRows('ve_hypotheses').map((row) => row.title)).toEqual(['A', 'C']);
  });

  it('fails closed on checkpoint write errors and lost running ownership, without publishing hypotheses', async () => {
    for (const failureMode of ['response', 'throw', 'ownership']) {
      const failWrites = failureMode !== 'ownership';
      const f = fixture();
      if (!failWrites) await f.db.from('ve_jobs').update({ status: 'cancelled' }).eq('id', f.job.id);
      const llm = jest.mocked(callLLMWithSchema).mockReset().mockImplementationOnce(async () => {
        // Fail only the post-LLM usage checkpoint. A swallowed error would let
        // the next write succeed and incorrectly commit a business drop.
        Object.defineProperty(f.errorUpdates, 've_jobs', { configurable: true, get() {
          delete f.errorUpdates.ve_jobs;
          if (failureMode === 'throw') throw new Error('storage rejected write');
          return { message: 'checkpoint unavailable' };
        } });
        return f.verdict('A');
      });
      await expect(runEvidenceStage(f.job, f.ctx)).rejects.toThrow(/checkpoint|ownership|running/i);
      expect(llm).toHaveBeenCalledTimes(failWrites ? 1 : 0);
      expect(f.db.getRows('ve_hypotheses')).toEqual([]);
      if (failWrites) expect((f.db.getRows('ve_jobs').find((row) => row.id === f.job.id)!.result as Record<string, unknown>).evidence_checkpoint).toMatchObject({ next_index: 0, accepted: [], dropped: 0 });
    }
  });
});
