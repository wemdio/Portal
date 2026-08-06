/** @jest-environment node */

/**
 * Tests for /api/client/eng/templates/[id]/launch.
 *
 *   GET  -> { presets: [{ id, name }] } — ONLY the caller's own presets.
 *   POST { preset_id, force? } — delegates to the shared launch core
 *          (lib/hypothesisEngine/launchTemplate): PAUSED campaign + leads +
 *          launch_info; preset read is scoped to the caller.
 *          400 missing preset_id; 404 foreign template/preset;
 *          409 draft/already launched (without force).
 *   Никогда не вызывает activateCampaign.
 *   401 -> unauthenticated.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_USER_ID = '22222222-2222-4222-8222-222222222222';
const TEMPLATE_ID = 'tpl-1';
const BASE_ID = 'base-1';
const PRESET_ID = 'preset-1';

let mockPortalDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();
let mockAuthResult: unknown;

const mockCreateCampaign = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockCreateLeads = jest.fn();
const mockActivateCampaign = jest.fn();

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

jest.mock('@/lib/clientApiHelper', () => ({
  jsonError: (message: string, status: number) =>
    NextResponse.json({ error: message }, { status }),
  requireClientAuth: jest.fn(async () => mockAuthResult),
}));

jest.mock('@/lib/clientDemo/demoResponse', () => ({
  serveClientDemo: jest.fn(async () => NextResponse.json({ demo: true })),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

jest.mock('@/lib/instantly/client', () => ({
  createCampaign: (...args: unknown[]) => mockCreateCampaign(...args),
  updateCampaign: (...args: unknown[]) => mockUpdateCampaign(...args),
  createLeads: (...args: unknown[]) => mockCreateLeads(...args),
  activateCampaign: (...args: unknown[]) => mockActivateCampaign(...args),
}));

import { GET, POST } from '@/app/api/client/eng/templates/[id]/launch/route';

const LETTERS = [
  { subject: 'Subject 1', body: 'Hi {{firstName}}!', wait_days: 0 },
  { subject: null, body: 'Follow-up body', wait_days: 3 },
];

const BASE_ROWS = [
  { Email: 'a@x.test', Name: 'Ada', Company: 'Acme' },
  { Email: 'b@x.test', Name: 'Bob', Company: '' },
];

const PRESET_ROW = {
  id: PRESET_ID,
  client_user_id: USER_ID,
  instantly_account_id: 'main',
  email_account_ids: ['sender@x.test'],
  daily_limit: 100,
  daily_max_leads: 50,
  email_gap_minutes: 15,
  open_tracking: true,
  link_tracking: true,
  stop_on_reply: true,
  text_only: false,
  schedule_from: '09:00',
  schedule_to: '18:00',
  schedule_days: [1, 2, 3, 4, 5],
  schedule_timezone: 'America/New_York',
};

function seed(overrides: { template?: Record<string, unknown>; projectOwner?: string } = {}) {
  const template = {
    id: TEMPLATE_ID,
    base_id: BASE_ID,
    vertical_id: 'vert-1',
    fixed_block: 'Fixed',
    personalization_plan: {
      operator_mapping: [{ operator: 'firstName', column: 'Name', matched: true }],
    },
    letters: LETTERS,
    status: 'ready',
    launch_info: null,
    ...overrides.template,
  };
  mockPortalDb = createMockSupabase({
    tables: {
      he_projects: [
        {
          id: 'p1',
          created_by: overrides.projectOwner ?? USER_ID,
          name: 'Mine',
          website_url: 'https://mine.example/',
          status: 'researched',
          market: 'us',
        },
      ],
      he_verticals: [{ id: 'vert-1', project_id: 'p1', name: 'Banks' }],
      he_templates: [template],
      he_bases: [
        { id: BASE_ID, project_id: 'p1', filename: 'leads.csv', columns: ['Email', 'Name', 'Company'], data: BASE_ROWS },
      ],
    },
  });
  mockInstantlyDb = createMockSupabase({
    tables: { client_campaign_presets: [PRESET_ROW] },
  });
}

function makeReq(method: string, body?: unknown): NextRequest {
  return new Request(`http://x/api/client/eng/templates/${TEMPLATE_ID}/launch`, {
    method,
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: TEMPLATE_ID }) };

beforeEach(() => {
  jest.clearAllMocks();
  mockAuthResult = { auth: { userId: USER_ID, accessRows: [], isDemo: false } };
  mockCreateCampaign.mockResolvedValue({ id: 'camp-1' }); // без sequences → PATCH fallback
  mockUpdateCampaign.mockResolvedValue({ id: 'camp-1' });
  mockCreateLeads.mockResolvedValue({ leads_uploaded: 2 });
  seed();
});

describe('GET /api/client/eng/templates/[id]/launch — presets', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(401);
  });

  it('lists only the caller\'s own presets', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        client_campaign_presets: [
          PRESET_ROW,
          { ...PRESET_ROW, id: 'preset-foreign', client_user_id: OTHER_USER_ID },
        ],
      },
    });
    const res = await GET(makeReq('GET'));
    expect(res.status).toBe(200);

    const body = (await res.json()) as { presets: Array<{ id: string; name: string }> };
    expect(body.presets).toHaveLength(1);
    expect(body.presets[0].id).toBe(PRESET_ID);
    expect(body.presets[0].name).toBeTruthy();
  });
});

describe('POST /api/client/eng/templates/[id]/launch — validation & scope', () => {
  it('returns 401 when unauthenticated', async () => {
    mockAuthResult = { error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    const res = await POST(makeReq('POST', { preset_id: PRESET_ID }), params);
    expect(res.status).toBe(401);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('returns 400 when preset_id is missing', async () => {
    const res = await POST(makeReq('POST', {}), params);
    expect(res.status).toBe(400);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('returns 404 for a template of a foreign project', async () => {
    seed({ projectOwner: OTHER_USER_ID });
    const res = await POST(makeReq('POST', { preset_id: PRESET_ID }), params);
    expect(res.status).toBe(404);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('returns 404 for a preset owned by someone else', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        client_campaign_presets: [{ ...PRESET_ROW, client_user_id: OTHER_USER_ID }],
      },
    });
    const res = await POST(makeReq('POST', { preset_id: PRESET_ID }), params);
    expect(res.status).toBe(404);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('returns 409 when the template is not ready', async () => {
    seed({ template: { status: 'draft' } });
    const res = await POST(makeReq('POST', { preset_id: PRESET_ID }), params);
    expect(res.status).toBe(409);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('returns 409 on a repeated launch without force', async () => {
    seed({
      template: {
        launch_info: {
          campaign_id: 'old-camp',
          campaign_name: 'Old',
          campaign_url: 'https://app.instantly.ai/app/campaign/old-camp',
          leads_count: 10,
          preset_id: PRESET_ID,
          created_at: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    const res = await POST(makeReq('POST', { preset_id: PRESET_ID }), params);
    expect(res.status).toBe(409);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });
});

describe('POST /api/client/eng/templates/[id]/launch — happy path', () => {
  it('creates a PAUSED campaign, uploads leads and records launch_info', async () => {
    const res = await POST(makeReq('POST', { preset_id: PRESET_ID }), params);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      ok: boolean;
      launch: { campaign_id: string; leads_count: number; preset_id: string };
      warnings: string[];
    };
    expect(body.ok).toBe(true);
    expect(body.launch.campaign_id).toBe('camp-1');
    expect(body.launch.leads_count).toBe(2);
    expect(body.launch.preset_id).toBe(PRESET_ID);

    // Кампания НИКОГДА не активируется из кабинета.
    expect(mockActivateCampaign).not.toHaveBeenCalled();

    // Лиды загружены в созданную кампанию.
    const [leadsArg, optsArg] = mockCreateLeads.mock.calls[0] as [
      Array<{ email: string }>,
      { campaign_id: string },
    ];
    expect(optsArg.campaign_id).toBe('camp-1');
    expect(leadsArg.map((l) => l.email)).toEqual(['a@x.test', 'b@x.test']);

    // launch_info сохранён в шаблон (дедуп повторного запуска).
    const tpl = mockPortalDb.getRows('he_templates')[0] as {
      launch_info: { campaign_id: string; leads_count: number };
    };
    expect(tpl.launch_info.campaign_id).toBe('camp-1');
    expect(tpl.launch_info.leads_count).toBe(2);
  });
});
