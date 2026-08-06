/** @jest-environment node */

/**
 * Tests for the segment-split launch path of
 * /api/tools/hypothesis-engine/templates/[id]/launch (материализация 15%):
 *   классификатор сегментов вернул расклад → запуск создаёт paused-кампанию
 *   на сегмент (тексты сегментных вариантов) + основную (дефолтные тексты),
 *   launch_info.campaigns несёт весь список, скаляры — основную кампанию.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { NextRequest } from 'next/server';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const TEMPLATE_ID = 'tpl-1';
const BASE_ID = 'base-1';
const PRESET_ID = 'preset-1';

let mockPortalDb: MockSupabaseClient = createMockSupabase();
let mockInstantlyDb: MockSupabaseClient = createMockSupabase();

const mockCreateCampaign = jest.fn();
const mockUpdateCampaign = jest.fn();
const mockCreateLeads = jest.fn();
const mockActivateCampaign = jest.fn();
const mockClassify = jest.fn();

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
    auth: { supabase: mockPortalDb, userId: USER_ID, role: 'admin' },
  })),
}));

jest.mock('@/lib/toolTrace', () => ({
  withToolTrace: async (
    _o: unknown,
    h: (t: { end: () => Promise<void>; fail: () => Promise<void> }) => Promise<unknown>,
  ) => h({ end: async () => {}, fail: async () => {} }),
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

jest.mock('@/lib/hypothesisEngine/segmentClassify', () => ({
  classifyBaseRowsIntoSegments: (...args: unknown[]) => mockClassify(...args),
  detectSegmentLanguage: jest.fn(() => 'ru'),
}));

import { POST } from '@/app/api/tools/hypothesis-engine/templates/[id]/launch/route';

const LETTERS = [
  {
    subject: 'Тема 1',
    body: 'Привет, {{firstName}}!',
    wait_days: 0,
    variants: [],
    segment_variants: [{ when: 'вне Москвы', text: 'Сегментный текст письма 1' }],
  },
  {
    subject: 'Тема 2',
    body: 'Follow-up body',
    wait_days: 3,
  },
];

const BASE_ROWS = [
  { Email: 'a@x.test', Имя: 'Ada', Компания: 'Acme', Город: 'Москва' },
  { Email: 'b@x.test', Имя: 'Bob', Компания: 'Beta', Город: 'Казань' },
];

const PRESET_ROW = {
  id: PRESET_ID,
  client_user_id: 'client-1',
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
  schedule_timezone: 'Europe/Kirov',
};

function seed() {
  mockPortalDb = createMockSupabase({
    tables: {
      he_templates: [
        {
          id: TEMPLATE_ID,
          base_id: BASE_ID,
          vertical_id: 'vert-1',
          fixed_block: 'Фикс',
          personalization_plan: {
            operator_mapping: [{ operator: 'firstName', column: 'Имя', matched: true }],
          },
          letters: LETTERS,
          status: 'ready',
          launch_info: null,
        },
      ],
      he_bases: [
        {
          id: BASE_ID,
          filename: 'leads.csv',
          columns: ['Email', 'Имя', 'Компания', 'Город'],
          source: 'auto',
          data: BASE_ROWS,
        },
      ],
      profiles: [],
    },
  });
  mockInstantlyDb = createMockSupabase({
    tables: { client_campaign_presets: [PRESET_ROW] },
  });
}

function makeReq(body: unknown): NextRequest {
  return new Request(`http://x/api/tools/hypothesis-engine/templates/${TEMPLATE_ID}/launch`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const params = { params: Promise.resolve({ id: TEMPLATE_ID }) };

beforeEach(() => {
  jest.clearAllMocks();
  seed();
  mockCreateCampaign
    .mockImplementationOnce(() => Promise.resolve({ id: 'camp-default' }))
    .mockImplementationOnce(() => Promise.resolve({ id: 'camp-seg' }));
  mockUpdateCampaign.mockResolvedValue({});
  mockCreateLeads.mockImplementation((leads: unknown[]) =>
    Promise.resolve({ leads_uploaded: leads.length }),
  );
  // Лид b@x.test (второй в rowsByLead) → сегмент «вне Москвы».
  mockClassify.mockResolvedValue(new Map([[1, 'вне Москвы']]));
});

describe('POST launch — сплит по сегментам (материализация 15%)', () => {
  it('создаёт основную и сегментную кампании с разными текстами, пишет campaigns в launch_info', async () => {
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      launch: Record<string, unknown>;
      warnings: string[];
    };
    expect(body.ok).toBe(true);

    // Классификатор получил строки лидов и условия сегментов.
    expect(mockClassify).toHaveBeenCalledTimes(1);
    const classifyInput = mockClassify.mock.calls[0][0] as {
      rows: Array<Record<string, unknown>>;
      segments: string[];
    };
    expect(classifyInput.rows).toHaveLength(2);
    expect(classifyInput.segments).toEqual(['вне Москвы']);

    // Две кампании: основная (дефолтный текст), затем сегментная (его текст).
    expect(mockCreateCampaign).toHaveBeenCalledTimes(2);
    const firstPayload = mockCreateCampaign.mock.calls[0][0] as {
      name: string;
      sequences: Array<{ steps: Array<Record<string, unknown>> }>;
    };
    const secondPayload = mockCreateCampaign.mock.calls[1][0] as typeof firstPayload;
    expect(firstPayload.name).toBe(`HE · leads.csv · ${new Date().toISOString().slice(0, 10)}`);
    expect(secondPayload.name).toContain('вне Москвы');

    const firstSteps = firstPayload.sequences[0].steps as Array<{
      variants: Array<{ subject: string; body: string }>;
    }>;
    const secondSteps = secondPayload.sequences[0].steps as typeof firstSteps;
    expect(firstSteps[0].variants[0].body).toBe('<div>Привет, {{firstName}}!</div>');
    expect(secondSteps[0].variants[0].body).toBe('<div>Сегментный текст письма 1</div>');

    // Лиды разложены по своим кампаниям.
    expect(mockCreateLeads).toHaveBeenCalledTimes(2);
    const defaultLeads = mockCreateLeads.mock.calls[0][0] as Array<{ email: string }>;
    const segLeads = mockCreateLeads.mock.calls[1][0] as Array<{ email: string }>;
    expect(defaultLeads.map((l) => l.email)).toEqual(['a@x.test']);
    expect(segLeads.map((l) => l.email)).toEqual(['b@x.test']);
    expect(mockCreateLeads.mock.calls[0][1]).toMatchObject({ campaign_id: 'camp-default' });
    expect(mockCreateLeads.mock.calls[1][1]).toMatchObject({ campaign_id: 'camp-seg' });

    // Никогда не активируем.
    expect(mockActivateCampaign).not.toHaveBeenCalled();

    // launch_info: скаляры — основная кампания, campaigns — обе.
    const tplUpdates = mockPortalDb.updates.filter((u) => u.table === 'he_templates');
    expect(tplUpdates).toHaveLength(1);
    const info = tplUpdates[0].patch.launch_info as {
      campaign_id: string;
      leads_count: number;
      campaigns: Array<{ campaign_id: string; segment: string | null; leads_count: number }>;
    };
    expect(info.campaign_id).toBe('camp-default');
    expect(info.leads_count).toBe(2);
    expect(info.campaigns).toEqual([
      expect.objectContaining({ campaign_id: 'camp-default', segment: null, leads_count: 1 }),
      expect.objectContaining({ campaign_id: 'camp-seg', segment: 'вне Москвы', leads_count: 1 }),
    ]);

    // Инфо-предупреждение о сплите вместо предупреждения о выкинутых вариантах.
    expect(body.warnings.some((w) => w.includes('разбит'))).toBe(true);
    expect(body.warnings.some((w) => w.includes('не попали в кампанию'))).toBe(false);
  });

  it('fallback: классификатор вернул null → одна кампания и warning о выкинутых вариантах', async () => {
    mockClassify.mockResolvedValue(null);
    mockCreateCampaign.mockReset().mockResolvedValue({ id: 'camp-1', sequences: [{}] });

    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: string[] };

    expect(mockCreateCampaign).toHaveBeenCalledTimes(1);
    expect(body.warnings.some((w) => w.includes('не попали в кампанию'))).toBe(true);
  });
});
