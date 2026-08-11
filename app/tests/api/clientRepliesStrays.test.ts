/** @jest-environment node */

/**
 * Блок «Ответы вне кампании» в /api/client/replies (фикс инцидента 11.08.2026):
 * сироты — письма, которые Instantly НЕ привязал к кампании (лид ответил с
 * другого адреса своей компании, сломанные заголовки треда). Их пишет
 * othersWatchdog в instantly_lead_qualifications с reply_out_of_campaign=true.
 *
 * Пиним три свойства:
 *  1. Сирота доезжает до ВЛАДЕЛЬЦА кампании (та же проверка доступа, что у
 *     live-фида — accessRows), с флагом out_of_campaign и ящиком;
 *  2. eaccount отдаётся ТОЛЬКО когда ящик — собственный ящик клиента
 *     (resolveClientMailboxes); чужой ящик скрыт (фантомная приватность);
 *  3. Дедуп против live-окна по instantly_email_id (live выигрывает).
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextRequest } from 'next/server';

const AUTH_USER_ID = 'user-A';
const ALLOWED_CAMPAIGN = 'cmp-allowed';
const OTHER_CAMPAIGN = 'cmp-other';

let mockInstantlyDb: MockSupabaseClient | null;

const authState = {
  accessRows: [] as Array<{
    resource_type: 'campaign' | 'lead_list';
    resource_id: string;
    instantly_account_id?: string | null;
  }>,
};

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: null,
}));

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: {
        userId: AUTH_USER_ID,
        accessRows: authState.accessRows,
        isDemo: false,
      },
    })),
  };
});

jest.mock('@/lib/clientCache', () => ({
  cached: jest.fn(<T,>(_key: string, fn: () => Promise<T>) => fn()),
  invalidate: jest.fn(),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
  logInfo: jest.fn(async () => {}),
  logWarn: jest.fn(async () => {}),
}));

const mockListEmails = jest.fn();
const mockGetCampaign = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
  listEmails: (...args: unknown[]) => mockListEmails(...args),
  getCampaign: (...args: unknown[]) => mockGetCampaign(...args),
}));

const mockReadCampaignAnalyticsFromDb = jest.fn();

jest.mock('@/lib/tools/instantlyCampaignCatalog', () => ({
  readCampaignAnalyticsFromDb: (ids: string[]) => mockReadCampaignAnalyticsFromDb(ids),
}));

function makeReq(url: string): NextRequest {
  return new Request(url, {
    headers: { authorization: 'Bearer test-token' },
  }) as unknown as NextRequest;
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function strayRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'qual-1',
    campaign_id: ALLOWED_CAMPAIGN,
    campaign_name: 'Кампания Клиента',
    lead_email: 'director@leadscorp.ru',
    lead_name: 'Ольга',
    company_name: 'Лидскорп',
    thread_id: 'thread-9',
    reply_subject: 'Re: По вопросу клиентов',
    reply_preview: 'Давайте обсудим',
    reply_body: 'Давайте обсудим, удобно завтра.',
    status: 'lead',
    ai_reason: null,
    instantly_email_id: 'stray-email-1',
    reply_timestamp: isoDaysAgo(1),
    created_at: isoDaysAgo(1),
    eaccount: 'sales@clientmail.ru',
    reply_out_of_campaign: true,
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  authState.accessRows = [
    { resource_type: 'campaign', resource_id: ALLOWED_CAMPAIGN },
  ];
  mockInstantlyDb = createMockSupabase({
    tables: { instantly_lead_qualifications: [] },
  });
  mockListEmails.mockResolvedValue({ items: [], next_starting_after: null });
  // Ящик клиента в кампании — «свой» для resolveClientMailboxes.
  mockGetCampaign.mockResolvedValue({
    id: ALLOWED_CAMPAIGN,
    name: 'Кампания Клиента',
    email_list: ['sales@clientmail.ru'],
  });
  mockReadCampaignAnalyticsFromDb.mockResolvedValue({
    campaigns: [{ id: ALLOWED_CAMPAIGN, name: 'Кампания Клиента' }],
    lastSyncedAt: null,
  });
});

describe('GET /api/client/replies — блок «Ответы вне кампании» (сироты)', () => {
  it('сирота попадает владельцу кампании с out_of_campaign и своим ящиком', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: { instantly_lead_qualifications: [strayRow()] },
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({
      id: 'stray:qual-1',
      qualification_id: 'qual-1',
      campaign_id: ALLOWED_CAMPAIGN,
      campaign_name: 'Кампания Клиента',
      lead_email: 'director@leadscorp.ru',
      reply_subject: 'Re: По вопросу клиентов',
      reply_body: 'Давайте обсудим, удобно завтра.',
      email_id: 'stray-email-1',
      out_of_campaign: true,
      eaccount: 'sales@clientmail.ru',
    });
  });

  it('чужой ящик НЕ показываем: элемент есть, eaccount скрыт (фантомная приватность)', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_lead_qualifications: [
          strayRow({ eaccount: 'anna@otherclient.ru' }),
        ],
      },
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
    };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].out_of_campaign).toBe(true);
    expect(body.items[0]).not.toHaveProperty('eaccount');
    expect(JSON.stringify(body.items[0])).not.toContain('anna@otherclient.ru');
  });

  it('дедуп против live-окна по instantly_email_id: живой элемент выигрывает', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: { instantly_lead_qualifications: [strayRow()] },
    });
    // То же письмо видимо и в live-окне (Instantly всё же привязал его позже):
    // сирота-дубль не должна появиться второй строкой.
    mockListEmails.mockResolvedValue({
      items: [
        {
          id: 'stray-email-1',
          campaign_id: ALLOWED_CAMPAIGN,
          thread_id: 'thread-9',
          subject: 'Re: По вопросу клиентов',
          body: { text: 'Давайте обсудим, удобно завтра.' },
          from_address_email: 'director@leadscorp.ru',
          timestamp_email: isoDaysAgo(1),
          ue_type: 2,
        },
      ],
      next_starting_after: null,
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items[0].id).toBe(`reply:${ALLOWED_CAMPAIGN}:stray-email-1`);
    expect(body.items[0]).not.toHaveProperty('out_of_campaign');
  });

  it('сироты старше 30 дней не попадают в блок', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_lead_qualifications: [
          strayRow({ reply_timestamp: isoDaysAgo(40), created_at: isoDaysAgo(40) }),
        ],
      },
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('сирота чужой кампании не показывается (доступ как у кампаний фида)', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_lead_qualifications: [
          strayRow({ id: 'qual-foreign', campaign_id: OTHER_CAMPAIGN }),
        ],
      },
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(0);
    expect(body.items).toEqual([]);
  });

  it('не-сироты (reply_out_of_campaign=false) в блок НЕ попадают', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_lead_qualifications: [
          strayRow({ reply_out_of_campaign: false }),
        ],
      },
    });

    const { GET } = await import('@/app/api/client/replies/route');
    const res = await GET(makeReq('http://x/api/client/replies'));

    expect((res as Response).status).toBe(200);
    const body = (await (res as Response).json()) as {
      items: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(0);
  });
});
