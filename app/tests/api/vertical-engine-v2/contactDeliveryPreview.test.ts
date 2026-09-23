/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const TEMPLATE_ID = 'template-delivery-preview-1';
const BASE_ID = 'base-delivery-preview-1';
const VE_PROJECT_ID = 've-project-delivery-preview-1';
const PORTAL_PROJECT_ID = 'portal-project-delivery-preview-1';
const PERIOD_ID = 'portal-period-delivery-preview-1';
const PRESET_ID = 'preset-delivery-preview-1';
const AUDIT_ID = 'audit-delivery-preview-1';

let mockPortalDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();
let mockAuditValidation: Record<string, unknown>;

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockPortalDb;
  },
}));

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/toolsApiAuth', () => ({
  requireInternalToolAuth: jest.fn(async () => ({
    auth: { supabase: mockPortalDb, userId: 'user-preview-1', role: 'technician' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (_options: unknown, handler: () => Promise<unknown>) => handler(),
}));

jest.mock('@/lib/loggerServer', () => ({
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/verticalEngineV2/stages/segmentationAudit', () => ({
  validateStoredAuditSnapshot: jest.fn(() => mockAuditValidation),
}));

import { POST } from '@/app/api/tools/vertical-engine-v2/templates/[id]/launch/delivery-preview/route';
import { GET as GET_SUPPLY, POST as POST_SUPPLY } from '@/app/api/tools/vertical-engine-v2/templates/[id]/supply/route';
import { approveVeContactSupply } from '@/lib/verticalEngineV2/contactSupplyApproval';

function request(overrides: Record<string, unknown> = {}): NextRequest {
  return new Request(
    `http://portal.test/api/tools/vertical-engine-v2/templates/${TEMPLATE_ID}/launch/delivery-preview`,
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        portal_project_id: PORTAL_PROJECT_ID,
        expected_portal_period_id: PERIOD_ID,
        target_contacts: 23,
        preset_id: PRESET_ID,
        ...overrides,
      }),
    },
  ) as unknown as NextRequest;
}

function seed(options: {
  contactsDone?: unknown;
  deadline?: unknown;
  periodId?: string;
  blocklistError?: string;
  blockedEmails?: string[];
  supplyRevision?: string;
} = {}) {
  mockPortalDb = createMockSupabase({
    tables: {
      ve_projects: [{ id: VE_PROJECT_ID }],
      ve_templates: [{ id: TEMPLATE_ID, base_id: BASE_ID, status: 'ready' }],
      ve_bases: [{
        id: BASE_ID,
        project_id: VE_PROJECT_ID,
        vertical_id: 'vertical-preview-1',
        hypothesis_id: 'hypothesis-preview-1',
        filename: 'ready.csv',
        columns: ['email'],
        data: [],
        source: 'auto',
      }],
      ve_segmentation_audits: [{
        id: AUDIT_ID,
        project_id: VE_PROJECT_ID,
        template_id: TEMPLATE_ID,
        base_id: BASE_ID,
        status: 'ready',
        completed_at: '2026-09-06T12:00:00.000Z',
      }],
      projects: [{
        id: PORTAL_PROJECT_ID,
        client: 'Клиент Альфа',
        name: 'Аутрич',
        status: 'В работе',
      }],
      project_periods: [{
        id: options.periodId ?? PERIOD_ID,
        project_id: PORTAL_PROJECT_ID,
        name: 'Сентябрь',
        status: 'active',
        contacts_obligation: '20–30',
        contacts_done: options.contactsDone ?? '10',
        deadline: options.deadline === undefined ? '2026-09-11' : options.deadline,
      }],
    },
    rpcHandlers: options.supplyRevision ? {
      ve_contact_supply_preview_revision: () => ({ data: options.supplyRevision }),
      ve_contact_supply_approval_current: () => ({ data: true }),
      ve_approve_contact_supply: () => ({ data: 'supply-plan-1' }),
    } : undefined,
  });
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [{
        id: PRESET_ID,
        client_user_id: 'client-preview-1',
        instantly_account_id: 'main',
        email_account_ids: ['sender@example.test'],
        daily_limit: 3,
        daily_max_leads: 2,
        schedule_days: [1, 2, 3, 4, 5],
        schedule_timezone: 'Europe/Moscow',
      }],
    },
    rpcHandlers: {
      client_blocklist_snapshot: () => options.blocklistError
        ? { data: null, error: { message: options.blocklistError } }
        : { data: { count: (options.blockedEmails ?? ['blocked@example.test']).length, emails: options.blockedEmails ?? ['blocked@example.test'] } },
    },
  });
  mockAuditValidation = {
    state: 'current',
    snapshot: {
      segments: [],
      audience: {
        totalRows: 4,
        rows: [{}, {}, {}, {}],
        leads: [
          { email: 'ready-a@example.test' },
          { email: 'blocked@example.test' },
          { email: 'ready-b@example.test' },
          { email: 'ready-c@example.test' },
        ],
        originalRowIndices: [0, 1, 2, 3],
        labels: ['A', 'Blocked', 'B', 'C'],
        excluded: {},
      },
    },
    assignments: new Map(),
  };
}

describe('POST Vertical Engine v2 contact-delivery preview', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T21:30:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    seed();
  });

  it('requires explicit customer confirmation before approval and fails closed on revision-read errors', async () => {
    const input = { templateId: TEMPLATE_ID, portalProjectId: PORTAL_PROJECT_ID,
      expectedPortalPeriodId: PERIOD_ID, targetContacts: 23, presetId: PRESET_ID,
      segmentationAuditId: AUDIT_ID, userId: 'staff-1', confirmed: false, reviewedRevision: 'reviewed' };
    const unconfirmed = await approveVeContactSupply(mockPortalDb as never, mockInstantlyDb as never, input);
    expect(unconfirmed.status).toBe(400);
    expect(mockPortalDb.rpcCalls).toHaveLength(0);
    const unavailable = await approveVeContactSupply(mockPortalDb as never, mockInstantlyDb as never, { ...input, confirmed: true });
    expect(unavailable.status).toBe(503);
    expect(mockPortalDb.rpcCalls.some((call) => call.fn === 've_approve_contact_supply')).toBe(false);
  });

  it.each([
    { name: 'current review', revision: 'reviewed', allBlocked: false, status: 200 },
    { name: 'stale review', revision: 'changed', allBlocked: false, status: 409 },
    { name: 'fully blocked audience', revision: 'reviewed', allBlocked: true, status: 409 },
  ])('approves only usable, currently reviewed supply: $name', async ({ revision, allBlocked, status }) => {
    seed({ supplyRevision: revision, ...(allBlocked ? { blockedEmails: ['ready-a', 'ready-b', 'ready-c', 'blocked'].map((name) => `${name}@example.test`) } : {}) });
    const response = await POST_SUPPLY(request({
      action: 'approve', confirm_customer_approval: true, expected_preview_revision: 'reviewed',
      segmentation_audit_id: AUDIT_ID, userId: 'untrusted-body-user',
    }), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(status);
    const approvals = mockPortalDb.rpcCalls.filter((call) => call.fn === 've_approve_contact_supply');
    expect(approvals).toEqual(status === 200 ? [{ fn: 've_approve_contact_supply', params: {
      p_template_id: TEMPLATE_ID, p_audit_id: AUDIT_ID, p_expected_preview_revision: 'reviewed',
      p_preset_id: PRESET_ID, p_portal_project_id: PORTAL_PROJECT_ID, p_portal_period_id: PERIOD_ID,
      p_target_contacts: 23, p_instantly_account_id: 'main', p_approved_by: 'user-preview-1',
      p_now: '2026-09-06T21:30:00.000Z',
    } }] : []);
    expect([mockPortalDb.mutations, mockInstantlyDb.mutations]).toEqual([[], []]);
  });

  it('reports unblocked hypothesis stock, local uploads and the frozen day plan without reviving an unknown later estimate', async () => {
    seed({ supplyRevision: 'reviewed' });
    const estimate = { contacts: 10, as_of: '2026-09-06T12:00:00.000Z', scope: 'Observed directory yield', confidence: 'low' };
    await mockPortalDb.from('ve_bases').update({ collect_info: { collection_mode: 'preview', estimate: { remaining_ready_estimate: estimate } } }).eq('id', BASE_ID);
    await mockPortalDb.from('ve_contact_supply_plans').insert({
      id: 'supply-plan-1', template_id: TEMPLATE_ID, project_id: VE_PROJECT_ID, item_id: 'item-a',
      preview_audit_id: AUDIT_ID, status: 'active', approved_at: estimate.as_of, last_error: null, source_state: {},
      approval_snapshot: { preset_id: PRESET_ID, portal_project_id: PORTAL_PROJECT_ID, portal_period_id: PERIOD_ID, target_contacts: 23 },
    });
    await mockPortalDb.from('ve_launch_queue_items').insert(['a', 'b'].map((id) => ({
      id: `item-${id}`, project_id: VE_PROJECT_ID, status: 'active', potential_pct: 50,
    })));
    await mockPortalDb.from('ve_launch_queue_campaigns').insert(['a', 'b'].map((id) => ({
      id: `child-${id}`, item_id: `item-${id}`, campaign_id: `campaign-${id}`,
    })));
    await mockInstantlyDb.from('instantly_campaign_catalog').insert([
      { id: 'campaign-a', new_leads_contacted_count: 4 }, { id: 'campaign-b', new_leads_contacted_count: 0 },
    ]);
    await mockPortalDb.from('ve_contact_delivery_rows').insert([
      ['a', 'ready', 'ready-a', null], ['a', 'ready', 'reserve-a', null], ['a', 'ready', 'blocked', null],
      ['a', 'accepted', 'accepted-today', '2026-09-06T21:05:00Z'],
      ['a', 'accepted', 'accepted-yesterday', '2026-09-06T20:59:00Z'],
      ['a', 'attempting', 'attempting', null], ['a', 'uncertain', 'uncertain', null],
      ['b', 'ready', 'ready-b', null], ['b', 'ready', 'ready-c', null], ['b', 'ready', 'reserve-b', null],
    ].map(([item, status, email, finalized_at], index) => ({
      id: `row-${index}`, ve_project_id: VE_PROJECT_ID, item_id: `item-${item}`, campaign_row_id: `child-${item}`,
      status, email_normalized: `${email}@example.test`, finalized_at,
    })));
    await mockPortalDb.from('ve_contact_delivery_daily_runs').insert([
      { id: 'other-period', ve_project_id: VE_PROJECT_ID, portal_period_id: 'other', run_date: '2026-09-07', effective_count: 99 },
      { id: 'yesterday', ve_project_id: VE_PROJECT_ID, portal_period_id: PERIOD_ID, run_date: '2026-09-06', effective_count: 50 },
      { id: 'today', ve_project_id: VE_PROJECT_ID, portal_period_id: PERIOD_ID, run_date: '2026-09-07', effective_count: 0 },
    ]);
    const read = async () => {
      const response = await GET_SUPPLY(new Request(`http://portal.test/templates/${TEMPLATE_ID}/supply`) as NextRequest, { params: Promise.resolve({ id: TEMPLATE_ID }) });
      expect(response.status).toBe(200);
      return response.json();
    };
    const status = await read();
    expect(status).toMatchObject({ required: true, preview_revision: 'reviewed', estimate, plan: { current: true, launched: true } });
    expect(status.metrics).toEqual({
      ready: 2, uploaded: 2, uploaded_today: 1, uncertain: 2, project_first_contacted: 10,
      project_daily_plan: 0, project_required_daily: 2, project_ready: 5, project_stock_workdays: 2,
      hypothesis_daily_target: 1, hypothesis_stock_workdays: 2, hypothesis_estimated_workdays: 12,
      business_date: '2026-09-07', timezone: 'Europe/Moscow',
    });
    await mockPortalDb.from('ve_contact_supply_plans').update({ source_state: { previous_base_id: 'later-supply-base' }, estimate: { remaining_ready_estimate: null } }).eq('id', 'supply-plan-1');
    expect(await read()).toMatchObject({ estimate: null, metrics: { ready: 2, hypothesis_estimated_workdays: null } });
  });

  it('uses only the exact active Portal period and the fresh unblocked audited audience', async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.preview).toMatchObject({
      portal_project_id: PORTAL_PROJECT_ID,
      portal_project_name: 'Клиент Альфа',
      portal_period_id: PERIOD_ID,
      portal_period_label: 'Сентябрь',
      deadline: '2026-09-11',
      contacts_done_count: 10,
      contacts_obligation: 23,
      target_contacts: 23,
      remaining: 13,
      remaining_workdays: 5,
      required_daily: 3,
      effective_daily: 2,
      ready_remaining: 3,
      estimated_valid: 4,
      sender_capacity: 2,
      capacity_deficit: 3,
      supply_deficit: 10,
      total_shortfall: 10,
      delivery_timezone: 'Europe/Moscow',
      delivery_schedule_days: [1, 2, 3, 4, 5],
      weekday_plan: [
        { date: '2026-09-07', quota: 2 },
        { date: '2026-09-08', quota: 1 },
        { date: '2026-09-09', quota: 0 },
        { date: '2026-09-10', quota: 0 },
        { date: '2026-09-11', quota: 0 },
      ],
    });
    expect(mockInstantlyDb.rpcCalls).toContainEqual({
      fn: 'client_blocklist_snapshot',
      params: { p_client_user_id: 'client-preview-1' },
    });
  });

  it.each([
    {
      name: 'an unavailable durable reserve',
      arrange: () => {
        const previous = mockPortalDb;
        mockPortalDb = createMockSupabase({
          tables: Object.fromEntries(['ve_projects', 've_templates', 've_bases', 've_segmentation_audits', 'projects', 'project_periods'].map((table) => [table, previous.getRows(table)])),
          errorTables: { ve_contact_delivery_rows: 'reserve unavailable' },
        });
      },
      expectedStatus: 500,
      expectedCode: 'DELIVERY_INVENTORY_UNAVAILABLE',
    },
    {
      name: 'a different period id',
      arrange: () => seed({ periodId: 'another-active-period' }),
      expectedStatus: 409,
      expectedCode: 'PORTAL_PERIOD_NOT_ACTIVE',
    },
    {
      name: 'an ambiguous contacts_done value',
      arrange: () => seed({ contactsDone: '10–20' }),
      expectedStatus: 409,
      expectedCode: 'CONTACTS_DONE_AMBIGUOUS',
    },
    {
      name: 'a missing deadline',
      arrange: () => seed({ deadline: null }),
      expectedStatus: 409,
      expectedCode: 'PERIOD_DEADLINE_REQUIRED',
    },
    {
      name: 'an unreadable client blocklist',
      arrange: () => seed({ blocklistError: 'unavailable' }),
      expectedStatus: 500,
      expectedCode: 'CLIENT_BLOCKLIST_UNAVAILABLE',
    },
  ])('fails closed for $name', async ({ arrange, expectedStatus, expectedCode }) => {
    arrange();
    const response = await POST(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toMatchObject({ code: expectedCode });
  });

  it('uses the project reserve, excludes already committed emails, and keeps queued stock separate', async () => {
    await mockPortalDb.from('ve_launch_queue_items').insert([
      { id: 'active-item', project_id: VE_PROJECT_ID, status: 'active' },
      { id: 'queued-item', project_id: VE_PROJECT_ID, status: 'queued' },
    ]);
    await mockPortalDb.from('ve_launch_queue_campaigns').insert([
      { id: 'child-active', item_id: 'active-item', campaign_id: 'active-campaign' },
      { id: 'child-queued', item_id: 'queued-item', campaign_id: 'queued-campaign' },
    ]);
    await mockInstantlyDb.from('instantly_campaign_catalog').insert([
      { id: 'active-campaign', new_leads_contacted_count: 1 },
    ]);
    await mockPortalDb.from('ve_contact_delivery_rows').insert([
      { id: 'r1', ve_project_id: VE_PROJECT_ID, campaign_row_id: 'child-active', status: 'accepted', email_normalized: 'ready-a@example.test' },
      { id: 'r2', ve_project_id: VE_PROJECT_ID, campaign_row_id: 'child-active', status: 'attempting', email_normalized: 'pending@example.test' },
      { id: 'r3', ve_project_id: VE_PROJECT_ID, campaign_row_id: 'child-active', status: 'uncertain', email_normalized: 'timeout@example.test' },
      { id: 'r4', ve_project_id: VE_PROJECT_ID, campaign_row_id: 'child-active', status: 'ready', email_normalized: 'reserve@example.test' },
      { id: 'r5', ve_project_id: VE_PROJECT_ID, campaign_row_id: 'child-queued', status: 'ready', email_normalized: 'future@example.test' },
    ]);
    const response = await POST(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    expect((await response.json()).preview).toMatchObject({
      ready_remaining: 3,
      reserve_remaining: 4,
      outstanding_count: 2,
      supply_deficit: 8,
    });
  });

  it('uses the immutable bound plan when the live preset limit has changed', async () => {
    await mockPortalDb.from('ve_projects').update({
      portal_project_id: PORTAL_PROJECT_ID, portal_period_id: PERIOD_ID, target_contacts: 23,
      launch_preset_id: PRESET_ID, sender_daily_capacity: 1,
      delivery_schedule_days: [1, 3, 5], delivery_timezone: 'Europe/Moscow',
    }).eq('id', VE_PROJECT_ID);
    const response = await POST(request(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    expect((await response.json()).preview).toMatchObject({ sender_capacity: 1, remaining_workdays: 3, required_daily: 5, effective_daily: 1 });
  });
});

describe('contact-delivery preview for a Portal project without periods', () => {
  beforeAll(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-06T21:30:00.000Z'));
  });

  afterAll(() => {
    jest.useRealTimers();
  });

  // Staff Line · «Аутрич»: периодов нет, накопленный факт 25 905 при
  // обязательстве 4 000. Дедлайн сдвинут под замороженные часы теста.
  async function withoutPeriod(
    options: {
      deadline?: string | null;
      contactsDone?: string;
      periods?: Array<{ id: string; status: string }>;
      links?: boolean;
      otherPlan?: boolean;
    } = {},
    seedOptions: Parameters<typeof seed>[0] = {},
  ) {
    seed(seedOptions);
    await mockPortalDb.from('project_periods').delete().eq('project_id', PORTAL_PROJECT_ID);
    await mockPortalDb.from('projects').update({
      client: 'Staff Line',
      name: 'Аутрич',
      status: 'В работе',
      deadline: options.deadline === undefined ? '2026-09-11' : options.deadline,
      launch_date: '2026-08-30',
      contacts_obligation: '4000',
      contacts_done: options.contactsDone ?? '25905',
    }).eq('id', PORTAL_PROJECT_ID);
    for (const period of options.periods ?? []) {
      await mockPortalDb.from('project_periods').insert({
        id: period.id, project_id: PORTAL_PROJECT_ID, name: 'Период', status: period.status,
        contacts_done: '0', deadline: '2026-09-30',
      });
    }
    if (options.links !== false) {
      await mockInstantlyDb.from('project_instantly_campaigns').insert({
        project_id: PORTAL_PROJECT_ID, campaign_id: 'legacy-staff-line-campaign',
      });
    }
    if (options.otherPlan) {
      await mockPortalDb.from('ve_projects').insert({
        id: 'another-ve-project', portal_project_id: PORTAL_PROJECT_ID, portal_period_id: null,
      });
    }
  }

  function noPeriodRequest(overrides: Record<string, unknown> = {}) {
    return request({ expected_portal_period_id: null, target_contacts: 4000, ...overrides });
  }

  it('plans to the card deadline from the VE2 target, ignoring the accumulated project fact', async () => {
    await withoutPeriod();
    const writesBefore = [mockPortalDb.mutations.length, mockInstantlyDb.mutations.length];
    const response = await POST(noPeriodRequest(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    const { preview } = await response.json();
    expect(preview).toMatchObject({
      portal_project_id: PORTAL_PROJECT_ID,
      portal_project_name: 'Staff Line',
      portal_period_id: null,
      portal_period_label: null,
      deadline: '2026-09-11',
      contacts_done_count: 0,
      target_contacts: 4000,
      remaining: 4000,
      remaining_workdays: 5,
      required_daily: 800,
      effective_daily: 2,
      period: null,
      project_term: {
        deadline: '2026-09-11',
        starts_at: '2026-08-30',
        contacts_obligation: '4000',
        contacts_done_total: 25905,
      },
    });
    expect([mockPortalDb.mutations.length, mockInstantlyDb.mutations.length]).toEqual(writesBefore);
  });

  it('counts only first contacts of this VE2 project campaigns as the plan fact', async () => {
    await withoutPeriod();
    await mockPortalDb.from('ve_launch_queue_items').insert({ id: 'item-a', project_id: VE_PROJECT_ID, status: 'active' });
    await mockPortalDb.from('ve_launch_queue_campaigns').insert({ id: 'child-a', item_id: 'item-a', campaign_id: 'campaign-a' });
    await mockInstantlyDb.from('instantly_campaign_catalog').insert({ id: 'campaign-a', new_leads_contacted_count: 7 });
    const response = await POST(noPeriodRequest(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    expect((await response.json()).preview).toMatchObject({ contacts_done_count: 7, remaining: 3993 });
  });

  it.each([
    {
      name: 'a missing card deadline (ENagency)',
      arrange: () => withoutPeriod({ deadline: null }),
      code: 'PROJECT_DEADLINE_REQUIRED',
      error: 'В карточке проекта не заполнено поле «Дедлайн». Укажите дату в формате ГГГГ-ММ-ДД — темп рассчитается до неё.',
    },
    {
      name: 'a deadline that is not a date',
      arrange: () => withoutPeriod({ deadline: '05.18.2026' }),
      code: 'PROJECT_DEADLINE_INVALID',
      error: expect.stringContaining('«Дедлайн»'),
    },
    {
      name: 'a passed deadline',
      arrange: () => withoutPeriod({ deadline: '2026-09-04' }),
      code: 'PROJECT_DEADLINE_PASSED',
      error: 'Дедлайн проекта (04.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта.',
    },
    {
      // Часы теста 2026-09-06T21:30Z — это уже 07.09 00:30 по Москве, часовому поясу отправки.
      name: 'a deadline that ended at midnight in the delivery timezone',
      arrange: () => withoutPeriod({ deadline: '2026-09-06' }),
      code: 'PROJECT_DEADLINE_PASSED',
      error: 'Дедлайн проекта (06.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта.',
    },
    {
      name: 'only closed periods',
      arrange: () => withoutPeriod({ periods: [{ id: 'closed-1', status: 'closed' }] }),
      code: 'PORTAL_PERIODS_CLOSED',
      error: 'Все периоды проекта закрыты. Откройте новый период в карточке проекта.',
    },
    {
      name: 'an active period requested as a project without periods',
      arrange: () => withoutPeriod({ periods: [{ id: 'active-1', status: 'active' }] }),
      code: 'PORTAL_PROJECT_HAS_ACTIVE_PERIOD',
      error: expect.stringContaining('активный период'),
    },
    {
      name: 'a second VE2 project on the same Portal project',
      arrange: () => withoutPeriod({ otherPlan: true }),
      code: 'PORTAL_PROJECT_PLAN_TAKEN',
      error: expect.stringContaining('уже привязан'),
    },
    {
      name: 'a hand-kept fact without campaign links (Law Russia)',
      arrange: () => withoutPeriod({ contactsDone: '10860', links: false }),
      code: 'PORTAL_PROJECT_MANUAL_FACT',
      error: expect.stringContaining('ведётся вручную'),
    },
  ])('refuses $name with a plain reason', async ({ arrange, code, error }) => {
    await arrange();
    const writesBefore = [mockPortalDb.mutations.length, mockInstantlyDb.mutations.length];
    const response = await POST(noPeriodRequest(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code, error });
    expect([mockPortalDb.mutations.length, mockInstantlyDb.mutations.length]).toEqual(writesBefore);
  });

  // Для уже идущего плана правка карточки возвращает загрузку, только пока
  // кампании плана не завершились: иначе пакет уходит из портфеля.
  it.each([
    {
      name: 'a passed deadline',
      project: { deadline: '2026-09-04' },
      code: 'PROJECT_DEADLINE_PASSED',
      error: 'Дедлайн проекта (04.09.2026) уже прошёл. Обновите поле «Дедлайн» в карточке проекта. Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.',
    },
    {
      name: 'a finished project',
      project: { status: 'Завершен' },
      code: 'PORTAL_PROJECT_NOT_IN_WORK',
      error: 'Проект в Portal не в работе (статус «Завершен»). Верните рабочий статус в карточке проекта. Загрузка продолжится сама, если к этому времени кампании плана ещё не завершились; иначе понадобится новый запуск.',
    },
  ])('pauses a bound plan on $name without promising an unconditional resume', async ({ project, code, error }) => {
    await withoutPeriod();
    await mockPortalDb.from('projects').update(project).eq('id', PORTAL_PROJECT_ID);
    await mockPortalDb.from('ve_projects').update({
      portal_project_id: PORTAL_PROJECT_ID, portal_period_id: null, target_contacts: 4000, launch_preset_id: PRESET_ID,
      sender_daily_capacity: 2, delivery_schedule_days: [1, 2, 3, 4, 5], delivery_timezone: 'Europe/Moscow',
    }).eq('id', VE_PROJECT_ID);
    const response = await POST(noPeriodRequest(), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ code, error });
  });

  it('still rejects a request that does not state the period at all', async () => {
    await withoutPeriod();
    const response = await POST(request({ expected_portal_period_id: undefined }), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'PORTAL_PERIOD_REQUIRED' });
  });

  it('approves supply with an explicit NULL period', async () => {
    await withoutPeriod({}, { supplyRevision: 'reviewed' });
    const response = await POST_SUPPLY(request({
      action: 'approve', confirm_customer_approval: true, expected_preview_revision: 'reviewed',
      segmentation_audit_id: AUDIT_ID, expected_portal_period_id: null, target_contacts: 4000,
    }), { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    expect(mockPortalDb.rpcCalls.find((call) => call.fn === 've_approve_contact_supply')?.params).toMatchObject({
      p_portal_project_id: PORTAL_PROJECT_ID, p_portal_period_id: null, p_target_contacts: 4000,
    });
  });

  async function supplyStatus() {
    const response = await GET_SUPPLY(new Request(`http://portal.test/templates/${TEMPLATE_ID}/supply`) as NextRequest, { params: Promise.resolve({ id: TEMPLATE_ID }) });
    expect(response.status).toBe(200);
    return response.json();
  }

  async function launchedPlanWithoutPeriod() {
    await withoutPeriod({}, { supplyRevision: 'reviewed' });
    await mockPortalDb.from('ve_bases').update({ collect_info: { collection_mode: 'preview' } }).eq('id', BASE_ID);
    await mockPortalDb.from('ve_contact_supply_plans').insert({
      id: 'supply-plan-1', template_id: TEMPLATE_ID, project_id: VE_PROJECT_ID, item_id: 'item-a',
      preview_audit_id: AUDIT_ID, status: 'active', approved_at: '2026-09-06T12:00:00.000Z', last_error: null, source_state: {},
      approval_snapshot: { preset_id: PRESET_ID, portal_project_id: PORTAL_PROJECT_ID, portal_period_id: null, target_contacts: 4000 },
    });
    await mockPortalDb.from('ve_launch_queue_items').insert({ id: 'item-a', project_id: VE_PROJECT_ID, status: 'active', potential_pct: 50 });
    await mockPortalDb.from('ve_launch_queue_campaigns').insert({ id: 'child-a', item_id: 'item-a', campaign_id: 'campaign-a' });
    await mockInstantlyDb.from('instantly_campaign_catalog').insert({ id: 'campaign-a', new_leads_contacted_count: 0 });
    await mockPortalDb.from('ve_contact_delivery_daily_runs').insert([
      { id: 'foreign-period-run', ve_project_id: VE_PROJECT_ID, portal_period_id: 'some-period', run_date: '2026-09-07', effective_count: 99 },
      // effective_count отличается от расчётного effective_daily (2): видно, что запуск найден.
      { id: 'today', ve_project_id: VE_PROJECT_ID, portal_period_id: null, run_date: '2026-09-07', effective_count: 5 },
    ]);
    // PostgREST never matches `eq.null`; model that so the status must use `is`.
    const from = mockPortalDb.from;
    mockPortalDb.from = (table: string) => {
      const builder = from(table);
      if (table === 've_contact_delivery_daily_runs') {
        const eq = builder.eq;
        builder.eq = (column: string, value: unknown) => eq(column, value === null ? '\u0000eq-null-matches-nothing' : value);
      }
      return builder;
    };
  }

  it('reads today’s run of a plan without period through IS NULL', async () => {
    await launchedPlanWithoutPeriod();
    const status = await supplyStatus();
    expect(status.plan).toMatchObject({ portal_period_id: null, target_contacts: 4000 });
    expect(status.metrics).toMatchObject({ project_daily_plan: 5, project_first_contacted: 0, business_date: '2026-09-07' });
  });

  it('shows the exact reason when a period was created after the launch', async () => {
    await launchedPlanWithoutPeriod();
    await mockPortalDb.from('ve_projects').update({
      portal_project_id: PORTAL_PROJECT_ID, portal_period_id: null, target_contacts: 4000, launch_preset_id: PRESET_ID,
      sender_daily_capacity: 2, delivery_schedule_days: [1, 2, 3, 4, 5], delivery_timezone: 'Europe/Moscow',
    }).eq('id', VE_PROJECT_ID);
    await mockPortalDb.from('project_periods').insert({
      id: 'new-period', project_id: PORTAL_PROJECT_ID, name: 'Октябрь', status: 'active', contacts_done: '0', deadline: '2026-10-31',
    });
    const status = await supplyStatus();
    expect(status.metrics).toBeNull();
    expect(status.metrics_error).toBe(
      'План и запас не пересчитаны: Проекту в Portal создан период. Загрузка новых контактов по этому плану остановлена: план рассчитан на проект без периодов. Уже загруженные контакты продолжают отправляться.',
    );
  });
});
