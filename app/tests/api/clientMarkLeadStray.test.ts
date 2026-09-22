/** @jest-environment node */

/**
 * «Пометить как лид» для письма-сироты (кабинет outreachos, 22.09.2026).
 *
 * Сирота — ответ, который Instantly не привязал к кампании: campaign_id и lead
 * у письма пусты, кампанию мы вычислили сами и записали в
 * instantly_lead_qualifications с reply_out_of_campaign=true. Тред и «Ответить»
 * такие письма уже пускали через resolveStrayAccess, а mark-lead — нет:
 * менеджер читал переписку, мог ответить, но на пометку лидом получал
 * «Письмо не относится к кампании».
 *
 * Пиним обе стороны: сироту с подтверждённым доступом пускаем, а отказ
 * strayAccess (чужой ящик, нет записи) по-прежнему 404 — fail-closed.
 */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { NextRequest } from 'next/server';

const USER_ID = 'user-A';
const CAMPAIGN_ID = 'cmp-1';
const EMAIL_ID = 'email-stray-1';
const LEAD_EMAIL = 'b2b@lead.example';

let mockInstantlyDb: MockSupabaseClient | null;
const strayResult = { value: null as { leadEmail: string | null } | null };
const providerEmail = {
  value: {} as Record<string, unknown>,
};

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/supabaseAdmin', () => ({ supabaseAdmin: null }));

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: {
        userId: USER_ID,
        accessRows: [{ resource_type: 'campaign', resource_id: CAMPAIGN_ID }],
        isDemo: false,
      },
    })),
  };
});

jest.mock('@/lib/instantly/client', () => ({
  getEmail: jest.fn(async () => providerEmail.value),
}));

jest.mock('@/lib/clientCampaignReplies/strayAccess', () => ({
  resolveStrayAccess: jest.fn(async () => strayResult.value),
}));

jest.mock('@/lib/clientCampaignReplies/clientEmailReads', () => ({
  recordEmailRead: jest.fn(async () => undefined),
}));

jest.mock('@/lib/tools/instantlyCampaignCatalog', () => ({
  readCampaignAnalyticsFromDb: jest.fn(async () => ({ campaigns: [{ name: 'Кампания' }] })),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => undefined),
  logError: jest.fn(async () => undefined),
}));

async function callRoute() {
  const { POST } = await import(
    '@/app/api/client/campaigns/[id]/replies/[emailId]/mark-lead/route'
  );
  const req = new NextRequest(
    `http://localhost/api/client/campaigns/${CAMPAIGN_ID}/replies/${EMAIL_ID}/mark-lead`,
    { method: 'POST' },
  );
  return POST(req, { params: Promise.resolve({ id: CAMPAIGN_ID, emailId: EMAIL_ID }) });
}

describe('POST mark-lead — письмо-сирота', () => {
  beforeEach(() => {
    jest.resetModules();
    mockInstantlyDb = createMockSupabase({ tables: { client_forwarded_leads: [] } });
    strayResult.value = null;
    // Ровно то, что Instantly отдаёт по сироте: campaign_id и lead пусты,
    // thread_id и eaccount живые, отправитель — адрес лида.
    providerEmail.value = {
      id: EMAIL_ID,
      campaign_id: undefined,
      lead: undefined,
      thread_id: 'thread-1',
      eaccount: 'interact@our-mailbox.example',
      ue_type: 2,
      from_address_email: LEAD_EMAIL,
      subject: 'Re: вопрос',
      timestamp_created: '2026-09-22T10:00:00.000Z',
    };
  });

  it('с подтверждённым доступом по ящику лид создаётся', async () => {
    strayResult.value = { leadEmail: LEAD_EMAIL };

    const res = await callRoute();
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.lead.lead_email).toBe(LEAD_EMAIL);
    expect(body.lead.campaign_id).toBe(CAMPAIGN_ID);
    expect(body.lead.status).toBe('lead');
  });

  it('отказ strayAccess остаётся 404 — fail-closed', async () => {
    strayResult.value = null;

    const res = await callRoute();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Письмо не относится к кампании');
    expect(mockInstantlyDb!.getRows('client_forwarded_leads')).toHaveLength(0);
  });

  it('адрес лида берётся из нашей записи, когда провайдер не отдал отправителя', async () => {
    strayResult.value = { leadEmail: LEAD_EMAIL };
    providerEmail.value.from_address_email = undefined;

    const res = await callRoute();
    expect(res.status).toBe(201);
    expect((await res.json()).lead.lead_email).toBe(LEAD_EMAIL);
  });
});
