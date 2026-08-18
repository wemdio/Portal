/** @jest-environment node */

/**
 * Отправка ответа из кабинета: обычный тред и «сирота».
 *
 * Сирота — письмо, которое провайдер не привязал к кампании. Reply по нему он
 * отвергает (`400 … not part of a campaign …`), поэтому ответ уходит новым
 * письмом тем же ящиком. Пинится три свойства, каждое — цена прошлой ошибки:
 *  1. по сироте заведомо провальный reply НЕ дёргается (общая минутная квота
 *     воркспейса делится с воркерами, лишний вызов может стоить 429);
 *  2. скрытая копия НЕ теряется молча: у обходного пути bcc нет, поэтому запрос
 *     отклоняется ДО любой отправки;
 *  3. обычное письмо по-прежнему уходит обычным reply.
 */

const AUTH_USER_ID = 'user-A';
const CAMPAIGN = 'cmp-1';
const EMAIL_ID = 'email-1';
const LEAD = 'v.popov@contrust.bz';
const MAILBOX = 'reachout@outreach-contact.online';

let emailRow: Record<string, unknown>;
let replyError: Error | null = null;

/** Тело, которое роут кладёт в тест-эндпоинт (проверяем адресата и тему). */
type NewLetterBody = {
  eaccount: string;
  to_address_email_list: string;
  subject: string;
  body: { html: string };
};

const mockReplyToEmail = jest.fn(async (_body: unknown, _opts?: unknown) => {
  if (replyError) throw replyError;
  return {};
});
const mockSendTestEmail = jest.fn(async (_body: NewLetterBody, _opts?: unknown) => ({}));

jest.mock('@/lib/clientApiHelper', () => {
  const { NextResponse } = jest.requireActual('next/server');
  return {
    jsonError: (message: string, status: number) =>
      NextResponse.json({ error: message }, { status }),
    requireClientAuth: jest.fn(async () => ({
      auth: { userId: AUTH_USER_ID, accessRows: [], isDemo: false },
    })),
  };
});

jest.mock('@/lib/clientAccess', () => ({
  isResourceAllowed: () => true,
  getResourceInstantlyAccountId: () => null,
}));

jest.mock('@/lib/instantly/client', () => ({
  getEmail: jest.fn(async () => emailRow),
  listEmails: jest.fn(async () => ({ items: [] })),
  // Обёртки, а не прямые ссылки: фабрика мока поднимается выше объявления
  // переменных, и обращаться к ним можно только отложенно.
  replyToEmail: (body: unknown, opts?: unknown) => mockReplyToEmail(body, opts),
  sendTestEmail: (body: NewLetterBody, opts?: unknown) => mockSendTestEmail(body, opts),
}));

jest.mock('@/lib/clientCampaignReplies/strayAccess', () => ({
  resolveStrayAccess: jest.fn(async () => ({ leadEmail: LEAD })),
}));

jest.mock('@/lib/clientCampaignReplies/foreignMailboxFilter', () => ({
  isInboundEmail: () => true,
  isForeignEmail: () => false,
  resolveClientMailboxes: jest.fn(async () => new Set([MAILBOX])),
}));

jest.mock('@/lib/clientCampaignReplies/clientEmailReads', () => ({
  recordEmailReplied: jest.fn(async () => {}),
  recordEmailRead: jest.fn(async () => {}),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(async () => {}),
  logError: jest.fn(async () => {}),
}));

import { NextRequest } from 'next/server';
import { POST } from '@/app/api/client/campaigns/[id]/replies/[emailId]/reply/route';

function post(body: Record<string, unknown>) {
  const req = new NextRequest('http://localhost/api/client/campaigns/cmp-1/replies/email-1/reply', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
  return POST(req, { params: Promise.resolve({ id: CAMPAIGN, emailId: EMAIL_ID }) });
}

/** Сирота: провайдер не привязал письмо к кампании — campaign_id пуст. */
function strayEmail() {
  return {
    id: EMAIL_ID,
    campaign_id: null,
    lead: null,
    eaccount: MAILBOX,
    thread_id: 'thr-1',
    subject: 'Вопрос по услуге',
    ue_type: 2,
    body: { text: 'текст лида' },
    from_address_email: LEAD,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  replyError = null;
  emailRow = strayEmail();
});

describe('ответ по «сироте»', () => {
  it('уходит новым письмом, а заведомо провальный reply не дёргается', async () => {
    const res = await post({ body_text: 'Добрый день!' });

    expect(res.status).toBe(200);
    expect(mockReplyToEmail).not.toHaveBeenCalled();
    expect(mockSendTestEmail).toHaveBeenCalledTimes(1);

    const sent = mockSendTestEmail.mock.calls[0][0];
    expect(sent.eaccount).toBe(MAILBOX);
    expect(sent.to_address_email_list).toContain(LEAD);
    expect(sent.subject).toMatch(/^Re: /);
  });

  it('со скрытой копией отклоняется ДО отправки — копию нельзя потерять молча', async () => {
    const res = await post({ body_text: 'Добрый день!', bcc: 'boss@client.ru' });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: expect.stringContaining('скрытая копия недоступна'),
    });
    // Главное: ничего не отправлено ни одним путём — повторять нечего.
    expect(mockSendTestEmail).not.toHaveBeenCalled();
    expect(mockReplyToEmail).not.toHaveBeenCalled();
  });
});

describe('ответ по обычному письму', () => {
  beforeEach(() => {
    emailRow = { ...strayEmail(), campaign_id: CAMPAIGN, lead: LEAD };
  });

  it('уходит обычным reply в тред', async () => {
    const res = await post({ body_text: 'Добрый день!' });

    expect(res.status).toBe(200);
    expect(mockReplyToEmail).toHaveBeenCalledTimes(1);
    expect(mockSendTestEmail).not.toHaveBeenCalled();
  });

  it('если провайдер всё же отверг письмо — страховка досылает новым', async () => {
    replyError = new Error('Instantly API 400: … is not part of an Instantly campaign …');

    const res = await post({ body_text: 'Добрый день!' });

    expect(res.status).toBe(200);
    expect(mockSendTestEmail).toHaveBeenCalledTimes(1);
  });

  it('но со скрытой копией страховка не срабатывает — ошибка наружу', async () => {
    replyError = new Error('Instantly API 400: … is not part of an Instantly campaign …');

    const res = await post({ body_text: 'Добрый день!', bcc: 'boss@client.ru' });

    expect(res.status).toBe(502);
    expect(mockSendTestEmail).not.toHaveBeenCalled();
  });
});
