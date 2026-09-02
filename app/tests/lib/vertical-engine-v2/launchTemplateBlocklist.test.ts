/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { LeadCreatePayload } from '@/lib/instantly/types';

const mockCreateCampaign = jest.fn();
const mockCreateLeads = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockValidateStoredAuditSnapshot = jest.fn();
const mockReservePeriodCampaignLinks = jest.fn();

jest.mock('@/lib/clientLaunch/buildCampaignPayload', () => ({
  buildCampaignPayloadFromPreset: jest.fn(() => ({ sequences: [{ steps: [] }] })),
}));

jest.mock('@/lib/clientLaunch/campaignSequences', () => ({
  hasUsableCampaignSequences: jest.fn(() => true),
}));

jest.mock('@/lib/instantly/client', () => ({
  createCampaign: (...args: unknown[]) => mockCreateCampaign(...args),
  createLeads: (...args: unknown[]) => mockCreateLeads(...args),
  updateCampaign: (...args: unknown[]) => mockUpdateCampaign(...args),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/verticalEngineV2/projectLaunchPresetBinding', () => ({
  ensureVeProjectLaunchPresetBinding: jest.fn(async () => ({
    status: 'bound',
    newlyBound: false,
    binding: {
      launch_preset_id: 'preset-1',
      launch_instantly_account_id: 'workspace-a',
    },
  })),
}));

jest.mock('@/lib/instantly/campaignProjectOwnership', () => ({
  reservePeriodCampaignLinks: (...args: unknown[]) => mockReservePeriodCampaignLinks(...args),
}));

jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({
  validateStoredAuditSnapshot: (...args: unknown[]) => mockValidateStoredAuditSnapshot(...args),
}));

import { runVeTemplateLaunch } from '@/lib/verticalEngineV2/launchTemplate';

const TEMPLATE_ID = 'template-1';
const BASE_ID = 'base-1';
const AUDIT_ID = 'audit-1';
const PROJECT_ID = 'project-1';
const CLIENT_ID = 'client-1';
const PORTAL_PROJECT_ID = '20000000-0000-0000-0000-000000000001';
const PORTAL_PERIOD_ID = '30000000-0000-0000-0000-000000000001';

const leads: LeadCreatePayload[] = [
  { email: 'blocked@example.test' },
  { email: 'allowed@example.test' },
];

function portalDb() {
  return createMockSupabase({
    tables: {
      ve_projects: [{ id: PROJECT_ID }],
      ve_templates: [
        {
          id: TEMPLATE_ID,
          base_id: BASE_ID,
          status: 'ready',
          launch_info: null,
          letters: [{ subject: 'Тема', body: 'Письмо', wait_days: 0 }],
        },
      ],
      ve_bases: [
        {
          id: BASE_ID,
          project_id: PROJECT_ID,
          vertical_id: 'vertical-1',
          hypothesis_id: null,
          filename: 'base.csv',
          columns: ['email'],
          data: leads.map((lead) => ({ email: lead.email })),
          source: 'auto',
        },
      ],
      ve_segmentation_audits: [
        {
          id: AUDIT_ID,
          template_id: TEMPLATE_ID,
          base_id: BASE_ID,
          status: 'ready',
          launch_status: 'idle',
          input_hash: 'audit-hash',
        },
      ],
      ve_verticals: [{ id: 'vertical-1', potential_pct: 50 }],
      project_periods: [{
        id: PORTAL_PERIOD_ID,
        project_id: PORTAL_PROJECT_ID,
        status: 'active',
        contacts_done: '0',
        deadline: '2026-09-30',
      }],
    },
    rpcHandlers: {
      ve_finalize_template_launch: async () => ({ data: { finalized: true } }),
      ve_bind_contact_delivery_plan: async () => ({ data: { bound: true, replayed: false } }),
      ve_finalize_template_contact_delivery: async () => ({ data: { finalized: true } }),
    },
  });
}

function instantlyDb(options: { blocklistError?: string; blockedEmails?: string[] } = {}) {
  const blockedEmails = options.blockedEmails ?? ['BLOCKED@example.test'];
  return createMockSupabase({
    tables: {
      client_campaign_presets: [
        {
          id: 'preset-1',
          client_user_id: CLIENT_ID,
          instantly_account_id: 'workspace-a',
          email_account_ids: ['sender@example.test'],
          daily_limit: 30,
          schedule_days: [1, 2, 3, 4, 5],
          schedule_timezone: 'Europe/Moscow',
        },
      ],
    },
    rpcHandlers: {
      client_blocklist_snapshot: () => options.blocklistError
        ? { data: null, error: { message: options.blocklistError } }
        : { data: { count: blockedEmails.length, emails: blockedEmails } },
    },
  });
}

async function launch(options: { blocklistError?: string; blockedEmails?: string[]; reservedEmails?: string[] } = {}) {
  const portal = portalDb();
  if (options.reservedEmails) {
    await portal.from('ve_contact_delivery_rows').insert(options.reservedEmails.map((email, index) => ({
      id: `reserved-${index}`, ve_project_id: PROJECT_ID, campaign_row_id: 'previous-child', email_normalized: email, status: 'accepted',
    })));
  }
  const instantly = instantlyDb(options);
  const outcome = await runVeTemplateLaunch({
    portalDb: portal as never,
    instantlyDb: instantly as never,
    templateId: TEMPLATE_ID,
    presetId: 'preset-1',
    force: false,
    segmentationAuditId: AUDIT_ID,
    confirmSegmentation: true,
    userId: 'staff-1',
    portalProjectId: PORTAL_PROJECT_ID,
    expectedPortalPeriodId: PORTAL_PERIOD_ID,
    targetContacts: 100,
    locale: 'ru',
    eventPrefix: 'test.ve2.launch',
  });
  return { outcome, portal, instantly };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateStoredAuditSnapshot.mockReturnValue({
    state: 'complete',
    snapshot: {
      audience: {
        rows: leads.map((lead) => ({ email: lead.email })),
        leads,
        totalRows: leads.length,
        excluded: {
          lowRelevance: 0,
          relevanceUnchecked: 0,
          invalidEmailStatus: 0,
          invalidEmail: 0,
          duplicateEmail: 0,
        },
      },
      segments: [],
    },
    assignments: new Map<number, string | null>([
      [0, null],
      [1, null],
    ]),
  });
  mockCreateCampaign.mockResolvedValue({ id: 'campaign-1', sequences: [{ steps: [] }] });
  mockCreateLeads.mockImplementation(async (items: LeadCreatePayload[]) => ({
    leads_uploaded: items.length,
    duplicated_leads: 0,
  }));
  mockReservePeriodCampaignLinks.mockResolvedValue({
    status: 'claimed',
    conflictingProjectIds: [],
  });
});

describe('Vertical Engine v2 initial launch client blocklist', () => {
  it('does not create campaigns for contacts already committed by another hypothesis', async () => {
    const { outcome } = await launch({ reservedEmails: ['allowed@example.test'] });
    expect(outcome.status).toBe(400);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });
  it('prepares a reserve larger than a provider batch without uploading it immediately', async () => {
    const audience = Array.from({ length: 2001 }, (_, index) => ({ email: `lead-${index}@example.test` }));
    const validation = mockValidateStoredAuditSnapshot.getMockImplementation()!();
    mockValidateStoredAuditSnapshot.mockReturnValue({
      ...validation,
      snapshot: { ...validation.snapshot, audience: { ...validation.snapshot.audience, leads: audience, rows: audience, totalRows: audience.length } },
      assignments: new Map(audience.map((_, index) => [index, null])),
    });
    const { outcome, portal } = await launch({ blockedEmails: [] });
    expect(outcome.status).toBe(200);
    expect(portal.rpcCalls.at(-1)?.params?.p_drip_rows).toHaveLength(2001);
    expect(mockCreateLeads).not.toHaveBeenCalled();
  });

  it('removes blocked contacts before materializing the durable drip reserve', async () => {
    const { outcome, instantly, portal } = await launch();

    expect(outcome.status).toBe(200);
    expect(outcome.body.warnings).toContain('Исключено контактов из чёрного списка клиента: 1.');
    expect(instantly.rpcCalls).toContainEqual({
      fn: 'client_blocklist_snapshot',
      params: { p_client_user_id: CLIENT_ID },
    });
    expect(portal.rpcCalls).toContainEqual({
      fn: 've_bind_contact_delivery_plan',
      params: expect.objectContaining({
        p_ve_project_id: PROJECT_ID,
        p_portal_project_id: PORTAL_PROJECT_ID,
        p_expected_portal_period_id: PORTAL_PERIOD_ID,
        p_target_contacts: 100,
        p_schedule_days: [1, 2, 3, 4, 5],
        p_timezone: 'Europe/Moscow',
        p_sender_daily_capacity: 30,
        p_bound_by: 'staff-1',
      }),
    });
    expect(mockCreateLeads).not.toHaveBeenCalled();
    expect(mockReservePeriodCampaignLinks).toHaveBeenCalledWith(
      instantly,
      PORTAL_PROJECT_ID,
      [expect.objectContaining({
        periodId: PORTAL_PERIOD_ID,
        campaignId: 'campaign-1',
        baselineContacts: 0,
      })],
    );
    expect(portal.rpcCalls.at(-1)).toMatchObject({
      fn: 've_finalize_template_contact_delivery',
      params: {
        p_drip_rows: [expect.objectContaining({
          campaign_id: 'campaign-1',
          email_normalized: 'allowed@example.test',
          lead_payload: { email: 'allowed@example.test' },
        })],
      },
    });
    expect(outcome.body.launch).toMatchObject({ leads_count: 0, ready_leads_count: 1 });
  });

  it('fails closed before any Instantly mutation when the client blocklist cannot be read', async () => {
    const { outcome } = await launch({ blocklistError: 'blocklist database unavailable' });

    expect(outcome.status).toBe(500);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
    expect(mockCreateLeads).not.toHaveBeenCalled();
  });

  it('does not create an empty campaign when every launch contact is blocked', async () => {
    const { outcome } = await launch({
      blockedEmails: ['blocked@example.test', 'allowed@example.test'],
    });

    expect(outcome.status).toBe(400);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
    expect(mockCreateLeads).not.toHaveBeenCalled();
  });
});
