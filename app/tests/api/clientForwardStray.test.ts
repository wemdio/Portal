/** @jest-environment node */

/**
 * «Переслать» для письма-сироты.
 *
 * Сирота — ответ, который Instantly не привязал к кампании (campaign_id и lead
 * пусты). Forward по такому письму провайдер отвергает `400 … is not part of a
 * campaign`, поэтому пересылаем НОВЫМ письмом тем же ящиком (sendTestEmail) и
 * вкладываем исходное письмо сами. Право — по ящику-получателю (strayAccess).
 *
 * Пиним:
 *  1. сирота с подтверждённым доступом уходит через sendTestEmail, forward не
 *     дёргаем вовсе (заведомо провальный вызов съел бы общую квоту);
 *  2. в теле пересылки есть исходное письмо — иначе адресат получит пустое «Fwd:»;
 *  3. отказ strayAccess — 404, ничего не отправлено (fail-closed);
 *  4. обычное письмо идёт через forward, а на «not part of a campaign» —
 *     страховочный обход.
 */

import { NextRequest } from 'next/server';

const USER_ID = 'user-A';
const CAMPAIGN_ID = 'cmp-1';
const EMAIL_ID = 'email-1';
const LEAD_EMAIL = 'b2b@lead.example';
const MAILBOX = 'interact@our-mailbox.example';
const FORWARD_TO = 'colleague@client.example';

const strayResult = { value: null as { leadEmail: string | null } | null };
const providerEmail = { value: {} as Record<string, unknown> };
const forwardEmail = jest.fn(async (..._args: unknown[]) => ({}));
const sendTestEmail = jest.fn(async (..._args: unknown[]) => ({}));

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
  listEmails: jest.fn(async () => ({ items: [] })),
  forwardEmail: (...args: unknown[]) => forwardEmail(...args),
  sendTestEmail: (...args: unknown[]) => sendTestEmail(...args),
}));

jest.mock('@/lib/clientCampaignReplies/strayAccess', () => ({
  resolveStrayAccess: jest.fn(async () => strayResult.value),
}));

jest.mock('@/lib/clientCampaignReplies/foreignMailboxFilter', () => ({
  ...jest.requireActual('@/lib/clientCampaignReplies/foreignMailboxFilter'),
  resolveClientMailboxes: jest.fn(async () => new Set([MAILBOX])),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => undefined),
  logError: jest.fn(async () => undefined),
}));

async function callRoute() {
  const { POST } = await import(
    '@/app/api/client/campaigns/[id]/replies/[emailId]/forward/route'
  );
  const req = new NextRequest(
    `http://localhost/api/client/campaigns/${CAMPAIGN_ID}/replies/${EMAIL_ID}/forward`,
    { method: 'POST', body: JSON.stringify({ to_email: FORWARD_TO }) },
  );
  return POST(req, { params: Promise.resolve({ id: CAMPAIGN_ID, emailId: EMAIL_ID }) });
}

function strayEmail(): Record<string, unknown> {
  // Ровно то, что Instantly отдаёт по сироте: campaign_id и lead пусты.
  return {
    id: EMAIL_ID,
    campaign_id: undefined,
    lead: undefined,
    thread_id: 'thread-1',
    eaccount: MAILBOX,
    ue_type: 2,
    from_address_email: LEAD_EMAIL,
    from_address_json: [{ address: LEAD_EMAIL, name: 'Иван Петров' }],
    to_address_email_list: MAILBOX,
    subject: 'Re: к кому по новым клиентам?',
    body: { text: 'Добрый день! Интересно, пришлите условия.' },
    timestamp_created: '2026-09-22T10:00:00.000Z',
  };
}

describe('POST forward — письмо-сирота', () => {
  beforeEach(() => {
    jest.resetModules();
    forwardEmail.mockReset().mockResolvedValue({});
    sendTestEmail.mockReset().mockResolvedValue({});
    strayResult.value = null;
    providerEmail.value = strayEmail();
  });

  it('сирота с подтверждённым доступом уходит новым письмом, forward не вызываем', async () => {
    strayResult.value = { leadEmail: LEAD_EMAIL };

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, to_email: FORWARD_TO });

    expect(forwardEmail).not.toHaveBeenCalled();
    expect(sendTestEmail).toHaveBeenCalledTimes(1);
    const [payload] = sendTestEmail.mock.calls[0] as [Record<string, unknown>];
    expect(payload.eaccount).toBe(MAILBOX);
    expect(payload.to_address_email_list).toBe(FORWARD_TO);
    expect(payload.subject).toBe('Fwd: Re: к кому по новым клиентам?');
  });

  it('в теле пересылки лежит исходное письмо с заголовком', async () => {
    strayResult.value = { leadEmail: LEAD_EMAIL };

    await callRoute();
    const [payload] = sendTestEmail.mock.calls[0] as [{ body: { html: string } }];
    const html = payload.body.html;
    expect(html).toContain('Пересланное сообщение');
    expect(html).toContain('Иван Петров &lt;b2b@lead.example&gt;');
    expect(html).toContain('Тема: Re: к кому по новым клиентам?');
    expect(html).toContain('Интересно, пришлите условия.');
  });

  it('отказ strayAccess — 404 и ничего не отправлено', async () => {
    strayResult.value = null;

    const res = await callRoute();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Письмо не относится к кампании');
    expect(forwardEmail).not.toHaveBeenCalled();
    expect(sendTestEmail).not.toHaveBeenCalled();
  });

  it('обычное письмо кампании пересылается через forward', async () => {
    providerEmail.value = { ...strayEmail(), campaign_id: CAMPAIGN_ID, lead: LEAD_EMAIL };

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(forwardEmail).toHaveBeenCalledTimes(1);
    expect(sendTestEmail).not.toHaveBeenCalled();
  });

  it('если провайдер всё же счёл письмо вне кампании — страховочный обход', async () => {
    providerEmail.value = { ...strayEmail(), campaign_id: CAMPAIGN_ID, lead: LEAD_EMAIL };
    forwardEmail.mockRejectedValueOnce(
      // Дословный текст отказа провайдера (см. lib/instantly/notPartOfCampaign.ts).
      new Error('The email you are replying to is not part of an Instantly campaign, so you cannot reply to it (missing campaign_id or list_id)'),
    );

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect(sendTestEmail).toHaveBeenCalledTimes(1);
  });
});
