/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import {
  createGuardedContactDeliveryTick,
  runBoundContactDeliveries,
} from '@/lib/verticalEngineV2/contactDeliveryScheduler';
import { buildContactSupplyRequests, runProjectContactSupply } from '@/lib/verticalEngineV2/contactSupplyRunner';
import { allocateContactSupplyTargets } from '@/lib/verticalEngineV2/contactSupplyPlanner';
import { prepareAuditSnapshot, runSegmentationAuditStage, toStoredAuditSummary } from '@/lib/verticalEngineV2/stages/segmentationAudit';
import { buildSegmentationAudit } from '@/lib/verticalEngineV2/segmentationAudit';

const COMPLETE_BINDING = {
  portal_project_id: '20000000-0000-0000-0000-000000000001',
  portal_period_id: '30000000-0000-0000-0000-000000000001',
  target_contacts: 100,
  delivery_schedule_days: [1, 2, 3, 4, 5],
  delivery_timezone: 'Europe/Moscow',
  sender_daily_capacity: 20,
  delivery_plan_bound_at: '2026-09-02T10:00:00.000Z',
  delivery_plan_bound_by: '40000000-0000-0000-0000-000000000001',
  launch_preset_id: 'preset-1',
};

describe('VE2 contact delivery scheduler', () => {
  it('runs only complete bindings and isolates one project failure from the next', async () => {
    const portal = createMockSupabase({
      tables: {
        ve_projects: [
          { id: 've-1', ...COMPLETE_BINDING },
          { id: 've-partial', ...COMPLETE_BINDING, delivery_plan_bound_by: null },
          { id: 've-2', ...COMPLETE_BINDING, portal_period_id: 'period-2' },
          { id: 've-queued', ...COMPLETE_BINDING, portal_period_id: 'period-queued' },
        ],
        ve_launch_queue_items: [
          { id: 'item-1', project_id: 've-1', status: 'active' },
          { id: 'item-2', project_id: 've-2', status: 'active' },
          { id: 'item-queued', project_id: 've-queued', status: 'queued' },
        ],
      },
      enforceQueryWindows: true,
    });
    const runProject = jest.fn(async ({ veProjectId }: { veProjectId: string }) => {
      if (veProjectId === 've-1') throw new Error('provider timeout');
      return {
        status: 'completed' as const,
        runId: 'run-2',
        runDate: '2026-09-02',
        accepted: 2,
        skipped: 0,
        uncertain: 0,
      };
    });
    const log = jest.fn();
    const runSupply = jest.fn(async ({ veProjectId }: { veProjectId: string }) => {
      if (veProjectId === 've-1') throw new Error('source temporarily unavailable');
      return {};
    });

    const result = await runBoundContactDeliveries({
      portalDb: portal as never,
      instantlyDb: {} as never,
      now: new Date('2026-09-02T12:00:00.000Z'),
      runProject: runProject as never,
      runSupply: runSupply as never,
      log,
    });

    expect(runProject.mock.calls.map(([input]) => input.veProjectId)).toEqual(['ve-1', 've-2']);
    expect(runSupply.mock.calls.map(([input]) => input.veProjectId)).toEqual(['ve-1', 've-2']);
    expect(result).toEqual({
      skipped: false,
      eligibleProjects: 2,
      attemptedProjects: 2,
      failedProjects: 1,
    });
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('ve-1'),
      expect.any(Error),
    );
  });

  it('requests only the weighted two-day buffer deficit and caps each collection batch', () => {
    expect(allocateContactSupplyTargets(3, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }]))
      .toEqual([{ itemId: 'a', contacts: 2 }, { itemId: 'b', contacts: 1 }]);
    expect(allocateContactSupplyTargets(0, [{ id: 'a', weight: 1 }])).toEqual([{ itemId: 'a', contacts: 0 }]);
    expect(buildContactSupplyRequests(100, [
      { id: 'first', weight: 60, ready: 10 }, { id: 'second', weight: 40, ready: 0 },
    ])).toEqual([{ itemId: 'first', readyTarget: 50 }, { itemId: 'second', readyTarget: 40 }]);
    expect(buildContactSupplyRequests(20, [{ id: 'full', weight: 1, ready: 20 }])).toEqual([]);
    expect(buildContactSupplyRequests(5000, [{ id: 'large', weight: 1, ready: 0 }]))
      .toEqual([{ itemId: 'large', readyTarget: 1000 }]);
    expect(() => buildContactSupplyRequests(Number.NaN, [])).toThrow();
  });

  it('fences supply approval, reuses one batch, audits fully and appends only into original campaigns', async () => {
    let approved = false;
    const template = { id: 'supply-template', base_id: 'supply-base', status: 'ready', letters: [], personalization_plan: {} };
    const portal = createMockSupabase({
      enforceQueryWindows: true,
      tables: {
        ve_contact_supply_plans: [{ id: 'plan', project_id: 've', hypothesis_id: 'hyp', template_id: 'original-template', item_id: 'item', status: 'active' }],
        ve_projects: [{ id: 've', ...COMPLETE_BINDING, launch_instantly_account_id: 'main' }],
        project_periods: [{ id: COMPLETE_BINDING.portal_period_id, project_id: COMPLETE_BINDING.portal_project_id, status: 'active', contacts_done: '0', deadline: '2026-09-11' }],
        ve_launch_queue_items: [{ id: 'item', project_id: 've', status: 'active', potential_pct: 70 }],
        ve_launch_queue_campaigns: [{ id: 'campaign-row', item_id: 'item', campaign_id: 'original-campaign', segment: null }],
        ve_templates: [template],
        ve_contact_delivery_rows: [0, 1, 2].map((n) => ({ id: `row-${n}`, ve_project_id: 've', campaign_row_id: 'campaign-row', email_normalized: `existing${n}@example.test`, status: 'ready' })),
      },
      rpcHandlers: {
        ve_contact_supply_approval_current: () => ({ data: approved }),
        ve_require_contact_supply_active: (_params, db) => ({
          data: null,
          error: db.getRows('ve_contact_supply_plans')[0].status === 'active' && approved
            ? undefined : { message: 'supply plan is not active' },
        }),
        ve_contact_supply_preview_revision: () => ({ data: 'a'.repeat(32) }),
        ve_pause_contact_supply_plan: async (_params, db) => {
          await db.from('ve_contact_supply_plans').update({ status: 'paused' }).eq('id', 'plan');
          return { data: true };
        },
        ve_finish_contact_supply_batch: async (params, db) => {
          await db.from('ve_contact_supply_plans').update({ status: params.p_status, source_state: { previous_base_id: 'supply-base' } }).eq('id', 'plan');
          return { data: true };
        },
        ve_enqueue_contact_supply_batch: async (params, db) => {
          if (db.getRows('ve_contact_supply_batches').length) return { data: { created: true } };
          await db.from('ve_contact_supply_batches').insert({ id: 'batch', plan_id: 'plan', base_id: 'supply-base', template_id: template.id, status: 'collecting' });
          await db.from('ve_bases').insert({ id: 'supply-base', project_id: 've', status: 'collecting', source: 'auto', columns: ['email'], data: [] });
          return { data: { created: true, base_id: 'supply-base', batch: 'batch', requested_count: params.p_limit } };
        },
        ve_enqueue_contact_supply_audit: async (_params, db) => {
          const base = db.getRows('ve_bases')[0];
          const snapshot = prepareAuditSnapshot(template as never, base as never);
          const classification = { assignments: new Map(snapshot.audience.leads.map((_, index) => [index, null])), unclassifiedRows: [], failedBatches: 0, totalBatches: 0, usage: { tokensUsed: 0, costUsd: 0 } };
          const report = buildSegmentationAudit({ templateId: template.id, baseId: 'supply-base', ...snapshot, classification });
          await db.from('ve_segmentation_audits').insert({ id: 'audit', project_id: 've', template_id: template.id, base_id: 'supply-base', status: 'ready', input_hash: report.inputHash, segment_keys: [], summary: toStoredAuditSummary(report), assignments: [...classification.assignments].map(([row_index, segment]) => ({ row_index, segment })) });
          await db.from('ve_contact_supply_batches').update({ status: 'auditing', audit_id: 'audit' }).eq('id', 'batch');
          return { data: { audit_id: 'audit', status: 'ready' } };
        },
        ve_append_contact_supply_batch: async (_params, db) => {
          await db.from('ve_contact_supply_batches').update({ status: 'appended', appended_count: 1 }).eq('id', 'batch');
          return { data: { appended_count: 1, replayed: false } };
        },
      },
    });
    const instantly = createMockSupabase({
      tables: { client_campaign_presets: [{ id: 'preset-1', client_user_id: 'client', instantly_account_id: 'main' }] },
      rpcHandlers: { client_blocklist_snapshot: () => ({ data: { count: 1, emails: ['blocked@example.test'] } }) },
    });
    const input = { portalDb: portal as never, instantlyDb: instantly as never, veProjectId: 've', now: new Date('2026-09-07T06:00:00Z') };
    await runProjectContactSupply(input);
    expect(portal.getRows('ve_contact_supply_plans')[0].status).toBe('paused');
    expect(portal.rpcCalls.some((call) => call.fn === 've_enqueue_contact_supply_batch')).toBe(false);
    approved = true;
    await portal.from('ve_contact_supply_plans').update({ status: 'active' }).eq('id', 'plan');
    await runProjectContactSupply(input);
    expect(portal.rpcCalls.find((call) => call.fn === 've_enqueue_contact_supply_batch')?.params.p_limit).toBe(37);
    await runProjectContactSupply(input);
    expect(portal.rpcCalls.filter((call) => call.fn === 've_enqueue_contact_supply_batch')).toHaveLength(1);
    expect(portal.selects.filter((call) => call.table === 've_bases').every((call) => !call.columns.includes('data'))).toBe(true);
    const targetProgress = { status: 'limited', reason: 'Источник не поддерживает продолжение', ready_rows: 2 };
    await portal.from('ve_bases').update({ status: 'analyzed', target_progress: targetProgress,
      collect_info: { target_progress: targetProgress }, data: [
      { email: 'valid@example.test', _email_status: 'ok' },
      { email: 'blocked@example.test', _email_status: 'ok' },
      { email: 'bad@example.test', _email_status: 'invalid' },
    ] }).eq('id', 'supply-base');
    await runProjectContactSupply(input);
    expect(portal.rpcCalls.filter((call) => call.fn === 've_enqueue_contact_supply_audit')).toHaveLength(1);
    await runProjectContactSupply(input);
    const appended = portal.rpcCalls.find((call) => call.fn === 've_append_contact_supply_batch');
    expect(appended?.params.p_rows).toEqual([expect.objectContaining({ campaign_id: 'original-campaign', source_row_index: 0, email_normalized: 'valid@example.test' })]);
    expect(portal.getRows('ve_contact_supply_plans')[0].status).toBe('limited');
    await runProjectContactSupply(input);
    expect(portal.rpcCalls.filter((call) => call.fn === 've_append_contact_supply_batch')).toHaveLength(1);
    // An explicit operator resume may start the next batch instead of replaying
    // the already finalized limited outcome forever.
    await portal.from('ve_contact_supply_plans').update({ status: 'active' }).eq('id', 'plan');
    await runProjectContactSupply(input);
    expect(portal.rpcCalls.filter((call) => call.fn === 've_enqueue_contact_supply_batch')).toHaveLength(2);
    // Recover a committed append whose later plan-finalization response was lost.
    await portal.from('ve_contact_supply_plans').update({ source_state: {} }).eq('id', 'plan');
    await portal.from('ve_bases').update({ target_progress: { status: 'target_reached', ready_rows: 2 } }).eq('id', 'supply-base');
    const finishes = portal.rpcCalls.filter((call) => call.fn === 've_finish_contact_supply_batch').length;
    await runProjectContactSupply(input);
    expect(portal.rpcCalls.filter((call) => call.fn === 've_finish_contact_supply_batch')).toHaveLength(finishes + 1);
    // Lost finalization must also preserve a zero-useful-row stop, not buy
    // another batch merely because the collector had reached its ready target.
    await portal.from('ve_contact_supply_plans').update({ status: 'active', source_state: {} }).eq('id', 'plan');
    await portal.from('ve_contact_supply_batches').update({ appended_count: 0 }).eq('id', 'batch');
    await runProjectContactSupply(input);
    expect(portal.getRows('ve_contact_supply_plans')[0].status).toBe('limited');
    // Even a replayed ready audit must not accept an unrelated supply batch.
    await expect(runSegmentationAuditStage({
      id: 'job', stage: 'segmentation_audit', project_id: 've',
      payload: { audit_id: 'audit', supply_batch_id: 'another-batch' },
    } as never, { supabase: portal as never })).rejects.toThrow('Supply audit batch identity');
    await portal.from('ve_contact_supply_batches').update({ status: 'auditing' }).eq('id', 'batch');
    await portal.from('ve_segmentation_audits').update({ status: 'pending' }).eq('id', 'audit');
    const auditJob = {
      id: 'job', stage: 'segmentation_audit', project_id: 've', payload: { audit_id: 'audit', supply_batch_id: 'batch' },
    };
    await portal.from('ve_jobs').insert({ ...auditJob, status: 'running' });
    await portal.from('ve_contact_supply_plans').update({ status: 'paused' }).eq('id', 'plan');
    await expect(runSegmentationAuditStage(auditJob as never, { supabase: portal as never }))
      .resolves.toMatchObject({ result: { waiting: true } });
    expect(portal.getRows('ve_segmentation_audits')[0].status).toBe('pending');
    expect(portal.getRows('ve_jobs')[0]).toMatchObject({ status: 'pending', started_at: null });
    await portal.from('ve_contact_supply_plans').update({ status: 'active' }).eq('id', 'plan');
    await portal.from('ve_jobs').update({ status: 'running' }).eq('id', 'job');
    await runSegmentationAuditStage(auditJob as never, { supabase: portal as never });
    expect(portal.getRows('ve_segmentation_audits')[0]).toMatchObject({
      status: 'ready', supply_source_revision: 'a'.repeat(32),
      supply_leads: [expect.objectContaining({ email: 'valid@example.test' }), expect.objectContaining({ email: 'blocked@example.test' })],
    });
  });

  it('does not read or mutate the Portal DB without the Instantly client', async () => {
    const portal = createMockSupabase({
      tables: { ve_projects: [{ id: 've-1', ...COMPLETE_BINDING }] },
    });
    const runProject = jest.fn();
    const log = jest.fn();

    const result = await runBoundContactDeliveries({
      portalDb: portal as never,
      instantlyDb: null,
      runProject: runProject as never,
      log,
    });

    expect(result).toEqual({
      skipped: true,
      eligibleProjects: 0,
      attemptedProjects: 0,
      failedProjects: 0,
    });
    expect(portal.selects).toHaveLength(0);
    expect(runProject).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'error',
      expect.stringContaining('Instantly'),
    );
  });

  it('skips an overlapping tick and unlocks after the current tick settles', async () => {
    let release!: () => void;
    const firstRun = new Promise<void>((resolve) => { release = resolve; });
    const run = jest.fn()
      .mockImplementationOnce(() => firstRun)
      .mockResolvedValue(undefined);
    const log = jest.fn();
    const tick = createGuardedContactDeliveryTick({ run, log });

    const active = tick();
    await expect(tick()).resolves.toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await expect(active).resolves.toBe(true);
    await expect(tick()).resolves.toBe(true);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
