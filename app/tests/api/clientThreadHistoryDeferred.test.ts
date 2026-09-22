/** @jest-environment node */

/**
 * Тред при занятом бюджете чтения (жалоба сейлза, неделя 14.09: «не находит
 * треды»).
 *
 * Бюджет LIST /emails общий с воркером квалификации ответов. Когда слота нет,
 * listEmails бросает «email read deferred: budget; retry after N ms», и раньше
 * весь тред падал в 502 — менеджер видел только последний ответ из списка.
 * Само письмо читается запросом по id (бюджет его не держит), поэтому теперь
 * роут отдаёт его сразу с history_deferred, а кабинет догружает историю
 * повтором.
 *
 * Пиним: отложенная история → 200 с одним письмом и retry_after_ms; полная
 * история → поля нет; любая другая ошибка по-прежнему 502.
 */

import { NextRequest } from 'next/server';

const USER_ID = 'user-A';
const CAMPAIGN_ID = 'cmp-1';
const EMAIL_ID = 'email-1';
const LEAD_EMAIL = 'b2b@lead.example';
const MAILBOX = 'interact@our-mailbox.example';

const listEmails = jest.fn();

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

jest.mock('@/lib/clientDemo/demoResponse', () => ({ serveClientDemo: jest.fn() }));

jest.mock('@/lib/instantly/client', () => ({
  getEmail: jest.fn(async () => ({
    id: EMAIL_ID,
    campaign_id: CAMPAIGN_ID,
    lead: LEAD_EMAIL,
    thread_id: 'thread-1',
    eaccount: MAILBOX,
    ue_type: 2,
    from_address_email: LEAD_EMAIL,
    to_address_email_list: MAILBOX,
    subject: 'Re: предложение',
    body: { text: 'Интересно, расскажите подробнее.' },
    timestamp_created: '2026-09-22T10:00:00.000Z',
  })),
  listEmails: (...args: unknown[]) => listEmails(...args),
}));

jest.mock('@/lib/clientCampaignReplies/foreignMailboxFilter', () => ({
  ...jest.requireActual('@/lib/clientCampaignReplies/foreignMailboxFilter'),
  resolveClientMailboxes: jest.fn(async () => new Set([MAILBOX])),
}));

jest.mock('@/lib/clientCampaignReplies/clientEmailReads', () => ({
  recordEmailRead: jest.fn(async () => undefined),
}));

jest.mock('@/lib/loggerServer', () => ({
  logInfo: jest.fn(async () => undefined),
  logError: jest.fn(async () => undefined),
}));

async function callRoute() {
  const { GET } = await import(
    '@/app/api/client/campaigns/[id]/replies/[emailId]/thread/route'
  );
  const req = new NextRequest(
    `http://localhost/api/client/campaigns/${CAMPAIGN_ID}/replies/${EMAIL_ID}/thread`,
  );
  return GET(req, { params: Promise.resolve({ id: CAMPAIGN_ID, emailId: EMAIL_ID }) });
}

describe('GET thread — история отложена бюджетом чтения', () => {
  beforeEach(() => {
    jest.resetModules();
    listEmails.mockReset();
  });

  it('отдаёт само письмо сразу и retry_after_ms вместо 502', async () => {
    listEmails.mockRejectedValueOnce(
      new Error('Instantly email read deferred: budget; retry after 12336 ms'),
    );

    const res = await callRoute();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe(EMAIL_ID);
    expect(body.history_deferred).toEqual({ retry_after_ms: 12336 });
    // Адресат ответа определяется по самому письму — форма ответа работает.
    expect(body.reply_to?.email).toBe(LEAD_EMAIL);
  });

  it('отказ хранилища бюджета обрабатывается так же', async () => {
    listEmails.mockRejectedValueOnce(
      new Error('Instantly email read deferred: storage_unavailable; retry after 30000 ms'),
    );

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect((await res.json()).history_deferred).toEqual({ retry_after_ms: 30000 });
  });

  it('полная история — без history_deferred', async () => {
    listEmails.mockResolvedValueOnce({ items: [] });

    const res = await callRoute();
    expect(res.status).toBe(200);
    expect((await res.json()).history_deferred).toBeUndefined();
  });

  it('прочие ошибки чтения по-прежнему 502', async () => {
    listEmails.mockRejectedValueOnce(new Error('Instantly API 500: internal error'));

    const res = await callRoute();
    expect(res.status).toBe(502);
  });
});
