/** @jest-environment node */

import type { NextRequest } from 'next/server';
import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import { buildCampaignPayloadFromPreset } from '@/lib/clientLaunch/buildCampaignPayload';
import { buildLaunchSequence } from '@/lib/verticalEngineV2/launchHandoff';
import type { ClientCampaignPreset } from '@/lib/clientLaunch/types';

let mockPortalDb = createMockSupabase();
let mockInstantlyDb = createMockSupabase();
const mockGetCampaign = jest.fn();
const mockListLeads = jest.fn();
const mockGetAnalytics = jest.fn();
const mockActivateCampaign = jest.fn();
const mockCreateLeads = jest.fn();
const mockValidate = jest.fn();
const mockReserveOwnership = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({ get supabaseAdmin() { return mockPortalDb; } }));
jest.mock('@/lib/supabaseInstantly', () => ({ get supabaseInstantly() { return mockInstantlyDb; } }));
jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: async () => ({ auth: { userId: 'staff-1' } }),
}));
jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));
jest.mock('@/lib/loggerServer', () => ({ logAudit: jest.fn(), logError: jest.fn() }));
jest.mock('@/lib/instantly/client', () => ({
  getCampaign: (...args: unknown[]) => mockGetCampaign(...args),
  listLeads: (...args: unknown[]) => mockListLeads(...args),
  getCampaignAnalytics: (...args: unknown[]) => mockGetAnalytics(...args),
  activateCampaign: (...args: unknown[]) => mockActivateCampaign(...args),
  createLeads: (...args: unknown[]) => mockCreateLeads(...args),
}));
jest.mock('@/lib/instantly/campaignProjectOwnership', () => ({
  reservePeriodCampaignLinks: (...args: unknown[]) => mockReserveOwnership(...args),
}));
jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({
  validateStoredAuditSnapshot: (...args: unknown[]) => mockValidate(...args),
  prepareAuditSnapshot: jest.fn(() => ({ audience: { leads: [] } })),
}));

import { GET as getAudit, PATCH, POST as createAudit } from '@/app/api/tools/vertical-engine-v2/templates/[id]/segmentation-audit/route';
import { GET as getBaseTemplate } from '@/app/api/tools/vertical-engine-v2/bases/[id]/template/route';
import { activateApprovedLaunchCampaigns, activateDeliveredContactCampaigns } from '@/lib/verticalEngineV2/contactDeliveryActivation';

const letters = [{ subject: 'Тема', body: 'Письмо', wait_days: 0 }];
const preset = {
  id: 'preset-1', client_user_id: 'client-1', instantly_account_id: 'workspace-a',
  email_account_ids: ['sender@example.test'], schedule_days: [1, 2, 3, 4, 5],
  schedule_timezone: 'Europe/Moscow', schedule_from: '09:00', schedule_to: '18:00',
  daily_limit: 30, daily_max_leads: 20,
} as ClientCampaignPreset;
const audit = {
  id: 'audit-1', template_id: 'template-1', base_id: 'base-1', project_id: 've-project-1',
  status: 'ready', launch_status: 'uncertain', launch_reservation_id: 'reservation-1',
  launch_preset_id: 'preset-1', input_hash: 'hash-1', launch_started_at: '2026-09-02T06:00:00Z',
};

function seed(known = true) {
  mockPortalDb = createMockSupabase({ tables: {
    ve_templates: [{ id: 'template-1', base_id: 'base-1', vertical_id: 'vertical-1',
      status: 'ready', letters, launch_info: known ? {
        campaign_id: 'campaign-1', campaign_name: 'Paused campaign', campaign_url: 'https://x',
        leads_count: 0, ready_leads_count: 2, preset_id: 'preset-1',
        created_at: '2026-09-02T06:00:00Z', segmentation_audit_id: 'audit-1',
        instantly_account_id: 'workspace-a', mailbox_ids: ['sender@example.test'],
        estimated_run_days: 1,
      } : null }],
    ve_bases: [{ id: 'base-1', project_id: 've-project-1', vertical_id: 'vertical-1',
      filename: 'base.csv', columns: ['email'], data: [], hypothesis_id: null, source: 'auto' }],
    ve_projects: [{ id: 've-project-1', launch_preset_id: 'preset-1',
      launch_instantly_account_id: 'workspace-a', portal_project_id: 'portal-project-1',
      portal_period_id: 'period-1', target_contacts: 100 }],
    ve_segmentation_audits: [audit],
    ve_verticals: [{ id: 'vertical-1', potential_pct: 50 }],
    ve_contact_delivery_rows: [{ id: 'existing-row', ve_project_id: 've-project-1',
      campaign_row_id: 'another-campaign-row', email_normalized: 'reserved@example.test', status: 'ready' }],
  }, rpcHandlers: {
    ve_resolve_template_launch: () => ({ data: { resolved: true, audit_row: audit } }),
    ve_resolve_template_contact_delivery: () => ({ data: { resolved: true, audit_row: audit } }),
  } });
  mockInstantlyDb = createMockSupabase({ tables: { client_campaign_presets: [{ ...preset }] },
    rpcHandlers: { client_blocklist_snapshot: () => ({ data: { count: 1, emails: ['blocked@example.test'] } }) },
  });
}

async function recover() {
  return PATCH(new Request('http://x/recovery', {
    method: 'PATCH', body: JSON.stringify({ audit_id: 'audit-1', launch_reservation_id: 'reservation-1',
      resolution: 'campaign_created', confirm: true, campaign_ids: ['campaign-1'] }),
  }) as NextRequest, { params: Promise.resolve({ id: 'template-1' }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  mockValidate.mockReturnValue({ state: 'current', snapshot: {
    audience: { leads: [{ email: 'blocked@example.test' }, { email: 'allowed@example.test' }, { email: 'reserved@example.test' }],
      rows: [], excluded: {}, totalRows: 3 }, segments: [],
  }, assignments: new Map([[0, null], [1, null], [2, null]]) });
  mockGetCampaign.mockResolvedValue({ id: 'campaign-1', status: 2,
    email_list: ['sender@example.test'], sequences: buildCampaignPayloadFromPreset({
      preset, sequence: { name: 'Test', steps: buildLaunchSequence(letters)!.steps },
    }).sequences });
  mockListLeads.mockResolvedValue({ items: [], next_starting_after: null });
  mockGetAnalytics.mockResolvedValue([{ campaign_id: 'campaign-1', emails_sent_count: 0, contacted_count: 0 }]);
  mockReserveOwnership.mockResolvedValue({ status: 'claimed', conflictingProjectIds: [] });
});

it('recovers the exact filtered reserve and period ownership without uploading contacts', async () => {
  expect((await recover()).status).toBe(200);
  expect(mockPortalDb.rpcCalls.at(-1)).toMatchObject({
    fn: 've_resolve_template_contact_delivery', params: {
      p_launch_info: { leads_count: 0, ready_leads_count: 1,
        portal_project_id: 'portal-project-1', portal_period_id: 'period-1', target_contacts: 100 },
      p_drip_rows: [{ campaign_id: 'campaign-1', source_row_index: 1, drip_order: 0,
        email_normalized: 'allowed@example.test', lead_payload: { email: 'allowed@example.test' } }],
    },
  });
  expect(mockReserveOwnership).toHaveBeenCalledWith(mockInstantlyDb, 'portal-project-1', [
    expect.objectContaining({ periodId: 'period-1', campaignId: 'campaign-1', baselineContacts: 0 }),
  ]);
  expect(mockCreateLeads).not.toHaveBeenCalled();
});

it('recovers a known live campaign even when the failed attempt saved no launch_info', async () => {
  seed(false);
  expect((await recover()).status).toBe(200);
  expect(mockPortalDb.rpcCalls.at(-1)?.fn).toBe('ve_resolve_template_contact_delivery');
});

it('keeps supply clones out of ordinary template, audit and recovery endpoints', async () => {
  seed(false);
  await mockPortalDb.from('ve_templates').update({ supply_batch_id: 'supply-batch' }).eq('id', 'template-1');
  await mockPortalDb.from('ve_segmentation_audits').update({ launch_status: 'idle' }).eq('id', 'audit-1');
  const request = new Request('http://x/template') as NextRequest;
  const context = { params: Promise.resolve({ id: 'template-1' }) };
  const responses = await Promise.all([
    getBaseTemplate(request, { params: Promise.resolve({ id: 'base-1' }) }),
    createAudit(new Request('http://x/audit', { method: 'POST' }) as NextRequest, context),
    getAudit(request, context),
    recover(),
  ]);
  expect(responses.map((response) => response.status)).toEqual([409, 409, 409, 409]);
  expect(mockPortalDb.rpcCalls).toHaveLength(0);
  expect(mockGetCampaign).not.toHaveBeenCalled();
});

it.each(['stale audit', 'nonempty remote campaign', 'previously contacted campaign', 'ownership conflict'])('keeps %s fail-closed', async (failure) => {
  if (failure === 'stale audit') mockValidate.mockReturnValue({ state: 'stale', reason: 'input_changed' });
  if (failure === 'nonempty remote campaign') mockListLeads.mockResolvedValue({ items: [{ id: 'lead-1' }] });
  if (failure === 'previously contacted campaign') mockGetAnalytics.mockResolvedValue([
    { campaign_id: 'campaign-1', emails_sent_count: 10, contacted_count: 5 },
  ]);
  if (failure === 'ownership conflict') mockReserveOwnership.mockResolvedValue({ status: 'conflict', conflictingProjectIds: ['other-project'] });
  expect((await recover()).status).toBe(409);
  expect(mockPortalDb.rpcCalls).toHaveLength(0);
  expect(mockCreateLeads).not.toHaveBeenCalled();
});

it('approves bound empty campaigns without calling provider activation and keeps legacy activation', async () => {
  expect(await activateApprovedLaunchCampaigns({ portalDb: mockPortalDb as never,
    veProjectId: 've-project-1', accountId: 'workspace-a', campaignIds: ['campaign-1'],
  })).toEqual({ deferred: true });
  expect(mockActivateCampaign).not.toHaveBeenCalled();
  const legacy = createMockSupabase({ tables: { ve_projects: [{ id: 'legacy' }] } });
  expect(await activateApprovedLaunchCampaigns({ portalDb: legacy as never,
    veProjectId: 'legacy', accountId: 'workspace-a', campaignIds: ['campaign-1'],
  })).toEqual({ deferred: false });
  expect(mockActivateCampaign).toHaveBeenCalledTimes(1);
});

it('starts first accepted tranche behind a DB fence, never resumes a previously started paused child', async () => {
  const portal = createMockSupabase({ tables: {
    ve_launch_queue_items: [{ id: 'item-1', project_id: 've-project-1', status: 'active',
      instantly_account_id: 'workspace-a', mailbox_ids: ['sender@example.test'] }],
    ve_launch_queue_campaigns: [
      { id: 'child-1', item_id: 'item-1', campaign_id: 'campaign-1', leads_count: 1, activated_at: null },
      { id: 'child-2', item_id: 'item-1', campaign_id: 'manual-pause', leads_count: 1, activated_at: '2026-09-01' },
      { id: 'child-3', item_id: 'item-1', campaign_id: 'empty', leads_count: 0, activated_at: null },
      { id: 'child-4', item_id: 'item-1', campaign_id: 'draft', leads_count: 1, activated_at: null },
    ],
  }, rpcHandlers: {
    ve_reserve_contact_delivery_activation: () => ({ data: { reserved: true } }),
    ve_finalize_contact_delivery_activation: () => ({ data: { finalized: true } }),
  } });
  mockGetCampaign.mockImplementation(async (id: string) => ({ id,
    status: mockActivateCampaign.mock.calls.some(([activatedId]) => activatedId === id) ? 1 : id === 'draft' ? 0 : 2,
    email_list: ['sender@example.test'] }));
  await activateDeliveredContactCampaigns({ portalDb: portal as never, veProjectId: 've-project-1' });
  expect(mockActivateCampaign).toHaveBeenCalledTimes(2);
  expect(mockActivateCampaign).toHaveBeenCalledWith('campaign-1', expect.objectContaining({ accountId: 'workspace-a' }));
  expect(portal.rpcCalls.map((call) => call.fn)).toEqual([
    've_reserve_contact_delivery_activation', 've_finalize_contact_delivery_activation',
    've_reserve_contact_delivery_activation', 've_finalize_contact_delivery_activation',
  ]);
  expect(portal.rpcCalls.at(-1)?.params).toMatchObject({ p_succeeded: true });
});
