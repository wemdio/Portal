/** @jest-environment node */

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { enqueueVeBaseCollect } from '@/lib/verticalEngineV2/baseCollectEnqueue';
import { claimVeJob, createVeJobPool, veJobConcurrency } from '@/lib/verticalEngineV2/jobQueue';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import { runVeOutreachPreparations } from '@/lib/verticalEngineV2/outreachPreparation';

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
      source_contact_recovery: { version: 1, checked: { private: { website: 'https://private.test/' } } },
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
        expect(base.collect_info).not.toHaveProperty('source_contact_recovery');
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
      collect_info: expect.objectContaining({ collection_mode: 'preview', ready_target: 500, limit: 100,
        target_progress: expect.objectContaining({ first_round_candidates: 100 }),
      }),
    }));
    expect(db.getRows('ve_jobs')).toContainEqual(expect.objectContaining({
      status: 'pending',
      payload: expect.objectContaining({ hypothesis_id: 'hypothesis-2', collection_mode: 'preview', ready_target: 500 }),
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

    // Death after base resume but before queue INSERT: recover only an older
    // completed job, never automatically retry a real terminal failure.
    for (const [lastStatus, finished, shouldRepair] of [
      ['done', '2026-09-14T08:23:00Z', true],
      ['done', '2026-09-14T22:42:00Z', false],
      ['failed', '2026-09-14T08:23:00Z', false],
      ['cancelled', '2026-09-14T08:23:00Z', false],
    ] as const) {
      let claims = 0;
      const preparation = { project_id: input.projectId, hypothesis_id: 'h1', base_id: 'resumed',
        template_id: null, status: 'collecting', language: 'ru', claim_token: 'lease' };
      const resumedDb = createMockSupabase({ tables: {
        ve_hypotheses: [{ id: 'h1', project_id: input.projectId, vertical_id: input.verticalId, status: 'approved' }],
        ve_verticals: [{ id: input.verticalId, project_id: input.projectId, name: 'Medicine' }],
        ve_bases: [{ id: 'resumed', project_id: input.projectId, hypothesis_id: 'h1', vertical_id: input.verticalId,
          source: 'auto', status: 'collecting', updated_at: '2026-09-14T22:41:33Z', collection_mode: 'preview',
          collect_info: { collection_mode: 'preview', limit: 2000, ready_target: 500, hypothesis_id: 'h1' } }],
        ve_jobs: [{ id: 'old', project_id: input.projectId, stage: 'base_collect', status: lastStatus,
          finished_at: finished, 'payload->>base_id': 'resumed', payload: { base_id: 'resumed' } }],
      }, rpcHandlers: {
        ve_claim_outreach_preparation: () => ({ data: claims++ === 0 ? [preparation] : [] }),
        ve_save_outreach_preparation: () => ({ data: true }),
      } });
      await runVeOutreachPreparations(resumedDb as unknown as SupabaseClient);
      expect(resumedDb.getRows('ve_jobs').filter((row) => row.status === 'pending')).toHaveLength(shouldRepair ? 1 : 0);
      if (shouldRepair) {
        claims = 0;
        await runVeOutreachPreparations(resumedDb as unknown as SupabaseClient);
        expect(resumedDb.getRows('ve_jobs').filter((row) => row.status === 'pending')).toHaveLength(1);
      }
    }

    // A busy coordinator advances beyond two preparations per tick, but never
    // spins around a short queue redoing the same preparation repeatedly.
    for (const size of [2, 50]) {
      let claimCount = 0;
      const save = jest.fn(() => ({ data: true }));
      const preparations = Array.from({ length: size }, (_, index) => ({
        project_id: `coord-${index}`, hypothesis_id: `h-${index}`, base_id: null,
        template_id: null, status: 'pending', language: 'ru', last_error: null, claim_token: 'lease',
      }));
      const coordinatorDb = createMockSupabase({ rpcHandlers: {
        ve_claim_outreach_preparation: () => ({ data: [preparations[claimCount++ % size]] }),
        ve_save_outreach_preparation: save,
      } });
      await runVeOutreachPreparations(coordinatorDb as unknown as SupabaseClient);
      expect(claimCount).toBe(size === 2 ? 3 : 32);
      expect(save).toHaveBeenCalledTimes(claimCount);
    }

    // One project keeps its stage order while another uses the free slot.
    const now = new Date('2026-09-14T23:00:00Z');
    const queueDb = createMockSupabase({ enforceQueryWindows: true, tables: { ve_jobs:
      [['a1', 'a'], ['a2', 'a'], ['b1', 'b'], ['c1', 'c']].map(([id, project_id], index) => ({
        id, project_id, stage: 'base_collect', status: 'pending', payload: {},
        run_after: `2026-09-14T22:00:0${index}Z`, created_at: `2026-09-14T22:00:0${index}Z`,
      })),
    } });
    let stopped = false;
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const onError = jest.fn();
    const pool = createVeJobPool({ concurrency: 2, idleMs: 0, shouldStop: () => stopped,
      claim: (projects) => claimVeJob(queueDb as unknown as SupabaseClient, now, projects),
      run: async (job) => {
        started.push(job.id);
        await new Promise<void>((resolve) => { release.set(job.id, resolve); });
        await queueDb.from('ve_jobs').update({ status: 'done' }).eq('id', job.id);
        if (job.id === 'b1') throw new Error('isolated failure');
      }, onError,
    });
    await pool.pollOnce(); await pool.pollOnce();
    expect(started).toEqual(['a1', 'b1']);
    const full = pool.pollOnce();
    expect(started).toHaveLength(2);
    release.get('b1')!(); await full; await pool.pollOnce();
    expect(started).toEqual(['a1', 'b1', 'c1']);
    expect(onError).toHaveBeenCalledTimes(1);
    release.get('a1')!();
    await pool.pollOnce(); await pool.pollOnce();
    expect(started).toEqual(['a1', 'b1', 'c1', 'a2']);
    stopped = true;
    expect(await pool.pollOnce()).toBe(false);
    release.get('c1')!(); release.get('a2')!();
    await pool.drain();
    expect(queueDb.getRows('ve_jobs').every((row) => row.status === 'done')).toBe(true);
    // The requested 15 x 25 workload must drain without starving a project or
    // allowing two parent writers to mutate the same project's usage/state.
    expect([undefined, '0', 'NaN', '1', '8', '16', '999'].map(veJobConcurrency)).toEqual([8, 8, 8, 1, 8, 16, 16]);
    const backlog = Array.from({ length: 375 }, (_, i) => ({ id: `j${i}`, project_id: `p${i % 15}` }) as VeJob);
    const activeProjects = new Set<string>(), completed = new Set<string>();
    const finishWave: Array<() => void> = [];
    let highWater = 0;
    const errors = jest.fn();
    const scaled = createVeJobPool({ concurrency: 8, idleMs: 0, shouldStop: () => false,
      claim: async (active) => {
        const index = backlog.findIndex((job) => !active.includes(job.project_id));
        return index < 0 ? null : backlog.splice(index, 1)[0];
      }, run: async (job) => {
        expect(activeProjects.has(job.project_id)).toBe(false);
        activeProjects.add(job.project_id); highWater = Math.max(highWater, activeProjects.size);
        await new Promise<void>((resolve) => { finishWave.push(resolve); });
        activeProjects.delete(job.project_id); completed.add(job.id);
      }, onError: errors,
    });
    while (backlog.length) {
      for (let slot = 0; slot < 8; slot++) await scaled.pollOnce();
      finishWave.splice(0).forEach((finish) => finish());
      await scaled.drain();
    }
    expect(completed.size).toBe(375);
    expect(highWater).toBe(8);
    expect(errors).not.toHaveBeenCalled();
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
