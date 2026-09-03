/** @jest-environment node */

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { enqueueVeBaseCollect } from '@/lib/verticalEngineV2/baseCollectEnqueue';

let mockRouteDb = createMockSupabase();
jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mockRouteDb; } }));
jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({ auth: { userId: 'user-1', role: 'technician' } })),
}));
jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));
jest.mock('@/lib/loggerServer', () => ({ logAudit: jest.fn(), logError: jest.fn() }));
import { POST as collectPreview } from '@/app/api/tools/vertical-engine-v2/verticals/[id]/collect/route';

const input = {
  verticalId: 'vertical-1',
  projectId: 'project-1',
  verticalName: 'Частная медицина',
  limit: 100,
  hypothesisIds: null,
};

describe('VE2 base collection enqueue recovery', () => {
  it('does not expose private candidate checkpoints on existing or mixed preview requests', async () => {
    const privateInfo = {
      collection_mode: 'preview', ready_target: 1_000, limit: 2_000,
      target_checkpoint: { seen_rows: [{ email: 'rejected@example.com' }] },
      tasks: [{ source: 'directory', rows: 25, harvest: [{ email: 'raw@example.com' }] }],
    };
    mockRouteDb = createMockSupabase({ tables: {
      ve_verticals: [{ id: input.verticalId, project_id: input.projectId, name: input.verticalName }],
      ve_hypotheses: ['hypothesis-1', 'hypothesis-2'].map((id) => ({ id, title: id })),
      ve_bases: [{ id: 'existing', vertical_id: input.verticalId, project_id: input.projectId,
        hypothesis_id: 'hypothesis-1', source: 'auto', status: 'collecting', collect_info: privateInfo }],
      ve_jobs: [{ id: 'existing-job', project_id: input.projectId, stage: 'base_collect',
        status: 'pending', payload: { base_id: 'existing', hypothesis_id: 'hypothesis-1' } }],
    } });
    for (const hypothesisIds of [['hypothesis-1'], ['hypothesis-1', 'hypothesis-2']]) {
      const response = await collectPreview(new NextRequest('http://portal.test/collect', {
        method: 'POST', body: JSON.stringify({ hypothesis_ids: hypothesisIds, limit: 50_000 }),
      }), { params: Promise.resolve({ id: input.verticalId }) });
      expect(response.ok).toBe(true);
      const payload = await response.json();
      for (const base of [payload.base, ...(payload.bases ?? [])]) {
        expect(base.collect_info).not.toHaveProperty('target_checkpoint');
        expect(base.collect_info?.tasks?.some((task: Record<string, unknown>) => 'harvest' in task)).not.toBe(true);
      }
    }
    // Sanitizing a response must not destroy the worker's durable state.
    expect(mockRouteDb.getRows('ve_bases').find((row) => row.id === 'existing')?.collect_info).toEqual(privateInfo);
  });

  it('continues with the remaining hypotheses when one selected base already exists', async () => {
    const db = createMockSupabase({
      tables: {
        ve_hypotheses: [
          { id: 'hypothesis-1', title: 'Первая' },
          { id: 'hypothesis-2', title: 'Вторая' },
        ],
        ve_bases: [
          {
            id: 'base-existing',
            project_id: input.projectId,
            vertical_id: input.verticalId,
            hypothesis_id: 'hypothesis-1',
            source: 'auto',
            status: 'collecting',
            collect_info: { limit: input.limit, hypothesis_id: 'hypothesis-1' },
          },
        ],
        ve_jobs: [
          {
            id: 'job-existing',
            project_id: input.projectId,
            stage: 'base_collect',
            status: 'pending',
            payload: { base_id: 'base-existing', hypothesis_id: 'hypothesis-1' },
          },
        ],
      },
    });

    await expect(
      enqueueVeBaseCollect(db as unknown as SupabaseClient, {
        ...input,
        hypothesisIds: ['hypothesis-1', 'hypothesis-2'],
        collectionMode: 'preview',
        readyTarget: 50_000,
      }),
    ).resolves.toMatchObject({ ok: true, created: true });

    expect(db.getRows('ve_bases')).toContainEqual(expect.objectContaining({
      hypothesis_id: 'hypothesis-2',
      status: 'collecting',
      collect_info: expect.objectContaining({ collection_mode: 'preview', ready_target: 1_000, limit: 2_000 }),
    }));
    expect(db.getRows('ve_jobs')).toContainEqual(expect.objectContaining({
      status: 'pending',
      payload: expect.objectContaining({ hypothesis_id: 'hypothesis-2', collection_mode: 'preview', ready_target: 1_000 }),
    }));
  });

  it('repairs an orphan collecting base that has no active worker job', async () => {
    const db = createMockSupabase({
      tables: {
        ve_bases: [
          {
            id: 'base-orphan',
            project_id: input.projectId,
            vertical_id: input.verticalId,
            hypothesis_id: null,
            source: 'auto',
            status: 'collecting',
            collect_info: { limit: 500, collection_mode: 'supply', ready_target: 250 },
          },
        ],
        ve_jobs: [
          {
            id: 'job-dead',
            project_id: input.projectId,
            stage: 'base_collect',
            status: 'failed',
            payload: { base_id: 'base-orphan' },
          },
        ],
      },
    });

    await expect(
      enqueueVeBaseCollect(db as unknown as SupabaseClient, input),
    ).resolves.toMatchObject({ ok: true });

    const collecting = db.getRows('ve_bases').filter((row) => row.status === 'collecting');
    expect(db.getRows('ve_jobs')).toContainEqual(expect.objectContaining({
      project_id: input.projectId,
      stage: 'base_collect',
      status: 'pending',
      payload: expect.objectContaining({ base_id: collecting[0]?.id, limit: 500, collection_mode: 'supply', ready_target: 250 }),
    }));
  });

  it('repairs a normal orphan from its stored snapshot even when the caller requests refill', async () => {
    const db = createMockSupabase({
      tables: {
        ve_bases: [{
          id: 'base-normal-orphan',
          project_id: input.projectId,
          vertical_id: input.verticalId,
          hypothesis_id: null,
          source: 'auto',
          status: 'collecting',
          collect_info: { limit: 321 },
        }],
        ve_jobs: [],
      },
    });

    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, {
      ...input,
      refill: { campaignId: 'campaign-new' },
    })).resolves.toMatchObject({ ok: true, created: false });

    expect(db.getRows('ve_jobs')).toContainEqual(expect.objectContaining({
      payload: { base_id: 'base-normal-orphan', limit: 321 },
    }));
  });

  it('repairs a refill orphan from its stored snapshot even when the caller is normal', async () => {
    const db = createMockSupabase({
      tables: {
        ve_bases: [{
          id: 'base-refill-orphan',
          project_id: input.projectId,
          vertical_id: input.verticalId,
          hypothesis_id: null,
          source: 'auto',
          status: 'collecting',
          collect_info: { limit: 654, refill: true, campaign_id: 'campaign-old' },
        }],
        ve_jobs: [],
      },
    });

    await expect(
      enqueueVeBaseCollect(db as unknown as SupabaseClient, input),
    ).resolves.toMatchObject({ ok: true, created: false });

    expect(db.getRows('ve_jobs')).toContainEqual(expect.objectContaining({
      payload: { base_id: 'base-refill-orphan', limit: 654, refill: true },
    }));
  });

  it('treats a concurrent repair unique conflict as an idempotent success', async () => {
    const db = createMockSupabase({
      tables: {
        ve_bases: [{
          id: 'base-raced-orphan',
          project_id: input.projectId,
          vertical_id: input.verticalId,
          hypothesis_id: null,
          source: 'auto',
          status: 'collecting',
          collect_info: { limit: 222 },
        }],
        ve_jobs: [],
      },
      errorInserts: {
        ve_jobs: { code: '23505', message: 'duplicate active job', commitRow: true },
      },
    });

    await expect(
      enqueueVeBaseCollect(db as unknown as SupabaseClient, input),
    ).resolves.toMatchObject({ ok: true, created: false });

    expect(db.getRows('ve_jobs').filter((candidate) => (
      candidate.status === 'pending'
      && (candidate.payload as { base_id?: string }).base_id === 'base-raced-orphan'
    ))).toHaveLength(1);
  });

  it('does not mistake a per-hypothesis base for the refill/legacy slot', async () => {
    const db = createMockSupabase({
      tables: {
        ve_bases: [{
          id: 'base-hypothesis',
          project_id: input.projectId,
          vertical_id: input.verticalId,
          hypothesis_id: 'hypothesis-1',
          source: 'auto',
          status: 'collecting',
          collect_info: { limit: 100, hypothesis_id: 'hypothesis-1' },
        }],
        ve_jobs: [{
          id: 'job-hypothesis',
          project_id: input.projectId,
          stage: 'base_collect',
          status: 'pending',
          payload: { base_id: 'base-hypothesis', hypothesis_id: 'hypothesis-1' },
        }],
      },
    });

    await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, {
      ...input,
      refill: { campaignId: 'campaign-refill' },
    })).resolves.toMatchObject({ ok: true, created: true });

    expect(db.getRows('ve_bases')).toContainEqual(expect.objectContaining({
      vertical_id: input.verticalId,
      hypothesis_id: null,
      collect_info: expect.objectContaining({ refill: true }),
    }));
  });

  it('does not let an active legacy job from another vertical block this one', async () => {
    const db = createMockSupabase({
      tables: {
        ve_bases: [{
          id: 'base-other-vertical',
          project_id: input.projectId,
          vertical_id: 'vertical-2',
          hypothesis_id: null,
          source: 'auto',
          status: 'analyzed',
          collect_info: { limit: 100 },
        }],
        ve_jobs: [{
          id: 'job-other-vertical',
          project_id: input.projectId,
          stage: 'base_collect',
          status: 'running',
          payload: { base_id: 'base-other-vertical' },
        }],
      },
    });

    await expect(
      enqueueVeBaseCollect(db as unknown as SupabaseClient, input),
    ).resolves.toMatchObject({ ok: true, created: true });

    expect(db.getRows('ve_bases')).toContainEqual(expect.objectContaining({
      vertical_id: input.verticalId,
      hypothesis_id: null,
      status: 'collecting',
    }));
  });

  it('does not leave a collecting orphan when the worker job insert fails', async () => {
    const db = createMockSupabase({
      tables: { ve_bases: [], ve_jobs: [] },
      errorInserts: {
        ve_jobs: { code: 'XX000', message: 'queue unavailable' },
      },
    });

    await expect(
      enqueueVeBaseCollect(db as unknown as SupabaseClient, input),
    ).resolves.toEqual({ ok: false, message: 'queue unavailable' });

    expect(db.getRows('ve_bases').filter((row) => row.status === 'collecting')).toEqual([]);
  });
});
