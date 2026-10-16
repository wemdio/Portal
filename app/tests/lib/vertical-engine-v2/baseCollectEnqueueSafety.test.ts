/** @jest-environment node */

import type { SupabaseClient } from '@supabase/supabase-js';
import { NextRequest } from 'next/server';

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { enqueueVeBaseCollect } from '@/lib/verticalEngineV2/baseCollectEnqueue';
import { claimVeJob, createVeJobPool, createVeProjectUsageAccumulator, canRunVeJob, veJobConcurrency, veBaseCollectConcurrency } from '@/lib/verticalEngineV2/jobQueue';
import type { VeJob } from '@/lib/verticalEngineV2/types';
import { runVeOutreachPreparations } from '@/lib/verticalEngineV2/outreachPreparation';
import { autoResumeVeTransientPreparations, enqueueVeContactReprojections, loadVeOutreachSetup } from '@/lib/verticalEngineV2/outreachSetup';
import { VeAutomaticContinuationChecks, veAutomaticContinuationCandidates, veAutomaticContinuationResultCurrent } from '@/components/vertical-engine-v2/engine/automaticContinuationCheck';
import type { VeBaseSummary, VeContinuationCheck } from '@/components/vertical-engine-v2/engine/api';
import { VE_RELEVANCE_RULES_VERSION } from '@/lib/verticalEngineV2/relevanceDecision';
import { VE_RELEVANCE_TRIAGE_VERSION } from '@/lib/verticalEngineV2/relevanceTriageConfig';
import { newVeAdaptiveCollection } from '@/lib/verticalEngineV2/adaptiveCollection';
import { checkVeContinuationRequest } from '@/lib/verticalEngineV2/preparationRequest';
import { getVeCollectionContinuation } from '@/lib/verticalEngineV2/collectionRecovery';

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
  it('refreshes audited retail previews before optional old reserve work without changing paid receipts or limits', async () => {
    const oldFlag = process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS;
    process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS = '';
    try {
      for (const mode of ['explicit', 'old-reserve', 'routine', 'manual', 'typed', 'us', 'launched', 'ongoing', 'child', 'round-limit'] as const) {
        const hypothesis = { id: 'retail-materials', project_id: input.projectId, vertical_id: input.verticalId,
          title: 'Производители строительно-отделочных материалов',
          description: 'Заводы сухих смесей, напольных покрытий, плитки и ЛКМ с собственным шоурумом и интернет-магазином. Потеря прямых частных заказов при передаче их сторонним дилерам.',
          broad: false, origin: mode === 'manual' ? 'manual' : 'generated', status: 'approved',
          ...(mode === 'typed' ? { audience_scope: { version: 1, kind: 'segment', any_of: ['Производители стройматериалов'],
            required: ['Собственный шоурум'], excluded: [] } } : {}) };
        const progress = { mode: 'preview', status: 'limited', round: mode === 'round-limit' ? 100 : 49, max_rounds: 100,
          ready_rows: 27, ready_target: 500, candidates_processed: 3151, max_candidates: 10000, idle_streak: 1 };
        const task = { source: 'companies_directory', directory_filters: { okvedCodes: ['28.29'] }, rationale: 'Old generator plan' };
        const ready = [{ company: 'Saved producer', email: 'ready@example.test', _email_status: 'ok' }];
        const info = { collection_mode: 'preview', hypotheses: [hypothesis], target_progress: progress,
          target_checkpoint: { completed_round: progress.round, seen_rows: [{ company: 'Seen producer', email: 'seen@example.test' }], processed_rows: 3151 },
          plan: { tasks: [task] }, tasks: [{ source: task.source, task, status: 'done', exhausted: true,
            child_job_id: 'paid-directory-child', directory_cursors: { old: 400 } }],
          source_contact_recovery: { version: 1, checked: { paid: { website: 'https://saved.test' } } },
          adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, widenings: 1 },
          saved_email_recovery: { version: 1, attempt_id: 'automatic:saved-retail', checked: { receipt: 'ok' }, automatic_checked: { receipt: 'ok' } },
          ...(mode === 'old-reserve' ? { relevance_reserve: { version: 1, rows: [
            { company: 'Old pending producer', email: 'pending@example.test', _email_status: 'unknown', _relevance_unchecked: true },
          ] } } : {}),
          ...(mode === 'child' ? { preview_pipeline: { version: 1, batches: [{ id: 'already-paid-child', bc_job_id: 'paid-constructor' }] } } : {}),
        };
        const base = { id: 'saved-retail', project_id: input.projectId, vertical_id: input.verticalId,
          hypothesis_id: hypothesis.id, source: 'auto', status: 'analyzed', row_count: 29, data: ready,
          updated_at: '2026-10-15T20:06:33Z', collection_continuation_revision: 4, collect_info: info };
        const db = createMockSupabase({ tables: { ve_hypotheses: [hypothesis], ve_bases: [base],
          ve_projects: [{ id: input.projectId, market: mode === 'us' ? 'us' : 'ru' }],
          ve_jobs: mode === 'ongoing' ? [{ id: 'current-job', project_id: input.projectId, stage: 'base_collect', status: 'running', payload: { base_id: base.id } }] : [],
          ve_templates: mode === 'launched' ? [{ id: 'live', base_id: base.id, launch_info: { campaign_id: 'live' } }] : [],
        } });
        const expectedRefresh = mode === 'explicit' || mode === 'old-reserve';
        if (expectedRefresh) expect(getVeCollectionContinuation(base, { ...hypothesis, collection_market: 'ru' })).toMatchObject({ available: true, code: 'source_update' });
        if (mode === 'child') expect(getVeCollectionContinuation(base, hypothesis)).toMatchObject({ available: true, code: 'saved_work' });
        if (mode === 'round-limit') expect(getVeCollectionContinuation(base, { ...hypothesis, collection_market: 'ru' })).toMatchObject({ available: false, code: 'round_limit' });
        const args = { ...input, hypothesisIds: [hypothesis.id], collectionMode: 'preview' as const,
          ...(mode === 'routine' ? {} : { resumeBaseId: base.id }) };
        await expect(enqueueVeBaseCollect(db as unknown as SupabaseClient, args)).resolves.toMatchObject({ ok: true });
        const saved = db.getRows('ve_bases')[0];
        expect(saved).toMatchObject({ row_count: 29, data: ready });
        if (expectedRefresh) {
          expect(saved.collect_info).toMatchObject({ audience_scope_refresh_requested: true,
            cost_policy: { version: 1, website_discovery: 'existing_only' },
            target_progress: { ...progress, status: 'collecting', round: 50 },
            target_checkpoint: info.target_checkpoint, tasks: info.tasks,
            source_contact_recovery: info.source_contact_recovery,
            saved_email_recovery: info.saved_email_recovery, adaptive_collection: info.adaptive_collection,
          });
          expect(saved.collect_info).not.toHaveProperty('validation_retry');
          expect(saved.collect_info).not.toHaveProperty('relevance_review_requested');
          if (mode === 'old-reserve') expect(saved.collect_info).toMatchObject({ relevance_reserve: info.relevance_reserve });
          await enqueueVeBaseCollect(db as unknown as SupabaseClient, args);
          expect(db.getRows('ve_jobs')).toHaveLength(1);
        } else {
          expect(saved.collect_info).not.toHaveProperty('audience_scope_refresh_requested');
          if (['routine', 'launched', 'round-limit'].includes(mode)) expect(db.getRows('ve_jobs')).toHaveLength(0);
          if (mode === 'ongoing') expect(db.getRows('ve_jobs')).toHaveLength(1);
        }
      }
    } finally {
      if (oldFlag === undefined) delete process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS;
      else process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS = oldFlag;
    }
  });

  it('applies a controlled source refresh only to an explicit unlaunched preview without growing its budget', async () => {
    const oldFlag = process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS;
    try {
      for (const mode of ['explicit', 'routine', 'disabled', 'manual', 'launched', 'round-limit', 'candidate-limit', 'lost-insert', 'raced', 'retry-marker', 'invalid-cost-marker', 'saved-at-cap'] as const) {
        process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS = mode === 'disabled' ? '' : input.projectId;
        const retryMarker = mode === 'retry-marker' || mode === 'invalid-cost-marker';
        const hypothesis = { id: 'fintech', project_id: input.projectId, vertical_id: input.verticalId,
          title: 'Финтех и платежное посредничество', description: 'Платёжные провайдеры и финтех-компании.',
          broad: true, origin: mode === 'manual' ? 'manual' : 'generated', status: 'approved' };
        const progress = { status: 'limited', round: mode === 'round-limit' || mode === 'saved-at-cap' ? 100 : 3, max_rounds: 100,
          ready_rows: 99, ready_target: 500, candidates_processed: mode === 'candidate-limit' ? 10000 : 400,
          max_candidates: 10000, idle_streak: 4 };
        const task = { source: 'companies_directory', directory_filters: { identityCatalog: 'payments_ru', nameTerms: ['платеж'] }, rationale: 'PSP' };
        const info = { collection_mode: 'preview', limit: 100, ready_target: 500, hypotheses: [hypothesis],
          target_progress: progress, target_checkpoint: { completed_round: progress.round, paid_receipt: 'preserve' },
          niche_source_profile: 'payments', source_selection: { profile: 'payments', version: 2 },
          plan: { tasks: [task, { ...task, directory_filters: { ...task.directory_filters, okvedCodes: ['66'] } }] },
          tasks: [task, { ...task, directory_filters: { ...task.directory_filters, okvedCodes: ['66'] } }]
            .map(savedTask => ({ source: 'companies_directory', status: 'done', exhausted: true, task: savedTask })),
          ...(mode === 'saved-at-cap' ? { relevance_reserve: { version: 1,
            rows: [{ company: 'Saved fintech', email: 'saved@example.test', _email_status: 'unknown' }] } } : {}),
          saved_email_recovery: { version: 1, attempt_id: 'automatic:saved', generation: 1, checked: { known: 'ok' }, automatic_checked: { known: 'ok' } } };
        const base = { id: 'saved-fintech', project_id: input.projectId, vertical_id: input.verticalId,
          hypothesis_id: hypothesis.id, source: 'auto', status: retryMarker ? 'failed' : 'analyzed', row_count: 99,
          error: retryMarker ? 'Provider usage journal could not be saved.' : null,
          updated_at: '2026-10-14T00:00:00Z', collection_continuation_revision: 4, collect_info: retryMarker
            ? { ...info, audience_scope_refresh_requested: true, cost_policy: { version: 1,
              website_discovery: mode === 'invalid-cost-marker' ? 'existing_then_configured' : 'existing_only' },
              target_progress: { ...progress, status: 'collecting', round: 4 } } : info };
        const db = createMockSupabase({ tables: { ve_hypotheses: [hypothesis], ve_bases: [base], ve_jobs: [],
          ve_templates: mode === 'launched' ? [{ id: 'live', base_id: base.id, launch_info: { campaign_id: 'live' } }] : [] },
          ...(mode === 'lost-insert' ? { errorInserts: { ve_jobs: { code: 'timeout', message: 'response lost', commitRow: true } } } : {}),
          ...(mode === 'raced' ? { beforeFirstUpdates: { ve_bases: (rows: Array<Record<string, unknown>>) => rows.map((row) => ({ ...row, collection_continuation_revision: 5 })) } } : {}),
        });
        const args = { ...input, hypothesisIds: [hypothesis.id], collectionMode: 'preview' as const,
          ...(mode !== 'routine' ? { resumeBaseId: base.id } : {}) };
        const before = JSON.stringify(db.getRows('ve_bases')[0].collect_info);
        if (mode === 'explicit') expect(getVeCollectionContinuation(base, hypothesis)).toMatchObject({ code: 'source_update', available: true });
        if (mode === 'round-limit' || mode === 'candidate-limit') expect(getVeCollectionContinuation(base, hypothesis)).toMatchObject({ available: false });
        if (mode === 'saved-at-cap') expect(getVeCollectionContinuation(base, hypothesis)).toMatchObject({ code: 'saved_work', available: true });
        const result = await enqueueVeBaseCollect(db as unknown as SupabaseClient, args);
        const changed = mode === 'explicit' || mode === 'lost-insert' || mode === 'retry-marker';
        expect(result.ok).toBe(mode !== 'raced' && mode !== 'invalid-cost-marker');
        if (changed) {
          expect(db.getRows('ve_bases')[0]).toMatchObject({ row_count: 99, status: 'collecting', collect_info: {
            audience_scope_refresh_requested: true, cost_policy: { version: 1, website_discovery: 'existing_only' },
            target_progress: { ...progress, status: 'collecting', round: 4 }, target_checkpoint: info.target_checkpoint,
            saved_email_recovery: info.saved_email_recovery, tasks: info.tasks,
          } });
          expect(db.getRows('ve_bases')[0].collect_info).not.toHaveProperty('validation_retry');
          await enqueueVeBaseCollect(db as unknown as SupabaseClient, args);
          expect(db.getRows('ve_jobs')).toHaveLength(1);
        } else if (mode === 'disabled' || mode === 'manual' || mode === 'saved-at-cap') {
          // Existing explicit continuation keeps its legacy behavior, but
          // cannot silently acquire the new scope or source-refresh marker.
          expect(db.getRows('ve_bases')[0].collect_info).not.toHaveProperty('audience_scope_refresh_requested');
          expect(db.getRows('ve_bases')[0].collect_info).not.toHaveProperty('cost_policy');
          expect(db.getRows('ve_bases')[0].collect_info).toMatchObject({ hypotheses: [hypothesis], tasks: info.tasks });
          if (mode === 'saved-at-cap') expect(db.getRows('ve_bases')[0].collect_info).toMatchObject({
            target_progress: { round: 100 }, validation_retry: true, relevance_review_requested: true,
          });
        } else {
          expect(JSON.stringify(db.getRows('ve_bases')[0].collect_info)).toBe(before);
          expect(db.getRows('ve_jobs')).toHaveLength(0);
        }
      }
    } finally {
      if (oldFlag === undefined) delete process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS;
      else process.env.VE_AUDIENCE_SCOPE_PROJECT_IDS = oldFlag;
    }
  });

  it('does not expose private candidate checkpoints on existing or mixed preview requests', async () => {
    const privateInfo = {
      collection_mode: 'preview', ready_target: 1_000, limit: 2_000,
      target_checkpoint: { seen_rows: [{ email: 'rejected@example.com' }] },
      source_contact_recovery: { version: 1, checked: { private: { website: 'https://private.test/' } } },
      tasks: [{ source: 'directory', rows: 25, harvest: [{ email: 'raw@example.com' }] }],
    };
    mockRouteDb = createMockSupabase({ tables: {
      ve_verticals: [{ id: input.verticalId, project_id: input.projectId, name: input.verticalName }],
      ve_hypotheses: ['hypothesis-1', 'hypothesis-2'].map((id) => ({ id, title: id,
        project_id: input.projectId, vertical_id: input.verticalId })),
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
          { id: 'hypothesis-1', title: 'Первая', project_id: input.projectId, vertical_id: input.verticalId },
          { id: 'hypothesis-2', title: 'Вторая', project_id: input.projectId, vertical_id: input.verticalId },
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

    for (const resumedFromPause of [false, true]) {
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
        ve_jobs: resumedFromPause ? [{ id: 'resumed-job', project_id: input.projectId, stage: 'base_collect',
          status: 'pending', payload: { base_id: 'cancelled-duplicate' } }] : [],
      }, rpcHandlers: {
        ve_claim_outreach_preparation: () => {
          if (claimed) return { data: [] };
          claimed = true;
          return { data: [{ project_id: input.projectId, hypothesis_id: 'h1', base_id: 'cancelled-duplicate',
            template_id: null, status: 'pending', language: 'ru', claim_token: 'lease',
            ...(resumedFromPause ? { pause_state: { resumed_base_id: 'cancelled-duplicate' } } : {}) }] };
        },
        ve_save_outreach_preparation: save,
        ve_resume_outreach_cancelled_base: async (_params, db) => {
          await db.from('ve_bases').update({ status: 'collecting', error: null }).eq('id', 'cancelled-duplicate');
          return { data: true };
        },
      } });
      await runVeOutreachPreparations(resumedDb as unknown as SupabaseClient);
      expect(save).toHaveBeenLastCalledWith(expect.objectContaining(resumedFromPause ? {
        p_status: 'collecting', p_base_id: 'cancelled-duplicate', p_template_id: null,
      } : {
        p_status: 'ready', p_base_id: 'old-ready', p_template_id: 'saved-letters',
      }), expect.anything());
      expect(resumedDb.getRows('ve_jobs')).toHaveLength(resumedFromPause ? 1 : 0);
      expect(resumedDb.rpcCalls.some((call) => call.fn === 've_resume_outreach_cancelled_base')).toBe(resumedFromPause);
    }

    // A terminal partial preview is resumed only by an explicit Continue for
    // that saved base. Routine enqueue still reuses it without daily spending.
    // 'rules': a completed website check from before the current selection
    // rules is resumable once, for the gate's one-time recheck of saved quotes.
    for (const mode of ['continue', 'routine', 'launched', 'checked', 'rules', 'staffing', 'manual'] as const) {
      let partialClaimed = false;
      const partialSave = jest.fn(() => ({ data: true }));
      const staffing = mode === 'staffing' || mode === 'manual';
      const currentHypothesis = { id: 'h1', title: staffing ? 'B2B SaaS с remote-командами' : 'Industrial plants',
        description: staffing ? 'SaaS-вендоры из СНГ, Европы, MENA и APAC, нанимающие специалистов в 2+ странах.' : '',
        origin: mode === 'manual' ? 'manual' : 'generated', broad: false,
        project_id: input.projectId, vertical_id: input.verticalId, status: 'approved' };
      const readyRows = staffing ? [{ company: 'Ready SaaS', website: 'ready.test', email: 'team@ready.test', _email_status: 'ok' }] : [];
      const sourceReceipts = { version: 1, checked: { paid: { website: 'https://plant.test', reason: 'verified' } } };
      const savedTasks = [{ source: 'hh_live', status: 'done', exhausted: true, child_job_id: 'paid-hh-child', rows: 17,
        task: { source: 'hh_live', hh_query: 'разработчик', rationale: 'saved source' },
        harvest: [{ company: 'Plant', website: 'plant.test', email: 'info@plant.test' }] }];
      const target = { mode: 'preview', status: 'limited', ready_rows: readyRows.length, ready_target: 500,
        candidates_processed: 17, round: 1, max_rounds: 100, max_candidates: 10000, first_round_candidates: 100 };
      const partialInfo = { collection_mode: 'preview', target_progress: target,
        target_checkpoint: { completed_round: 1, seen_rows: readyRows, processed_rows: 17 },
        relevance_reserve: { version: 1, rows: [{ company: 'Plant', website: 'plant.test', email: 'info@plant.test',
          _email_status: 'ok', _ve_relevance: { status: 'needs_review', review_attempts: 1,
            website_review_version: mode === 'checked' || mode === 'rules' || staffing ? 4 : 3,
            ...(mode === 'rules' ? {} : { rules_version: VE_RELEVANCE_RULES_VERSION }),
            ...(staffing ? { reason: 'Смысловое соответствие не подтверждено: Не подтверждена удалённая команда.',
              triage_version: VE_RELEVANCE_TRIAGE_VERSION } : {}) } }] },
        ...(staffing ? {
          // A stale generated snapshot must not override the specialist's
          // current manual hypothesis, nor lose newly loaded description.
          hypotheses: [{ id: 'h1', title: currentHypothesis.title, origin: 'generated' }],
          tasks: savedTasks, source_contact_recovery: sourceReceipts,
          adaptive_collection: { ...newVeAdaptiveCollection(), replan_attempts: 2, widenings: 2 },
        } : {}) };
      const partialDb = createMockSupabase({ tables: {
        ve_hypotheses: [currentHypothesis],
        ve_verticals: [{ id: input.verticalId, project_id: input.projectId, name: input.verticalName }],
        ve_bases: [{ id: 'saved-partial', project_id: input.projectId, vertical_id: input.verticalId, hypothesis_id: 'h1',
          source: 'auto', status: 'analyzed', row_count: readyRows.length, data: readyRows,
          collection_mode: 'preview', target_progress: target, collect_info: partialInfo,
          updated_at: '2026-10-14T00:00:00Z', collection_continuation_revision: 0,
          max_emails_per_company: null, contact_cap_applied: null }],
        ve_templates: mode === 'launched' ? [{ id: 'live-template', base_id: 'saved-partial', launch_info: { campaign_id: 'live' } }]
          : staffing ? [{ id: 'ready-letters', base_id: 'saved-partial', status: 'ready', supply_batch_id: null, launch_info: null }] : [],
        ve_outreach_setups: [{ project_id: input.projectId, revision: 7, selected_hypothesis_ids: ['h1'] }],
        ve_outreach_preparations: [{ project_id: input.projectId, hypothesis_id: 'h1', base_id: 'saved-partial',
          template_id: staffing ? 'ready-letters' : null, status: 'ready' }],
      }, rpcHandlers: {
        ve_claim_outreach_preparation: () => {
          if (partialClaimed) return { data: [] };
          partialClaimed = true;
          return { data: [{ project_id: input.projectId, hypothesis_id: 'h1', base_id: 'saved-partial',
            template_id: null, status: 'pending', resume_collection_requested: true, language: 'ru', claim_token: 'partial-lease' }] };
        },
        ve_save_outreach_preparation: partialSave,
      } });
      const partialClient = partialDb as unknown as SupabaseClient;
      if (staffing) {
        // The lightweight preflight uses current metadata without purchasing
        // work, altering a worker checkpoint or reviving a manual audience.
        await expect(checkVeContinuationRequest(partialClient, input.projectId, 7, 'h1')).resolves.toMatchObject({
          status: mode === 'staffing' ? 'available' : 'unavailable',
          code: mode === 'staffing' ? 'saved_work' : 'sources_exhausted', base_id: 'saved-partial' });
        expect(partialDb.getRows('ve_jobs')).toHaveLength(0);
        expect(partialDb.rpcCalls).toHaveLength(0);
        expect(partialDb.getRows('ve_bases')[0]).toMatchObject({ status: 'analyzed', data: readyRows,
          updated_at: '2026-10-14T00:00:00Z', collect_info: partialInfo });
        expect(partialDb.updates.every((update) => update.table === 've_bases'
          && Object.keys(update.patch).join(',') === 'collection_continuation')).toBe(true);
      }
      if (mode === 'routine') {
        await expect(enqueueVeBaseCollect(partialClient, { ...input, hypothesisIds: ['h1'], collectionMode: 'preview' }))
          .resolves.toMatchObject({ ok: true, created: false });
      } else await runVeOutreachPreparations(partialClient);
      expect(partialDb.getRows('ve_bases')).toHaveLength(1);
      const jobs = partialDb.getRows('ve_jobs');
      expect(jobs).toHaveLength(mode === 'continue' || mode === 'rules' || mode === 'staffing' ? 1 : 0);
      if (mode === 'continue' || mode === 'rules' || mode === 'staffing') {
        expect(jobs[0]).toMatchObject({ stage: 'base_collect', status: 'pending',
          payload: { base_id: 'saved-partial', hypothesis_id: 'h1', collection_mode: 'preview' } });
        expect(partialDb.getRows('ve_bases')[0]).toMatchObject({ status: 'collecting',
          collect_info: { relevance_review_requested: true, validation_retry: true,
            target_progress: { ready_rows: readyRows.length, candidates_processed: 17, round: 1 } } });
        if (staffing) expect(partialDb.getRows('ve_bases')[0]).toMatchObject({ row_count: readyRows.length, data: readyRows,
          collect_info: { hypotheses: [currentHypothesis], source_contact_recovery: sourceReceipts, tasks: savedTasks,
            target_checkpoint: partialInfo.target_checkpoint, relevance_reserve: partialInfo.relevance_reserve,
            adaptive_collection: partialInfo.adaptive_collection } });
        expect(partialSave).toHaveBeenLastCalledWith(expect.objectContaining({ p_status: 'collecting' }), expect.anything());
        await enqueueVeBaseCollect(partialClient, { ...input, hypothesisIds: ['h1'], collectionMode: 'preview', resumeBaseId: 'saved-partial' });
        expect(partialDb.getRows('ve_jobs')).toHaveLength(1);
      } else {
        expect(partialDb.getRows('ve_bases')[0].status).toBe('analyzed');
        if (mode === 'manual') expect(partialDb.getRows('ve_bases')[0]).toMatchObject({
          data: readyRows, collect_info: partialInfo, updated_at: '2026-10-14T00:00:00Z' });
      }
    }

    // A Continue action inside one card may not dispatch the project-wide RPC.
    const projectId = '00000000-0000-4000-8000-000000000301';
    const hypothesisId = '00000000-0000-4000-8000-000000000302';
    mockRouteDb = createMockSupabase({ tables: {
      ve_outreach_setups: [{ project_id: projectId, revision: 7, selected_hypothesis_ids: [hypothesisId] }],
      ve_hypotheses: [{ id: hypothesisId, project_id: projectId, vertical_id: input.verticalId, status: 'approved' }],
    }, rpcHandlers: {
      ve_request_outreach_preparation: () => ({ data: null }),
      ve_request_outreach_hypothesis_preparation: () => ({ data: null }),
    } });
    const request = (extra: Record<string, unknown>) => prepareOutreach(new NextRequest('http://portal.test/outreach', {
      method: 'POST', body: JSON.stringify({ action: 'prepare', revision: 7, ...extra }),
    }), { params: Promise.resolve({ id: projectId }) });
    expect((await request({ hypothesis_id: hypothesisId })).status).toBe(200);
    expect(mockRouteDb.rpcCalls).toEqual([expect.objectContaining({ fn: 've_request_outreach_hypothesis_preparation',
      params: { p_project_id: projectId, p_revision: 7, p_hypothesis_id: hypothesisId, p_resume_collection: false } })]);
    for (const invalid of [null, '', 'wrong-id']) expect((await request({ hypothesis_id: invalid })).status).toBe(400);
    expect(mockRouteDb.rpcCalls).toHaveLength(1);
    expect((await request({})).status).toBe(200);
    expect(mockRouteDb.rpcCalls[1].fn).toBe('ve_request_outreach_preparation');

    // Pause targets exactly one preparation; neither the project-wide stop
    // nor a new preparation may be dispatched by this action.
    mockRouteDb = createMockSupabase({ rpcHandlers: {
      ve_pause_outreach_hypothesis_preparation: () => ({ data: null }),
    } });
    expect((await request({ action: 'pause', hypothesis_id: hypothesisId })).status).toBe(200);
    expect(mockRouteDb.rpcCalls).toEqual([{ fn: 've_pause_outreach_hypothesis_preparation',
      params: { p_project_id: projectId, p_revision: 7, p_hypothesis_id: hypothesisId } }]);
    for (const invalid of [undefined, null, '', 'wrong-id']) {
      expect((await request({ action: 'pause', hypothesis_id: invalid })).status).toBe(400);
    }
    expect(mockRouteDb.rpcCalls).toHaveLength(1);
    mockRouteDb = createMockSupabase({ rpcHandlers: {
      ve_pause_outreach_hypothesis_preparation: () => ({ data: null, error: { message: 'Выбор изменился' } }),
    } });
    expect((await request({ action: 'pause', hypothesis_id: hypothesisId })).status).toBe(409);

    // A stale browser must not turn an unavailable continuation into a new
    // paid collection or reset the ready preparation. The exact decision is
    // persisted without altering the base's worker checkpoint or timestamp.
    const stoppedTarget = { mode: 'preview', status: 'limited', ready_rows: 10, ready_target: 500,
      round: 100, max_rounds: 100, candidates_processed: 10000, max_candidates: 10000 };
    const stoppedInfo = { collection_mode: 'preview', target_progress: stoppedTarget,
      target_checkpoint: { completed_round: 100 }, tasks: [] };
    const setupRows = { ve_outreach_setups: [{ project_id: projectId, revision: 7, selected_hypothesis_ids: [hypothesisId] }],
      ve_hypotheses: [{ id: hypothesisId, project_id: projectId, vertical_id: input.verticalId, status: 'approved' }] };
    mockRouteDb = createMockSupabase({ tables: { ...setupRows,
      ve_outreach_preparations: [{ project_id: projectId, hypothesis_id: hypothesisId, base_id: 'stopped', template_id: 'letters', status: 'ready' }],
      ve_bases: [{ id: 'stopped', project_id: projectId, hypothesis_id: hypothesisId, source: 'auto', status: 'analyzed',
        row_count: 10, updated_at: '2026-10-12T10:00:00Z', collection_continuation_revision: 0,
        max_emails_per_company: null, contact_cap_applied: null, collect_info: stoppedInfo }],
      ve_templates: [{ id: 'letters', base_id: 'stopped', status: 'ready', supply_batch_id: null, launch_info: null }],
    }, rpcHandlers: { ve_request_outreach_hypothesis_preparation: () => ({ data: null }) } });
    for (let click = 0; click < 2; click++) {
      const blocked = await request({ hypothesis_id: hypothesisId });
      expect(blocked.status).toBe(409);
      expect(await blocked.json()).toMatchObject({ preparation_action: { status: 'unavailable', hypothesis_id: hypothesisId } });
    }
    expect(mockRouteDb.rpcCalls).toHaveLength(0);
    expect(mockRouteDb.getRows('ve_jobs')).toHaveLength(0);
    expect(mockRouteDb.getRows('ve_bases')[0]).toMatchObject({ status: 'analyzed', collect_info: stoppedInfo,
      updated_at: '2026-10-12T10:00:00Z' });
    expect(mockRouteDb.getRows('ve_outreach_preparations')[0].status).toBe('ready');

    // Checking continuation is distinct from requesting it. Both an exhausted
    // and an available saved source plan may update only the decision cache.
    const stoppedDb = mockRouteDb;
    const checkedStopped = await request({ action: 'check_continuation', hypothesis_id: hypothesisId });
    expect(checkedStopped.status).toBe(200);
    expect(await checkedStopped.json()).toMatchObject({ continuation_check: {
      status: 'unavailable', action: null, hypothesis_id: hypothesisId, base_id: 'stopped', code: 'candidate_limit',
    } });
    expect(stoppedDb.getRows('ve_bases')[0].collection_continuation).toBeTruthy();
    expect(stoppedDb.rpcCalls).toHaveLength(0);
    const availableInfo = { collection_mode: 'preview',
      target_progress: { ...stoppedTarget, round: 1, candidates_processed: 10 },
      target_checkpoint: { completed_round: 1 },
      tasks: [{ source: 'companies_directory', status: 'pending', rows: 0, child_job_id: null,
        task: { source: 'companies_directory', rationale: 'saved source', directory_filters: { okvedCodes: ['62'] } } }],
    };
    for (const mode of ['available', 'busy', 'launched', 'stale', 'unselected', 'foreign-base', 'race', 'read-failure'] as const) {
      const checkBase = { ...stoppedDb.getRows('ve_bases')[0], collect_info: availableInfo, collection_continuation: null,
        project_id: mode === 'foreign-base' ? '00000000-0000-4000-8000-000000000399' : projectId };
      mockRouteDb = createMockSupabase({ tables: {
        ...setupRows,
        ve_outreach_setups: [{ project_id: projectId, revision: 7,
          selected_hypothesis_ids: mode === 'unselected' ? [] : [hypothesisId] }],
        ve_outreach_preparations: [{ project_id: projectId, hypothesis_id: hypothesisId,
          base_id: 'stopped', template_id: 'letters', status: 'ready' }],
        ve_bases: [checkBase],
        ve_templates: [{ id: 'letters', base_id: 'stopped', status: 'ready', supply_batch_id: null,
          launch_info: mode === 'launched' ? { campaign_ids: ['campaign'] } : null }],
        ve_jobs: mode === 'busy' ? [{ id: 'collect-running', project_id: projectId, stage: 'base_collect',
          status: 'running', payload: { base_id: 'stopped' } }] : [],
      },
      ...(mode === 'race' ? { beforeFirstUpdates: { ve_bases: (rows) => rows.map((row) => ({
        ...row, collection_continuation_revision: 1, collection_continuation: null,
      })) } } : {}),
      ...(mode === 'read-failure' ? { errorSelects: { ve_bases: { columnsInclude: 'collect_info', message: 'db unavailable' } } } : {}),
      rpcHandlers: { ve_request_outreach_preparation: () => ({ data: null }),
        ve_request_outreach_hypothesis_preparation: () => ({ data: null }) } });
      const checked = await request({ action: 'check_continuation', hypothesis_id: hypothesisId,
        ...(mode === 'stale' ? { revision: 6 } : {}) });
      expect(checked.status).toBe(mode === 'read-failure' ? 503 : 200);
      const body = await checked.json();
      if (mode === 'available' || mode === 'unselected') {
        expect(body.continuation_check).toMatchObject({ status: 'available', action: 'resume_collection', base_id: 'stopped', code: 'sources_available', cache_revision: 0 });
        expect(body.continuation_check.reason).toContain('ещё не запущено');
        expect(body.continuation_check).not.toHaveProperty('resume_collection');
        expect(body).not.toHaveProperty('preparation_action');
        expect(mockRouteDb.getRows('ve_bases')[0].collection_continuation).toBeTruthy();
        // The automatic path skips all project-wide preview/review reads;
        // the earlier full response remains supported for rolling clients.
        jest.mocked(loadVeOutreachSetup).mockClear();
        const slim = await request({ action: 'check_continuation', check_only: true, hypothesis_id: hypothesisId });
        expect(slim.status).toBe(200);
        expect(Object.keys(await slim.json())).toEqual(['continuation_check']);
        expect(loadVeOutreachSetup).not.toHaveBeenCalled();
      } else if (mode === 'busy') expect(body.continuation_check).toMatchObject({ status: 'already_running', action: null, code: 'already_running' });
      else if (mode === 'launched') expect(body.continuation_check).toMatchObject({ status: 'ready', action: null, code: 'launched' });
      else if (mode !== 'read-failure') expect(body.continuation_check).toMatchObject({ status: 'unavailable',
        code: mode === 'stale' ? 'selection_changed'
          : mode === 'foreign-base' ? 'base_missing' : 'state_changed' });
      expect(mockRouteDb.rpcCalls).toHaveLength(0);
      expect(mockRouteDb.inserts).toHaveLength(0);
      expect(mockRouteDb.getRows('ve_jobs')).toHaveLength(mode === 'busy' ? 1 : 0);
      expect(mockRouteDb.getRows('ve_bases')[0]).toMatchObject({ status: 'analyzed', collect_info: availableInfo,
        updated_at: '2026-10-12T10:00:00Z' });
      expect(mockRouteDb.getRows('ve_outreach_preparations')[0].status).toBe('ready');
      expect(mockRouteDb.getRows('ve_outreach_setups')[0].selected_hypothesis_ids).toEqual(mode === 'unselected' ? [] : [hypothesisId]);
      for (const update of mockRouteDb.updates) {
        expect(update.table).toBe('ve_bases');
        expect(Object.keys(update.patch)).toEqual(['collection_continuation']);
      }
    }
    mockRouteDb = stoppedDb;
    for (const invalid of [undefined, null, '', 'wrong-id']) {
      expect((await request({ action: 'check_continuation', hypothesis_id: invalid })).status).toBe(400);
    }
    expect(mockRouteDb.rpcCalls).toHaveLength(0);
    expect((await request({ action: 'check_continuation', check_only: 'true', hypothesis_id: hypothesisId })).status).toBe(400);

    // Automatic inspection is scoped to visible selected preview cards. Its
    // queue cannot turn polling, a rerender or parallel cards into a retry loop.
    const autoBase = { ...stoppedDb.getRows('ve_bases')[0], collect_info: availableInfo,
      collection_continuation: { available: true, action: 'resume_preparation', code: 'state_unchecked', reason: 'Unknown' } } as unknown as VeBaseSummary;
    const autoInput = { projectId, step: 3, activeHypothesisId: hypothesisId, setupRevision: 7,
      visibleHypothesisIds: [hypothesisId, 'other'],
      preparations: [
        { project_id: projectId, hypothesis_id: hypothesisId, base_id: 'stopped', template_id: 'letters', status: 'ready' as const, language: 'ru' as const, last_error: null },
        { project_id: projectId, hypothesis_id: 'other', base_id: 'other', template_id: 'other-letters', status: 'error' as const, language: 'ru' as const, last_error: 'Failed' },
      ], bases: [autoBase, { ...autoBase, id: 'other', hypothesis_id: 'other', status: 'failed' as const }],
      jobs: [], launchedBaseIds: new Set<string>() };
    const candidates = veAutomaticContinuationCandidates(autoInput);
    expect(candidates.map((candidate) => candidate.baseId)).toEqual(['stopped', 'other']);
    expect(veAutomaticContinuationCandidates({ ...autoInput, step: 2 }).map((candidate) => candidate.baseId)).toEqual(['stopped']);
    expect(veAutomaticContinuationCandidates({ ...autoInput, step: 4 })).toHaveLength(0);
    expect(veAutomaticContinuationCandidates({ ...autoInput, visibleHypothesisIds: [] })).toHaveLength(0);
    expect(veAutomaticContinuationCandidates({ ...autoInput, launchedBaseIds: new Set(['stopped', 'other']) })).toHaveLength(0);
    expect(veAutomaticContinuationCandidates({ ...autoInput, preparations: autoInput.preparations.map((row) => ({ ...row, status: 'pending' })) })).toHaveLength(0);
    const inactivePending = { ...autoInput, selectedHypothesisIds: [], preparations: autoInput.preparations.map((row) => ({
      ...row, status: 'pending' as const, independent_control: false,
    })) };
    expect(veAutomaticContinuationCandidates(inactivePending).map((candidate) => candidate.baseId)).toContain('stopped');
    expect(veAutomaticContinuationCandidates({ ...inactivePending, preparations: inactivePending.preparations.map((row) => ({
      ...row, independent_control: true,
    })) })).toHaveLength(0);
    expect(veAutomaticContinuationCandidates({ ...autoInput, bases: autoInput.bases.map((row) => ({ ...row, source: 'upload' })) })).toHaveLength(0);
    expect(veAutomaticContinuationCandidates({ ...autoInput, bases: autoInput.bases.map((row) => ({ ...row,
      collect_info: { ...row.collect_info, collection_mode: 'supply' } })) })).toHaveLength(0);
    expect(veAutomaticContinuationCandidates({ ...autoInput, bases: autoInput.bases.map((row) => ({ ...row,
      collection_continuation: { available: false, action: null, code: 'already_running', reason: 'Running' } })) })).toHaveLength(0);
    const queue = new VeAutomaticContinuationChecks();
    expect(queue.next(candidates, 0).candidate).toEqual(candidates[0]);
    expect(queue.start(candidates[0], 0)).toBe(true);
    expect(queue.start(candidates[1], 0)).toBe(false);
    expect(queue.next(candidates, 1)).toEqual({});
    queue.finish(candidates[0], true, 0);
    expect(queue.next(candidates, 1).candidate).toEqual(candidates[1]);
    expect(queue.start(candidates[1], 1)).toBe(true);
    queue.finish(candidates[1], false, 1);
    expect(queue.next(candidates, 29_999)).toEqual({ retryAt: 30_000 });
    expect(queue.start(candidates[0], 29_999)).toBe(false);
    expect(queue.start(candidates[0], 30_000)).toBe(true);
    queue.finish(candidates[0], true, 30_000);
    expect(queue.next(candidates, 100_000)).toEqual({ retryAt: undefined });
    const changedCandidates = veAutomaticContinuationCandidates({ ...autoInput,
      bases: autoInput.bases.map((row) => ({ ...row, collection_continuation_revision: 1 })) });
    expect(queue.next(changedCandidates, 100_000).candidate).toEqual(changedCandidates[0]);
    const autoResult: VeContinuationCheck = { status: 'available', action: 'resume_collection', hypothesis_id: hypothesisId,
      base_id: 'stopped', cache_revision: 0, code: 'sources_available', reason: 'Available' };
    expect(veAutomaticContinuationResultCurrent(candidates[0], autoResult, candidates[0])).toBe(true);
    expect(veAutomaticContinuationResultCurrent(candidates[0], autoResult, changedCandidates[0])).toBe(false);
    expect(veAutomaticContinuationResultCurrent(candidates[0], { ...autoResult, cache_revision: 1 }, candidates[0])).toBe(false);
    expect(veAutomaticContinuationResultCurrent(candidates[0], { ...autoResult, base_id: 'other' }, candidates[0])).toBe(false);
    expect(veAutomaticContinuationResultCurrent(candidates[0], { ...autoResult, code: 'state_changed' }, candidates[0])).toBe(false);
    expect(veAutomaticContinuationResultCurrent(candidates[0], autoResult,
      veAutomaticContinuationCandidates({ ...autoInput, setupRevision: 8 })[0])).toBe(false);

    // Exhausted collection must not block finishing failed letters, and a
    // live job must not receive a second request from an old browser tab.
    await mockRouteDb.from('ve_templates').update({ status: 'failed' }).eq('id', 'letters');
    const checkedLetters = await request({ action: 'check_continuation', hypothesis_id: hypothesisId });
    expect(checkedLetters.status).toBe(200);
    expect(await checkedLetters.json()).toMatchObject({ continuation_check: { status: 'available',
      action: 'resume_preparation', base_id: 'stopped', code: 'preparation_incomplete' } });
    expect(mockRouteDb.rpcCalls).toHaveLength(0);
    expect(mockRouteDb.getRows('ve_jobs')).toHaveLength(0);
    expect(mockRouteDb.getRows('ve_outreach_preparations')[0].status).toBe('ready');
    const retryLetters = await request({ hypothesis_id: hypothesisId });
    expect(retryLetters.status).toBe(200);
    expect(await retryLetters.json()).toMatchObject({ preparation_action: { status: 'queued' } });
    expect(mockRouteDb.rpcCalls).toHaveLength(1);
    await mockRouteDb.from('ve_jobs').insert({ id: 'active-letters', project_id: projectId, stage: 'template',
      status: 'pending', payload: { base_id: 'stopped' } });
    const alreadyRunning = await request({ hypothesis_id: hypothesisId });
    expect(alreadyRunning.status).toBe(200);
    expect(await alreadyRunning.json()).toMatchObject({ preparation_action: { status: 'already_running' } });
    expect(mockRouteDb.rpcCalls).toHaveLength(1);
    await mockRouteDb.from('ve_jobs').update({ status: 'done' });
    await mockRouteDb.from('ve_templates').update({ status: 'ready' });
    await mockRouteDb.from('ve_outreach_preparations').update({ status: 'error', template_id: null });
    const repairLink = await request({ hypothesis_id: hypothesisId });
    expect(await repairLink.json()).toMatchObject({ preparation_action: { status: 'queued', code: 'preparation_incomplete' } });
    expect(mockRouteDb.rpcCalls.at(-1)).toMatchObject({ params: { p_resume_collection: false } });

    // The coordinator must honor that request by finishing letters only,
    // even when the partial preview could otherwise open another source round.
    let lettersClaimed = false;
    const lettersSave = jest.fn(() => ({ data: true }));
    const unfinishedLettersDb = createMockSupabase({ tables: {
      ve_hypotheses: [{ id: hypothesisId, project_id: projectId, vertical_id: input.verticalId, status: 'approved' }],
      ve_bases: [{ id: 'letters-only-base', project_id: projectId, hypothesis_id: hypothesisId, source: 'auto',
        status: 'analyzed', row_count: 10, collection_mode: 'preview',
        target_progress: { ...stoppedTarget, round: 1, candidates_processed: 10 },
        collect_info: { collection_mode: 'preview', target_checkpoint: { completed_round: 1 },
          target_progress: { ...stoppedTarget, round: 1, candidates_processed: 10 },
          tasks: [{ status: 'pending', task: { source: 'directory', query: 'saved source' } }] } }],
      ve_templates: [{ id: 'failed-letters', base_id: 'letters-only-base', status: 'failed', supply_batch_id: null }],
      ve_jobs: [{ id: 'old-letter-job', project_id: projectId, stage: 'template', status: 'failed',
        payload: { base_id: 'letters-only-base' } }],
    }, rpcHandlers: {
      ve_claim_outreach_preparation: () => {
        if (lettersClaimed) return { data: [] };
        lettersClaimed = true;
        return { data: [{ project_id: projectId, hypothesis_id: hypothesisId, base_id: 'letters-only-base',
          template_id: 'failed-letters', status: 'pending', language: 'ru', claim_token: 'letters-lease' }] };
      },
      ve_save_outreach_preparation: lettersSave,
      ve_enqueue_outreach_preparation_job: () => ({ data: { ok: true } }),
    } });
    await runVeOutreachPreparations(unfinishedLettersDb as unknown as SupabaseClient);
    expect(unfinishedLettersDb.rpcCalls.filter((call) => call.fn === 've_enqueue_outreach_preparation_job'))
      .toEqual([expect.objectContaining({ params: expect.objectContaining({ p_stage: 'template', p_base_id: 'letters-only-base' }) })]);
    expect(unfinishedLettersDb.getRows('ve_bases')).toHaveLength(1);
    expect(unfinishedLettersDb.getRows('ve_bases')[0].status).toBe('analyzed');
    expect(unfinishedLettersDb.getRows('ve_jobs').some((job) => job.stage === 'base_collect')).toBe(false);
    expect(lettersSave).toHaveBeenLastCalledWith(expect.objectContaining({ p_status: 'generating' }), expect.anything());
    // Linking an already prepared partial result is also preparation only.
    // It may not be mistaken for consent to purchase another source round.
    lettersClaimed = false;
    await unfinishedLettersDb.from('ve_templates').update({ status: 'ready' });
    await runVeOutreachPreparations(unfinishedLettersDb as unknown as SupabaseClient);
    expect(lettersSave).toHaveBeenLastCalledWith(expect.objectContaining({ p_status: 'ready', p_template_id: 'failed-letters' }), expect.anything());
    expect(unfinishedLettersDb.getRows('ve_jobs').some((job) => job.stage === 'base_collect')).toBe(false);
    expect(unfinishedLettersDb.rpcCalls.filter((call) => call.fn === 've_enqueue_outreach_preparation_job')).toHaveLength(1);

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

    // Resuming a source must retain completed email results. Only an actual
    // failed email-recovery stage admits a fresh bounded pass for unknowns.
    const emailState = { version: 1, attempt_id: 'automatic:saved', generation: 3,
      checked: { unknown: 'unknown', valid: 'ok', invalid: 'invalid' }, automatic_checked: { unknown: 'unknown', valid: 'ok' } };
    const partialInfo = { collection_mode: 'preview', limit: 100, ready_target: 500,
      target_progress: { status: 'limited', round: 1, max_rounds: 100, ready_rows: 10, ready_target: 500,
        candidates_processed: 100, max_candidates: 10_000 }, target_checkpoint: { completed_round: 1 },
      tasks: [{ source: 'companies_directory', status: 'done', exhausted: false,
        task: { source: 'companies_directory', directory_filters: { okvedCodes: ['86'] } } }],
      saved_email_recovery: emailState };
    const resumeInput = { ...input, hypothesisIds: ['h1'], collectionMode: 'preview' as const, resumeBaseId: 'saved' };
    for (const mode of ['source', 'interrupted', 'email-failure'] as const) {
      const child = { id: '00000000-0000-4000-8000-000000000401', started_at: '2026-10-12T10:00:00Z', emails: ['pending@example.test'] };
      const state = mode === 'email-failure' ? { ...emailState, error: 'Email worker unavailable', batch: child } : emailState;
      const info = mode === 'source' ? partialInfo : { ...partialInfo,
        target_progress: { ...partialInfo.target_progress, status: mode === 'interrupted' ? 'collecting' : 'error' },
        ...(mode === 'interrupted' ? { relevance_review_requested: true } : { construct: { status: 'done', bc_job_id: 'paid-constructor' } }),
        saved_email_recovery: state };
      const saved = { id: 'saved', project_id: input.projectId, vertical_id: input.verticalId, hypothesis_id: 'h1', source: 'auto',
        status: mode === 'source' ? 'analyzed' : 'failed', updated_at: '2026-10-12T10:00:00Z', collection_continuation_revision: 4,
        error: mode === 'source' ? null : mode === 'interrupted' ? 'Provider usage journal could not be saved.' : 'Проверка email завершилась не полностью',
        collect_info: info };
      const resumeDb = createMockSupabase({ tables: { ve_hypotheses: [{ id: 'h1', title: 'Medicine' }], ve_bases: [saved], ve_jobs: [] } });
      const client = resumeDb as unknown as SupabaseClient;
      await expect(enqueueVeBaseCollect(client, resumeInput)).resolves.toMatchObject({ ok: true, created: true });
      const stored = resumeDb.getRows('ve_bases')[0].collect_info as typeof info;
      expect(stored.target_progress).toMatchObject({ max_candidates: 10_000, candidates_processed: 100 });
      if (mode === 'email-failure') expect(stored.saved_email_recovery).toEqual({ ...emailState, generation: 4,
        checked: { valid: 'ok', invalid: 'invalid' }, automatic_checked: { valid: 'ok' }, batch: child });
      else expect(stored.saved_email_recovery).toEqual(emailState);
      await expect(enqueueVeBaseCollect(client, resumeInput)).resolves.toMatchObject({ ok: true, created: false });
      expect(resumeDb.getRows('ve_jobs')).toHaveLength(1);
      expect(resumeDb.getRows('ve_bases')).toHaveLength(1);
    }
    // Either CAS token changing invalidates an old collect_info snapshot,
    // including a legacy writer which forgot to advance updated_at.
    for (const changed of [{ updated_at: '2026-10-12T10:01:00Z' }, { collection_continuation_revision: 5 }]) {
      const currentInfo = { ...partialInfo, specialist_change: true };
      const racedDb = createMockSupabase({ tables: { ve_hypotheses: [{ id: 'h1', title: 'Medicine' }],
        ve_bases: [{ id: 'saved', project_id: input.projectId, vertical_id: input.verticalId, hypothesis_id: 'h1', source: 'auto', status: 'analyzed',
          updated_at: '2026-10-12T10:00:00Z', collection_continuation_revision: 4, collect_info: partialInfo }], ve_jobs: [] },
        beforeFirstUpdates: { ve_bases: (rows) => rows.map((row) => ({ ...row, ...changed, collect_info: currentInfo })) } });
      await expect(enqueueVeBaseCollect(racedDb as unknown as SupabaseClient, resumeInput)).resolves.toMatchObject({ ok: false });
      expect(racedDb.getRows('ve_bases')[0]).toMatchObject({ status: 'analyzed', collect_info: currentInfo });
      expect(racedDb.getRows('ve_jobs')).toHaveLength(0);
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
