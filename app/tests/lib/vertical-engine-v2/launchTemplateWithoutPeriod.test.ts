/** @jest-environment node */

import { createMockSupabase } from '@/../tests/helpers/mockSupabase';
import type { LeadCreatePayload } from '@/lib/instantly/types';

const mockCreateCampaign = jest.fn();
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
    binding: { launch_preset_id: 'preset-1', launch_instantly_account_id: 'workspace-a' },
  })),
}));

jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({
  validateStoredAuditSnapshot: (...args: unknown[]) => mockValidateStoredAuditSnapshot(...args),
}));

import { runVeTemplateLaunch } from '@/lib/verticalEngineV2/launchTemplate';

const TEMPLATE_ID = 'template-1';
const BASE_ID = 'base-1';
const AUDIT_ID = 'audit-1';
const VE_PROJECT_ID = 've-project-1';
// Staff Line · «Аутрич»: у проекта в Portal нет ни одного периода.
const STAFF_LINE_ID = '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c';
const OTHER_PROJECT_ID = '20000000-0000-0000-0000-000000000099';

const leads: LeadCreatePayload[] = [{ email: 'hr@staffline-client.test' }, { email: 'ceo@staffline-client.test' }];

function portalDb(project: Record<string, unknown> = {}) {
  return createMockSupabase({
    tables: {
      ve_projects: [{ id: VE_PROJECT_ID }],
      ve_templates: [{
        id: TEMPLATE_ID, base_id: BASE_ID, status: 'ready', updated_at: '2026-09-22T10:00:00.000Z',
        launch_info: null, letters: [{ subject: 'Тема', body: 'Письмо', wait_days: 0 }],
      }],
      ve_bases: [{
        id: BASE_ID, project_id: VE_PROJECT_ID, vertical_id: 'vertical-1', hypothesis_id: null,
        filename: 'base.csv', columns: ['email'], data: leads.map((lead) => ({ email: lead.email })), source: 'auto',
      }],
      ve_segmentation_audits: [{
        id: AUDIT_ID, template_id: TEMPLATE_ID, base_id: BASE_ID, status: 'ready', launch_status: 'idle', input_hash: 'audit-hash',
      }],
      ve_verticals: [{ id: 'vertical-1', potential_pct: 50 }],
      projects: [{
        id: STAFF_LINE_ID, client: 'Staff Line', name: 'Аутрич', status: 'В работе',
        deadline: '2026-09-30', launch_date: '2026-08-30', contacts_obligation: '4000', contacts_done: '25905',
        ...project,
      }],
      project_periods: [],
    },
    rpcHandlers: {
      ve_reserve_final_template_launch: async (params, db) => {
        await db.from('ve_segmentation_audits').update({ launch_status: 'running', launch_reservation_id: params.p_reservation_id }).eq('id', params.p_audit_id);
        return { data: true };
      },
      ve_finalize_template_launch: async () => ({ data: { finalized: true } }),
      ve_bind_contact_delivery_plan: async () => ({ data: { bound: true, replayed: false } }),
      ve_finalize_template_contact_delivery: async () => ({ data: { finalized: true } }),
    },
  });
}

function instantlyDb(options: { conflict?: boolean; links?: boolean; claim?: 'conflict' | 'error' } = {}) {
  return createMockSupabase({
    tables: {
      client_campaign_presets: [{
        id: 'preset-1', client_user_id: 'client-1', instantly_account_id: 'workspace-a',
        email_account_ids: ['sender@example.test'], daily_limit: 30,
        schedule_days: [1, 2, 3, 4, 5], schedule_timezone: 'Europe/Moscow',
      }],
      project_instantly_campaigns: options.links === false ? [] : [{ project_id: STAFF_LINE_ID, campaign_id: 'legacy-campaign' }],
    },
    rpcHandlers: {
      client_blocklist_snapshot: () => ({ data: { count: 0, emails: [] } }),
      check_project_instantly_campaign_ownership: () => ({
        data: { conflicts: options.conflict ? [{ campaign_id: 'campaign-1', conflicting_project_ids: [OTHER_PROJECT_ID] }] : [] },
      }),
      claim_project_instantly_campaign: () => {
        if (options.claim === 'error') return { data: null, error: { message: 'instantly db unavailable' } };
        return options.claim === 'conflict'
          ? { data: { status: 'conflict', conflicting_project_ids: [OTHER_PROJECT_ID] } }
          : { data: { status: 'claimed', conflicting_project_ids: [] } };
      },
      reserve_project_period_instantly_campaigns: () => ({ data: null, error: { message: 'must not reserve a period link' } }),
    },
  });
}

async function launch(portal = portalDb(), instantly = instantlyDb()) {
  const outcome = await runVeTemplateLaunch({
    portalDb: portal as never,
    instantlyDb: instantly as never,
    templateId: TEMPLATE_ID,
    presetId: 'preset-1',
    force: false,
    segmentationAuditId: AUDIT_ID,
    confirmSegmentation: true,
    userId: 'staff-1',
    portalProjectId: STAFF_LINE_ID,
    expectedPortalPeriodId: null,
    targetContacts: 4000,
    locale: 'ru',
    eventPrefix: 'test.ve2.launch',
  });
  return { outcome, portal, instantly };
}

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'queueMicrotask'] });
  jest.setSystemTime(new Date('2026-09-23T09:00:00.000Z'));
});

afterAll(() => {
  jest.useRealTimers();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateStoredAuditSnapshot.mockReturnValue({
    state: 'complete',
    snapshot: {
      audience: {
        rows: leads.map((lead) => ({ email: lead.email })),
        leads,
        totalRows: leads.length,
        excluded: { lowRelevance: 0, relevanceUnchecked: 0, invalidEmailStatus: 0, invalidEmail: 0, duplicateEmail: 0 },
      },
      segments: [],
    },
    assignments: new Map<number, string | null>([[0, null], [1, null]]),
  });
  mockCreateCampaign.mockResolvedValue({ id: 'campaign-1', sequences: [{ steps: [] }] });
});

describe('VE2 launch for a Portal project without periods', () => {
  it('binds without a period and links campaigns to the project like its card does', async () => {
    const { outcome, portal, instantly } = await launch();
    expect(outcome.status).toBe(200);

    expect(portal.rpcCalls.find((call) => call.fn === 've_bind_contact_delivery_plan')?.params).toMatchObject({
      p_ve_project_id: VE_PROJECT_ID,
      p_portal_project_id: STAFF_LINE_ID,
      p_expected_portal_period_id: null,
      p_target_contacts: 4000,
    });
    expect(instantly.rpcCalls.map((call) => call.fn)).toEqual([
      'client_blocklist_snapshot',
      'check_project_instantly_campaign_ownership',
      'claim_project_instantly_campaign',
    ]);
    expect(instantly.rpcCalls[1].params).toEqual({ p_project_id: STAFF_LINE_ID, p_campaign_ids: ['campaign-1'] });
    expect(instantly.rpcCalls[2].params).toMatchObject({
      p_project_id: STAFF_LINE_ID,
      p_campaign_id: 'campaign-1',
      p_match_source: 'manual',
      p_period_id: null,
      p_replace_automatic: false,
    });

    expect(outcome.body.launch).toMatchObject({ portal_project_id: STAFF_LINE_ID, portal_period_id: null, target_contacts: 4000 });
    expect(portal.rpcCalls.at(-1)).toMatchObject({
      fn: 've_finalize_template_contact_delivery',
      params: { p_launch_status: 'succeeded', p_launch_info: { portal_period_id: null } },
    });
    // VE2 never creates periods and never touches the project's own fact.
    expect(portal.mutations.filter((mutation) => ['projects', 'project_periods'].includes(mutation.table))).toEqual([]);
    expect(portal.getRows('projects')[0].contacts_done).toBe('25905');
  });

  it('keeps an ownership conflict uncertain instead of taking part of the campaigns', async () => {
    const { outcome, portal, instantly } = await launch(portalDb(), instantlyDb({ conflict: true }));
    expect(outcome).toMatchObject({ status: 500, body: { code: 'TEMPLATE_LAUNCH_UNCERTAIN' } });
    expect(instantly.rpcCalls.some((call) => call.fn === 'claim_project_instantly_campaign')).toBe(false);
    expect(portal.rpcCalls.at(-1)).toMatchObject({
      fn: 've_finalize_template_launch',
      params: { p_launch_status: 'uncertain', p_error: expect.stringContaining(OTHER_PROJECT_ID) },
    });
  });

  // Кампанию успели занять между общей проверкой и захватом, или захват упал.
  it.each([
    ['a conflict that appears at the claim', 'conflict' as const, OTHER_PROJECT_ID],
    ['a failed claim', 'error' as const, 'instantly db unavailable'],
  ])('settles %s as uncertain without finalizing delivery', async (_name, claim, reason) => {
    const { outcome, portal, instantly } = await launch(portalDb(), instantlyDb({ claim }));
    expect(outcome).toMatchObject({ status: 500, body: { code: 'TEMPLATE_LAUNCH_UNCERTAIN' } });
    expect(instantly.rpcCalls.map((call) => call.fn)).toEqual([
      'client_blocklist_snapshot',
      'check_project_instantly_campaign_ownership',
      'claim_project_instantly_campaign',
    ]);
    expect(portal.rpcCalls.at(-1)).toMatchObject({
      fn: 've_finalize_template_launch',
      params: { p_launch_status: 'uncertain', p_error: expect.stringContaining(reason) },
    });
    expect(portal.rpcCalls.some((call) => call.fn === 've_finalize_template_contact_delivery')).toBe(false);
  });

  it('refuses a hand-kept project fact before any campaign is created (Law Russia)', async () => {
    const { outcome, portal } = await launch(
      portalDb({ client: 'Law Russia', contacts_done: '10860', contacts_obligation: '12000-24000' }),
      instantlyDb({ links: false }),
    );
    expect(outcome).toMatchObject({ status: 409, body: { code: 'PORTAL_PROJECT_MANUAL_FACT' } });
    expect(String(outcome.body.error)).toContain('ведётся вручную');
    expect(mockCreateCampaign).not.toHaveBeenCalled();
    expect(portal.rpcCalls).toEqual([]);
  });

  it.each([
    ['a missing deadline', { deadline: null }, 'PROJECT_DEADLINE_REQUIRED'],
    ['a passed deadline', { deadline: '2026-09-22' }, 'PROJECT_DEADLINE_PASSED'],
    ['a passed deadline typed as DD.MM.YY', { deadline: '22.09.26' }, 'PROJECT_DEADLINE_PASSED'],
    ['a finished project', { status: 'Завершен' }, 'PORTAL_PROJECT_NOT_IN_WORK'],
  ])('refuses %s before binding or creating campaigns', async (_name, project, code) => {
    const { outcome, portal } = await launch(portalDb(project));
    expect(outcome).toMatchObject({ status: 409, body: { code } });
    expect(mockCreateCampaign).not.toHaveBeenCalled();
    expect(portal.rpcCalls.some((call) => call.fn === 've_bind_contact_delivery_plan')).toBe(false);
  });

  it('refuses when a period appeared for the project', async () => {
    const portal = portalDb();
    await portal.from('project_periods').insert({ id: 'period-1', project_id: STAFF_LINE_ID, status: 'active' });
    const { outcome } = await launch(portal);
    expect(outcome).toMatchObject({ status: 409, body: { code: 'PORTAL_PROJECT_HAS_ACTIVE_PERIOD' } });
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('launches with a deadline typed as DD.MM.YY, as the project card hints', async () => {
    const { outcome, portal } = await launch(portalDb({ deadline: '31.10.26' }));
    expect(outcome.status).toBe(200);
    expect(portal.rpcCalls.some((call) => call.fn === 've_bind_contact_delivery_plan')).toBe(true);
  });

  // The binding is immutable: a period created after a no-period launch cannot be adopted by this VE2 project.
  it('does not promise a period binding to a VE2 project already bound without a period', async () => {
    const portal = portalDb();
    await portal.from('ve_projects').update({ portal_project_id: STAFF_LINE_ID, portal_period_id: null }).eq('id', VE_PROJECT_ID);
    await portal.from('project_periods').insert({ id: 'period-1', project_id: STAFF_LINE_ID, status: 'active' });
    const { outcome } = await launch(portal);
    expect(outcome).toMatchObject({ status: 409, body: { code: 'PORTAL_PERIOD_CREATED_AFTER_LAUNCH' } });
    expect(String(outcome.body.error)).not.toContain('Обновите страницу');
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });
});
