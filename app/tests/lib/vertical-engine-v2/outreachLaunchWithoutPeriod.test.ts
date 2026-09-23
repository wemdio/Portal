/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';

jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({
  validateStoredAuditSnapshot: jest.fn(() => ({ state: 'current' })),
  prepareAuditSnapshot: jest.fn(),
}));

import { outreachLaunchRequestSchema, runVeOutreachStartStage } from '@/lib/verticalEngineV2/outreachLaunch';

const STAFF_LINE_ID = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
const VE_PROJECT_ID = '10000000-0000-4000-8000-000000000001';
const HYPOTHESIS_ID = '10000000-0000-4000-8000-000000000002';
const BASE_ID = '10000000-0000-4000-8000-000000000003';
const TEMPLATE_ID = '10000000-0000-4000-8000-000000000004';
const AUDIT_ID = '10000000-0000-4000-8000-000000000005';

const request = {
  setup_revision: 3,
  preset_id: 'preset-1',
  portal_project_id: STAFF_LINE_ID,
  expected_portal_period_id: null,
  target_contacts: 4000,
  items: [{
    hypothesis_id: HYPOTHESIS_ID, base_id: BASE_ID, template_id: TEMPLATE_ID,
    preview_revision: 'reviewed', segmentation_audit_id: AUDIT_ID,
  }],
};

describe('auto-outreach launch for a Portal project without periods', () => {
  it('requires the period field but accepts an explicit null', () => {
    expect(outreachLaunchRequestSchema.safeParse(request).success).toBe(true);
    expect(outreachLaunchRequestSchema.safeParse({ ...request, expected_portal_period_id: '30000000-0000-4000-8000-000000000001' }).success).toBe(true);
    const { expected_portal_period_id: _omitted, ...missing } = request;
    expect(outreachLaunchRequestSchema.safeParse(missing).success).toBe(false);
  });

  it('accepts already created campaigns whose launch record has no period', async () => {
    const portal = createMockSupabase({
      tables: {
        ve_outreach_runs: [{
          id: 'run-1', project_id: VE_PROJECT_ID, requested_by: 'staff-1', status: 'running',
          request, items: [{ ...request.items[0], status: 'queued' }], error: null,
        }],
        ve_outreach_setups: [{
          project_id: VE_PROJECT_ID, revision: 3, selected_hypothesis_ids: [HYPOTHESIS_ID],
          approved_bases: { [BASE_ID]: { template_id: TEMPLATE_ID, revision: 'reviewed' } },
        }],
        ve_templates: [{
          id: TEMPLATE_ID, base_id: BASE_ID, status: 'ready', supply_batch_id: null,
          letters: [{ subject: 'Тема', body: 'Письмо', selected_variant: 'A' }],
          launch_info: {
            campaign_id: 'campaign-1', campaign_name: 'Staff Line', campaign_url: 'https://x', leads_count: 0,
            preset_id: 'preset-1', created_at: '2026-09-23T09:00:00.000Z', segmentation_audit_id: AUDIT_ID,
            portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000,
          },
        }],
        ve_bases: [{
          id: BASE_ID, project_id: VE_PROJECT_ID, hypothesis_id: HYPOTHESIS_ID, status: 'analyzed',
          collect_info: { collection_mode: 'preview' },
        }],
        ve_segmentation_audits: [{ id: AUDIT_ID, template_id: TEMPLATE_ID, base_id: BASE_ID, launch_status: 'succeeded' }],
        ve_launch_queue_items: [{ id: 'item-1', template_id: TEMPLATE_ID, project_id: VE_PROJECT_ID, status: 'active', plan_version: 1 }],
      },
      rpcHandlers: {
        ve_contact_supply_preview_revision: () => ({ data: 'reviewed' }),
        ve_save_outreach_progress: async (params, db) => {
          await db.from('ve_outreach_runs').update({ status: params.p_status, items: params.p_items, error: params.p_error }).eq('id', 'run-1');
          return { data: true };
        },
      },
    });

    const result = await runVeOutreachStartStage(
      { id: 'job-1', project_id: VE_PROJECT_ID, payload: { outreach_run_id: 'run-1' } } as never,
      { supabase: portal } as never,
      createMockSupabase() as never,
    );

    expect(result).toEqual({ result: { outreach_run_id: 'run-1', status: 'active' } });
    expect(portal.getRows('ve_outreach_runs')[0]).toMatchObject({
      status: 'active', error: null, items: [expect.objectContaining({ status: 'active', item_id: 'item-1' })],
    });
  });
});
