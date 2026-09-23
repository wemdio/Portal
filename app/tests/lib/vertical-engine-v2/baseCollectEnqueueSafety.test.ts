/** @jest-environment node */

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { enqueueVeBaseCollect } from '@/lib/verticalEngineV2/baseCollectEnqueue';
import { claimVeJob, createVeJobPool, createVeProjectUsageAccumulator, canRunVeJob, veJobConcurrency, veBaseCollectConcurrency } from '@/lib/verticalEngineV2/jobQueue';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import { runVeOutreachPreparations } from '@/lib/verticalEngineV2/outreachPreparation';
import { autoResumeVeTransientPreparations, enqueueVeContactReprojections } from '@/lib/verticalEngineV2/outreachSetup';
import { VE_RELEVANCE_RULES_VERSION } from '@/lib/verticalEngineV2/relevanceDecision';

let mockRouteDb = createMockSupabase();
jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mockRouteDb; } }));
jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({ auth: { userId: 'user-1', role: 'technician' } })),
}));
jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));
jest.mock('@/lib/loggerServer', () => ({ logAudit: jest.fn(), logError: jest.fn() }));
jest.mock('@/lib/verticalEngineV2/outreachSetup', () => ({ ...jest.requireActual('@/lib/verticalEngineV2/outreachSetup'), loadVeOutreachSetup: jest.fn(async () => ({})) }));
import { POST as collectPreview } from '@/app/api/tools/vertical-engine-v2/verticals/[id]/collect/route';
import { POST as prepareOutreach } from '@/app/api/tools/vertical-engine-v2/projects/[id]/outreach/route';

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

    // A later request/day must reuse a finished preview, including a limited
    // or empty result. Reaching fewer than 500 does not authorize daily supply.
    await db.from('ve_jobs').update({ status: 'done' });
    for (const status of ['analyzing', 'analyzed']) {
      await db.from('ve_bases').update({ status, row_count: status === 'analyzed' ? 0 : 128,
        collect_info: { collection_mode: 'preview', target_progress: { status: 'limited' } } });
      await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, {
        ...input, hypothesisIds: ['hypothesis-1', 'hypothesis-2'], collectionMode: 'preview',
      })).resolves.toMatchObject({ ok: true, created: false });
      expect(db.getRows('ve_bases')).toHaveLength(2);
      expect(db.getRows('ve_jobs')).toHaveLength(2);
      expect(db.getRows('ve_jobs').every((row) => row.status === 'done')).toBe(true);
    }

    let claimed = false;
    const save = jest.fn(() => ({ data: true }));
    const resumedDb = createMockSupabase({ tables: {
      ve_hypotheses: [{ id: 'h1', project_id: input.projectId, vertical_id: input.verticalId, status: 'approved' }],
      ve_bases: [
        { id: 'old-ready', project_id: input.projectId, hypothesis_id: 'h1', source: 'auto',
          status: 'analyzed', row_count: 128, collection_mode: 'preview', collect_info: { collection_mode: 'preview' } },
        { id: 'cancelled-duplicate', project_id: input.projectId, hypothesis_id: 'h1', source: 'auto',
          status: 'failed', error: 'Отменено пользователем', collection_mode: 'preview', collect_info: { collection_mode: 'preview' } },
      ],
      ve_templates: [{ id: 'saved-letters', base_id: 'old-ready', status: 'ready', supply_batch_id: null }],
    }, rpcHandlers: {
      ve_claim_outreach_preparation: () => {
        if (claimed) return { data: [] };
        claimed = true;
        return { data: [{ project_id: input.projectId, hypothesis_id: 'h1', base_id: 'cancelled-duplicate',
          template_id: null, status: 'pending', language: 'ru', claim_token: 'lease' }] };
      },
      ve_save_outreach_preparation: save,
    } });
    await runVeOutreachPreparations(resumedDb as unknown as SupabaseClient);
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({
      p_status: 'ready', p_base_id: 'old-ready', p_template_id: 'saved-letters',
    }), expect.anything());
    expect(resumedDb.getRows('ve_jobs')).toHaveLength(0);
    expect(resumedDb.rpcCalls.some((call) => call.fn === 've_resume_outreach_cancelled_base')).toBe(false);

    // A terminal partial preview is resumed only by an explicit Continue for
    // that saved base. Routine enqueue still reuses it without daily spending.
    // 'rules': a completed website check from before the current selection
    // rules is resumable once, for the gate's one-time recheck of saved quotes.
    for (const mode of ['continue', 'routine', 'launched', 'checked', 'rules'] as const) {
      let partialClaimed = false;
      const partialSave = jest.fn(() => ({ data: true }));
      const target = { mode: 'preview', status: 'limited', ready_rows: 0, ready_target: 500,
        candidates_processed: 17, round: 1, max_rounds: 100, max_candidates: 10000, first_round_candidates: 100 };
      const partialDb = createMockSupabase({ tables: {
        ve_hypotheses: [{ id: 'h1', title: 'Industrial plants', project_id: input.projectId, vertical_id: input.verticalId, status: 'approved' }],
        ve_verticals: [{ id: input.verticalId, project_id: input.projectId, name: input.verticalName }],
        ve_bases: [{ id: 'saved-partial', project_id: input.projectId, vertical_id: input.verticalId, hypothesis_id: 'h1',
          source: 'auto', status: 'analyzed', row_count: 0, collection_mode: 'preview', target_progress: target,
          collect_info: { collection_mode: 'preview', target_progress: target, target_checkpoint: { completed_round: 1 },
            relevance_reserve: { version: 1, rows: [{ company: 'Plant', website: 'plant.test', email: 'info@plant.test',
              _email_status: 'ok', _ve_relevance: { status: 'needs_review', review_attempts: 1,
                website_review_version: mode === 'checked' || mode === 'rules' ? 4 : 3,
                ...(mode === 'rules' ? {} : { rules_version: VE_RELEVANCE_RULES_VERSION }) } }] } } }],
        ve_templates: mode === 'launched' ? [{ id: 'live-template', base_id: 'saved-partial', launch_info: { campaign_id: 'live' } }] : [],
      }, rpcHandlers: {
        ve_claim_outreach_preparation: () => {
          if (partialClaimed) return { data: [] };
          partialClaimed = true;
          return { data: [{ project_id: input.projectId, hypothesis_id: 'h1', base_id: 'saved-partial',
            template_id: null, status: 'pending', language: 'ru', claim_token: 'partial-lease' }] };
        },
        ve_save_outreach_preparation: partialSave,
      } });
      const partialClient = partialDb as unknown as SupabaseClient;
      if (mode === 'routine') {
        await expect(enqueueVeBaseCollect(partialClient, { ...input, hypothesisIds: ['h1'], collectionMode: 'preview' }))
          .resolves.toMatchObject({ ok: true, created: false });
      } else await runVeOutreachPreparations(partialClient);
      expect(partialDb.getRows('ve_bases')).toHaveLength(1);
      const jobs = partialDb.getRows('ve_jobs');
      expect(jobs).toHaveLength(mode === 'continue' || mode === 'rules' ? 1 : 0);
      if (mode === 'continue' || mode === 'rules') {
        expect(jobs[0]).toMatchObject({ stage: 'base_collect', status: 'pending',
          payload: { base_id: 'saved-partial', hypothesis_id: 'h1', collection_mode: 'preview' } });
        expect(partialDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting',
          collect_info: { relevance_review_requested: true, validation_retry: true,
            target_progress: { ready_rows: 0, candidates_processed: 17, round: 1 } } });
        expect(partialSave).toHaveBeenLastCalledWith(expect.objectContaining({ p_status: 'collecting' }), expect.anything());
        await enqueueVeBaseCollect(partialClient, { ...input, hypothesisIds: ['h1'], collectionMode: 'preview', resumeBaseId: 'saved-partial' });
        expect(partialDb.getRows('ve_jobs')).toHaveLength(1);
      } else expect(partialDb.getRows('ve_bases')[0].status).toBe('analyzed');
    }

    // A Continue action inside one card may not dispatch the project-wide RPC.
    const projectId = '00000000-0000-4000-8000-000000000301';
    const hypothesisId = '00000000-0000-4000-8000-000000000302';
    mockRouteDb = createMockSupabase({ rpcHandlers: {
      ve_request_outreach_preparation: () => ({ data: null }),
      ve_request_outreach_hypothesis_preparation: () => ({ data: null }),
    } });
    const request = (extra: Record<string, unknown>) => prepareOutreach(new NextRequest('http://portal.test/outreach', {
      method: 'POST', body: JSON.stringify({ action: 'prepare', revision: 7, ...extra }),
    }), { params: Promise.resolve({ id: projectId }) });
    expect((await request({ hypothesis_id: hypothesisId })).status).toBe(200);
    expect(mockRouteDb.rpcCalls).toEqual([expect.objectContaining({ fn: 've_request_outreach_hypothesis_preparation',
      params: { p_project_id: projectId, p_revision: 7, p_hypothesis_id: hypothesisId } })]);
    for (const invalid of [null, '', 'wrong-id']) expect((await request({ hypothesis_id: invalid })).status).toBe(400);
    expect(mockRouteDb.rpcCalls).toHaveLength(1);
    expect((await request({})).status).toBe(200);
    expect(mockRouteDb.rpcCalls[1].fn).toBe('ve_request_outreach_preparation');

    // The specialist's "addresses per company" limit: saved through its own RPC.
    // The nudge only asks the queue for bases whose applied value is out of date
    // and only when the limit was tightened; everything else waits for the sweep.
    mockRouteDb = createMockSupabase({ tables: { ve_projects: [{ id: projectId }], ve_bases: [
      { id: 'tightened', project_id: projectId, source: 'auto', status: 'analyzed', hypothesis_id: hypothesisId, max_emails_per_company: 3, contact_cap_applied: 5, updated_at: '2026-09-20T03:00:00Z' },
      { id: 'first-time', project_id: projectId, source: 'auto', status: 'analyzed', hypothesis_id: hypothesisId, max_emails_per_company: 3, contact_cap_applied: null, updated_at: '2026-09-20T02:00:00Z' },
      { id: 'already', project_id: projectId, source: 'auto', status: 'analyzed', hypothesis_id: hypothesisId, max_emails_per_company: 3, contact_cap_applied: 3, updated_at: '2026-09-20T01:00:00Z' },
      { id: 'loosened', project_id: projectId, source: 'auto', status: 'analyzed', hypothesis_id: hypothesisId, max_emails_per_company: 9, contact_cap_applied: 3, updated_at: '2026-09-20T00:30:00Z' },
      { id: 'running', project_id: projectId, source: 'auto', status: 'collecting', hypothesis_id: hypothesisId, max_emails_per_company: 3, contact_cap_applied: null, updated_at: '2026-09-20T00:00:00Z' },
    ] }, rpcHandlers: {
      ve_save_outreach_contact_limit: () => ({ data: null }),
      ve_enqueue_contact_reprojection: () => ({ data: { ok: true, queued: true } }),
    } });
    const limit = (max: unknown) => prepareOutreach(new NextRequest('http://portal.test/outreach', {
      method: 'POST', body: JSON.stringify({ action: 'contact_limit', revision: 7, max_emails_per_company: max }),
    }), { params: Promise.resolve({ id: projectId }) });
    for (const invalid of [0, 1.5, '5', 101, undefined]) expect((await limit(invalid)).status).toBe(400);
    expect(mockRouteDb.rpcCalls).toHaveLength(0);
    expect((await limit(3)).status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockRouteDb.rpcCalls.map((call) => [call.fn, call.params])).toEqual([
      ['ve_save_outreach_contact_limit', { p_project_id: projectId, p_revision: 7, p_max: 3, p_actor: expect.anything() }],
      ['ve_enqueue_contact_reprojection', { p_base_id: 'tightened' }],
      ['ve_enqueue_contact_reprojection', { p_base_id: 'first-time' }],
    ]);
    // The worker sweep catches up with whatever was busy, through its own scan.
    const sweepReady = '00000000-0000-4000-8000-000000000401';
    const sweepBusy = '00000000-0000-4000-8000-000000000402';
    const sweepDb = createMockSupabase({ rpcHandlers: {
      ve_pending_contact_reprojections: () => ({ data: [sweepReady, sweepBusy, 'not-a-uuid'] }),
      ve_enqueue_contact_reprojection: ({ p_base_id }: Record<string, unknown>) => ({ data: { ok: true, queued: p_base_id === sweepReady } }),
    } });
    await expect(enqueueVeContactReprojections(sweepDb as unknown as SupabaseClient)).resolves.toEqual({ queued: 1, pending: 1 });
    expect((await limit(null)).status).toBe(200);

    // Автоподъём после временного сбоя: все проверки живут в RPC, наружу
    // отдаётся только число поднятых, а сбой самой RPC не глотается молча —
    // иначе воркер годами «поднимал бы ноль» и никто бы не заметил.
    const resumeCalls: Array<Record<string, unknown>> = [];
    const resumeDb = createMockSupabase({ rpcHandlers: {
      ve_auto_resume_transient_preparations: (params: Record<string, unknown>) => { resumeCalls.push(params); return { data: 3 }; },
    } });
    await expect(autoResumeVeTransientPreparations(resumeDb as unknown as SupabaseClient)).resolves.toEqual({ resumed: 3 });
    expect(resumeCalls).toEqual([{ p_limit: 10 }]);
    const brokenDb = createMockSupabase({ rpcHandlers: {
      ve_auto_resume_transient_preparations: () => ({ data: null, error: { message: 'rpc down' } }),
    } });
    await expect(autoResumeVeTransientPreparations(brokenDb as unknown as SupabaseClient)).rejects.toThrow('rpc down');
    const oddDb = createMockSupabase({ rpcHandlers: { ve_auto_resume_transient_preparations: () => ({ data: null }) } });
    await expect(autoResumeVeTransientPreparations(oddDb as unknown as SupabaseClient)).resolves.toEqual({ resumed: 0 });
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

    // A journal outage between rounds must not purchase another base or child.
    const savedInfo = { collection_mode: 'preview', ready_target: 500, limit: 100,
      target_progress: { round: 2, status: 'collecting', candidates_processed: 3 },
      target_checkpoint: { completed_round: 1 },
      tasks: [{ source: 'hh_live', status: 'dispatched', child_job_id: 'paid-child' }] };
    // An exhausted 429 wait ends the same way: the round stays coherent.
    // So does a final inactivity-watchdog failure: never a new paid base.
    for (const interruption of ['Provider usage journal could not be saved.',
      'Requesty 429: сервис ИИ временно ограничил запросы; результаты сохранены.',
      'VE2 base_collect inactivity timeout after 1200000ms']) {
      const interruptedDb = createMockSupabase({ tables: {
        ve_hypotheses: [{ id: 'h1', title: 'Law firms' }],
        ve_bases: [{ id: 'interrupted', project_id: input.projectId, vertical_id: input.verticalId,
          hypothesis_id: 'h1', source: 'auto', status: 'failed', collect_info: savedInfo, error: interruption }],
        ve_jobs: [{ id: 'old-job', project_id: input.projectId, stage: 'base_collect', status: 'failed',
          payload: { base_id: 'interrupted' } }],
      } });
      for (let attempt = 0; attempt < 2; attempt++) {
        await expect(enqueueVeBaseCollect(interruptedDb as unknown as SupabaseClient, {
          ...input, hypothesisIds: ['h1'], collectionMode: 'preview',
        })).resolves.toMatchObject({ ok: true, base: { id: 'interrupted' } });
      }
      expect(interruptedDb.getRows('ve_bases')).toHaveLength(1);
      expect(interruptedDb.getRows('ve_bases')[0].collect_info).toEqual(savedInfo);
      expect(interruptedDb.getRows('ve_jobs').filter((row) => row.status === 'pending')).toHaveLength(1);
    }

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
    // allowing two writers for the same base or unlimited work from one project.
    expect([undefined, '0', 'NaN', '1', '8', '16', '999'].map(veJobConcurrency)).toEqual([8, 8, 8, 1, 8, 16, 16]);
    const backlog = Array.from({ length: 375 }, (_, i) => ({ id: `j${i}`, project_id: `p${i % 15}`, stage: 'base_collect', payload: { base_id: `base${i}` } }) as unknown as VeJob);
    const activeBases = new Set<string>(), completed = new Set<string>();
    const finishWave: Array<() => void> = [];
    let highWater = 0;
    const errors = jest.fn();
    const scaled = createVeJobPool({ concurrency: 16, collectLimit: 16, idleMs: 0, shouldStop: () => false,
      claim: async (active) => {
        // Этот сценарий проверяет блокировки областей (один писатель на базу,
        // ни один проект не голодает), а не бюджет Serper: лимит одновременных
        // сборок поднят до размера пула, иначе 375 задач шли бы волнами по 3.
        const index = backlog.findIndex((job) => canRunVeJob(job, active, 16));
        return index < 0 ? null : backlog.splice(index, 1)[0];
      }, run: async (job) => {
        const key = `${job.project_id}:${job.payload.base_id}`;
        expect(activeBases.has(key)).toBe(false);
        activeBases.add(key); highWater = Math.max(highWater, activeBases.size);
        await new Promise<void>((resolve) => { finishWave.push(resolve); });
        activeBases.delete(key); completed.add(job.id);
      }, onError: errors,
    });
    while (backlog.length) {
      for (let slot = 0; slot < 16; slot++) await scaled.pollOnce();
      finishWave.splice(0).forEach((finish) => finish());
      await scaled.drain();
    }
    expect(completed.size).toBe(375);
    expect(highWater).toBe(16);
    expect(errors).not.toHaveBeenCalled();

    // Distinct bases of one project run together; all stages of the same base
    // and a pending project-wide operation still hold their respective locks.
    const baseJob = (id: string, base: string | null, stage = 'base_collect') => ({
      id, project_id: 'one', stage, payload: base ? { base_id: base } : {},
      status: 'pending', run_after: now.toISOString(), created_at: now.toISOString(),
    }) as unknown as VeJob;
    const first = baseJob('d1', 'b1');
    const independent = baseJob('d2', 'b2');
    const sameBase = baseJob('d3', 'b1', 'template');
    const research = baseJob('d4', null, 'evidence');
    const independentDb = createMockSupabase({ enforceQueryWindows: true, tables: { ve_jobs: [first, sameBase, independent, research, baseJob('d5', 'b3')].map((job) => ({ ...job })) } });
    const claimed = await claimVeJob(independentDb as unknown as SupabaseClient, now);
    expect(claimed?.id).toBe('d1');
    expect((await claimVeJob(independentDb as unknown as SupabaseClient, now, [claimed!]))?.id).toBe('d2');
    expect(await claimVeJob(independentDb as unknown as SupabaseClient, now, [claimed!, independent])).toBeNull();
    expect(canRunVeJob(sameBase, [first])).toBe(false);
    expect(canRunVeJob(independent, [research])).toBe(false);
    expect(canRunVeJob(research, [independent])).toBe(false);
    expect(canRunVeJob(baseJob('later', 'b5'), [1, 2, 3, 4].map((n) => baseJob(`a${n}`, `b${n}`)))).toBe(false);
    // A lower collection cap is an explicit override, not the default. Scope
    // locks still apply and lightweight work bypasses that optional throttle.
    expect(canRunVeJob(baseJob('fourth', 'b9'), [1, 2, 3].map((n) => baseJob(`s${n}`, `sb${n}`)))).toBe(true);
    expect(canRunVeJob(baseJob('fourth', 'b9'), [1, 2, 3].map((n) => baseJob(`s${n}`, `sb${n}`)), 3)).toBe(false);
    expect(canRunVeJob(baseJob('light', 'b9', 'template'), [1, 2, 3].map((n) => baseJob(`s${n}`, `sb${n}`)), 3)).toBe(true);
    expect([undefined, '0', 'NaN', '1', '3', '99'].map(veBaseCollectConcurrency)).toEqual([16, 16, 16, 1, 3, 16]);
    // Real aggregate writes start from independent snapshots, so a missing
    // serialization would lose concurrent increments in this one project.
    const totals = { tokens_used: 0, cost_usd: 0 };
    const aggregateDb = { from: () => ({
      select: () => ({ eq: () => ({ abortSignal: () => ({ maybeSingle: async () => ({ data: { ...totals }, error: null }) }) }) }),
      update: (value: typeof totals) => ({ eq: () => ({ abortSignal: async () => { Object.assign(totals, value); return { error: null }; } }) }),
    }) } as unknown as SupabaseClient;
    const accumulate = createVeProjectUsageAccumulator(aggregateDb);
    await Promise.all(Array.from({ length: 16 }, () => accumulate('one', 10, 0.25)));
    expect(totals).toMatchObject({ tokens_used: 160, cost_usd: 4 });
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
