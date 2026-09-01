/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { LeadCreatePayload } from '@/lib/instantly/types';

const mockCreateCampaign = jest.fn();
const mockCreateLeads = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockValidateStoredAuditSnapshot = jest.fn();

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

jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({
  validateStoredAuditSnapshot: (...args: unknown[]) => mockValidateStoredAuditSnapshot(...args),
}));

import { runVeTemplateLaunch } from '@/lib/verticalEngineV2/launchTemplate';

const TEMPLATE_ID = 'template-1';
const BASE_ID = 'base-1';
const AUDIT_ID = 'audit-1';
const PROJECT_ID = 'project-1';
const CLIENT_ID = 'client-1';

const leads: LeadCreatePayload[] = [
  { email: 'blocked@example.test' },
  { email: 'allowed@example.test' },
];

function portalDb() {
  return createMockSupabase({
    tables: {
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
    },
    rpcHandlers: {
      ve_finalize_template_launch: async () => ({ data: { finalized: true } }),
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

async function launch(options: { blocklistError?: string; blockedEmails?: string[] } = {}) {
  const portal = portalDb();
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
});

describe('Vertical Engine v2 initial launch client blocklist', () => {
  it('removes blocked contacts before createLeads and preserves workspace skip flags', async () => {
    const { outcome, instantly } = await launch();

    expect(outcome.status).toBe(200);
    expect(outcome.body.warnings).toContain('Исключено контактов из чёрного списка клиента: 1.');
    expect(instantly.rpcCalls).toContainEqual({
      fn: 'client_blocklist_snapshot',
      params: { p_client_user_id: CLIENT_ID },
    });
    expect(mockCreateLeads).toHaveBeenCalledWith(
      [{ email: 'allowed@example.test' }],
      {
        campaign_id: 'campaign-1',
        skip_if_in_workspace: false,
        skip_if_in_campaign: false,
        skip_if_in_list: false,
      },
      { accountId: 'workspace-a' },
    );
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
