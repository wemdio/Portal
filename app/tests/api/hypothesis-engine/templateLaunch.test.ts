/** @jest-environment node */

/**
 * Tests for /api/tools/hypothesis-engine/templates/[id]/launch.
 *
 *   GET  -> { presets: [{ id, name }] } — селектор пресетов для «Отправить в запуск».
 *   POST -> 404 template/preset, 409 draft/уже запущен (без force),
 *           413 oversize (> 2000 лидов), happy path: PAUSED-кампания + лиды +
 *           launch_info в he_templates, кэп вариантов 4 (вкл. основной).
 *   Никогда не вызывает activateCampaign.
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

// Классификатор сегментов — LLM-зависимость; в этих тестах всегда «системный
// сбой» (null) → легаси-путь: одна кампания, варианты выкинуты с warning.
// Сплит-путь покрыт в templateLaunchSegments.test.ts.
jest.mock('@/lib/hypothesisEngine/segmentClassify', () => ({
  classifyBaseRowsIntoSegments: jest.fn(async () => null),
  detectSegmentLanguage: jest.fn(() => 'ru'),
}));

import { GET, POST } from '@/app/api/tools/hypothesis-engine/templates/[id]/launch/route';

const LETTERS = [
  {
    subject: 'Тема 1',
    body: 'Привет, {{firstName}}!',
    wait_days: 0,
    variants: [{ subject: 'Alt 1', body: 'Alt body' }],
  },
  {
    subject: 'Тема 2 (не должна попасть)',
    body: 'Follow-up body',
    wait_days: 3,
    segment_variants: [{ when: 'вне Москвы', text: 'Сегментный текст' }],
  },
];

const BASE_ROWS = [
  { Email: 'a@x.test', Имя: 'Ada', Компания: 'Acme', Сайт: 'acme.test' },
  { Email: 'A@x.test', Имя: 'Dup', Компания: 'DupCo', Сайт: '' }, // дубль после lowercase
  { Email: 'not-an-email', Имя: 'Bad', Компания: '', Сайт: '' }, // невалидный email
  { Email: 'b@x.test', Имя: 'Bob', Компания: '', Сайт: '' },
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

function seed(overrides: { template?: Record<string, unknown>; baseRows?: Array<Record<string, unknown>> } = {}) {
  const template = {
    id: TEMPLATE_ID,
    base_id: BASE_ID,
    vertical_id: 'vert-1',
    fixed_block: 'Фикс',
    personalization_plan: {
      operator_mapping: [
        { operator: 'firstName', column: 'Имя', matched: true },
        { operator: 'companyName', column: 'Компания', matched: true },
        { operator: 'city', column: null, matched: false, fallback: 'в вашем городе' },
      ],
    },
    letters: LETTERS,
    status: 'ready',
    launch_info: null,
    ...overrides.template,
  };
  mockPortalDb = createMockSupabase({
    tables: {
      he_templates: [template],
      he_bases: [
        {
          id: BASE_ID,
          filename: 'leads.csv',
          columns: ['Email', 'Имя', 'Компания', 'Сайт'],
          data: overrides.baseRows ?? BASE_ROWS,
        },
      ],
      profiles: [{ id: 'client-1', email: 'client@x.test', full_name: 'Client One' }],
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
  mockCreateCampaign.mockResolvedValue({ id: 'camp-1' }); // без sequences → PATCH fallback
  mockUpdateCampaign.mockResolvedValue({ id: 'camp-1' });
  mockCreateLeads.mockResolvedValue({ leads_uploaded: 2 });
  seed();
});

describe('POST launch — отказы до вызова Instantly', () => {
  it('404, когда шаблон не найден', async () => {
    mockPortalDb = createMockSupabase({ tables: { he_templates: [], he_bases: [] } });
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(404);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('409, когда шаблон не в статусе ready', async () => {
    seed({ template: { status: 'draft' } });
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(409);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('404, когда пресет не найден', async () => {
    const res = await POST(makeReq({ preset_id: 'no-such-preset' }), params);
    expect(res.status).toBe(404);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('409 на повторный запуск без force и отдаёт записанный launch', async () => {
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
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { launch: { campaign_id: string } };
    expect(body.launch.campaign_id).toBe('old-camp');
    expect(mockCreateCampaign).not.toHaveBeenCalled();
  });

  it('413, когда валидных лидов больше 2000', async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ Email: `u${i}@x.test` }));
    seed({ baseRows: rows });
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(413);
    expect(mockCreateCampaign).not.toHaveBeenCalled();
    expect(mockPortalDb.updates.filter((u) => u.table === 'he_templates')).toHaveLength(0);
  });
});

describe('POST launch — happy path', () => {
  it('пропускает строки с невалидным email и нерелевантные вертикали (quality-гейты сборки)', async () => {
    seed({
      baseRows: [
        { Email: 'ok@x.test', Имя: 'Ok', Компания: 'Good', Сайт: '' },
        { Email: 'bad@x.test', Имя: 'Bad', Компания: 'BadCo', Сайт: '', _email_status: 'invalid' },
        { Email: 'risky@x.test', Имя: 'Risky', Компания: 'RiskyCo', Сайт: '', _email_status: 'risky' },
        { Email: 'noise@x.test', Имя: 'Noise', Компания: 'NoiseCo', Сайт: '', _low_relevance: true },
      ],
    });
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(200);

    const [leads] = mockCreateLeads.mock.calls[0] as [Array<{ email: string }>, unknown];
    expect(leads.map((l) => l.email)).toEqual(['ok@x.test']);

    const body = (await res.json()) as { warnings: string[] };
    expect(body.warnings.some((w) => w.includes('Пропущено строк'))).toBe(true);
  });

  it('создаёт кампанию НА ПАУЗЕ, грузит лидов и пишет launch_info', async () => {
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      launch: Record<string, unknown>;
      warnings: string[];
    };
    expect(body.ok).toBe(true);

    // Кампания создана с payload из пресета; имя узнаваемое.
    expect(mockCreateCampaign).toHaveBeenCalledTimes(1);
    const [payload] = mockCreateCampaign.mock.calls[0] as [
      { name: string; text_only: boolean; sequences: Array<{ steps: Array<Record<string, unknown>> }> },
      unknown,
    ];
    expect(payload.name.startsWith('HE · leads.csv ·')).toBe(true);
    expect(payload.text_only).toBe(true); // markdown-ссылок в письмах нет

    // delay-лесенка: delay шага = wait_days СЛЕДУЮЩЕГО письма, у последнего 1.
    const steps = payload.sequences[0].steps;
    expect(steps).toHaveLength(2);
    expect(steps[0].delay).toBe(3);
    expect(steps[1].delay).toBe(1);

    // Тема только у первого письма; follow-up — продолжение треда (пустая тема).
    const step0Variants = steps[0].variants as Array<{ subject: string; body: string }>;
    expect(step0Variants[0].subject).toBe('Тема 1');
    expect(step0Variants[1].subject).toBe('Alt 1');
    const step1Variants = steps[1].variants as Array<{ subject: string; body: string }>;
    expect(step1Variants).toHaveLength(1); // segment_variants НЕ переносятся
    expect(step1Variants[0].subject).toBe('');
    expect(step1Variants[0].body).toBe('<div>Follow-up body</div>'); // plain-text → HTML

    // Instantly не вернул sequences → дослали PATCH (зеркало клиентского флоу).
    expect(mockUpdateCampaign).toHaveBeenCalledTimes(1);
    expect(mockUpdateCampaign.mock.calls[0][0]).toBe('camp-1');

    // Лиды: email lowercase+дедуп+валидация; matched-операторы эмитятся всегда
    // (пустая ячейка → '' — parity с превью, никаких литералов {{var}}),
    // unmatched с fallback → fallback у всех лидов.
    expect(mockCreateLeads).toHaveBeenCalledTimes(1);
    const [leads, leadOptions] = mockCreateLeads.mock.calls[0] as [
      Array<{ email: string; custom_variables?: Record<string, string> }>,
      Record<string, unknown>,
    ];
    expect(leads.map((l) => l.email)).toEqual(['a@x.test', 'b@x.test']);
    expect(leads[0].custom_variables).toEqual({
      firstName: 'Ada',
      companyName: 'Acme',
      Сайт: 'acme.test',
      city: 'в вашем городе',
    });
    expect(leads[1].custom_variables).toEqual({
      firstName: 'Bob',
      companyName: '',
      city: 'в вашем городе',
    });
    expect(leadOptions).toEqual({
      campaign_id: 'camp-1',
      skip_if_in_workspace: false,
      skip_if_in_campaign: false,
      skip_if_in_list: false,
    });

    // Никогда не активируем.
    expect(mockActivateCampaign).not.toHaveBeenCalled();

    // launch_info записан в шаблон.
    const tplUpdates = mockPortalDb.updates.filter((u) => u.table === 'he_templates');
    expect(tplUpdates).toHaveLength(1);
    const info = tplUpdates[0].patch.launch_info as Record<string, unknown>;
    expect(info).toEqual(
      expect.objectContaining({
        campaign_id: 'camp-1',
        leads_count: 2,
        preset_id: PRESET_ID,
      }),
    );

    // Ответ: launch + предупреждение о выкинутых сегментных вариантах.
    expect(body.launch).toEqual(
      expect.objectContaining({
        campaign_id: 'camp-1',
        campaign_url: 'https://app.instantly.ai/app/campaign/camp-1',
        leads_count: 2,
        preset_id: PRESET_ID,
      }),
    );
    expect(body.warnings).toHaveLength(1);
    expect(body.warnings[0]).toContain('Сегментные варианты');
  });

  it('кэпит A/B-варианты: всего 4 на шаг с учётом основного', async () => {
    seed({
      template: {
        letters: [
          {
            subject: 'S',
            body: 'B',
            wait_days: 0,
            variants: Array.from({ length: 5 }, (_, i) => ({ subject: `V${i}`, body: `VB${i}` })),
          },
        ],
      },
    });
    const res = await POST(makeReq({ preset_id: PRESET_ID }), params);
    expect(res.status).toBe(200);
    const [payload] = mockCreateCampaign.mock.calls[0] as [
      { sequences: Array<{ steps: Array<{ variants: unknown[] }> }> },
      unknown,
    ];
    expect(payload.sequences[0].steps[0].variants).toHaveLength(4); // A + 3 доп.
  });

  it('force: true создаёт НОВУЮ кампанию и перезаписывает launch_info', async () => {
    seed({
      template: {
        launch_info: {
          campaign_id: 'old-camp',
          campaign_name: 'Old',
          campaign_url: '',
          leads_count: 10,
          preset_id: PRESET_ID,
          created_at: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    const res = await POST(makeReq({ preset_id: PRESET_ID, force: true }), params);
    expect(res.status).toBe(200);
    expect(mockCreateCampaign).toHaveBeenCalledTimes(1);
    const tplUpdates = mockPortalDb.updates.filter((u) => u.table === 'he_templates');
    expect((tplUpdates[0].patch.launch_info as { campaign_id: string }).campaign_id).toBe('camp-1');
  });
});

describe('GET launch — список пресетов', () => {
  it('отдаёт id + имя клиента из profiles', async () => {
    const req = new Request(`http://x/api/tools/hypothesis-engine/templates/${TEMPLATE_ID}/launch`, {
      headers: { authorization: 'Bearer test-token' },
    }) as unknown as NextRequest;
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { presets: Array<{ id: string; name: string }> };
    expect(body.presets).toEqual([{ id: PRESET_ID, name: 'Client One' }]);
  });
});
