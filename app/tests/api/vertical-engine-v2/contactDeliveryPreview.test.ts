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
  });
  mockInstantlyDb = createMockSupabase({
    tables: {
      client_campaign_presets: [{
        id: PRESET_ID,
        client_user_id: 'client-preview-1',
        daily_limit: 3,
        daily_max_leads: 2,
        schedule_days: [1, 2, 3, 4, 5],
        schedule_timezone: 'Europe/Moscow',
      }],
    },
    rpcHandlers: {
      client_blocklist_snapshot: () => options.blocklistError
        ? { data: null, error: { message: options.blocklistError } }
        : { data: { count: 1, emails: ['blocked@example.test'] } },
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
