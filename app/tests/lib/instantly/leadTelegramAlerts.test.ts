/** @jest-environment node */

import { sendLeadTelegramAlert } from '@/lib/instantly/leadTelegramAlerts';

const fetchMock = jest.fn();

describe('leadTelegramAlerts', () => {
  const oldFetch = global.fetch;
  const oldBotToken = process.env.CHANGELOG_BOT_TOKEN;
  const oldFallbackChatId = process.env.CHANGELOG_CHAT_ID;
  const oldDedicatedBotToken = process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN;
  const oldChatId = process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID;
  const oldThreadId = process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    });
    delete process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN;
    process.env.CHANGELOG_BOT_TOKEN = 'dev-summary-token';
    process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID = '-100123';
    process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID = '777';
  });

  afterAll(() => {
    global.fetch = oldFetch;
    if (oldBotToken === undefined) delete process.env.CHANGELOG_BOT_TOKEN;
    else process.env.CHANGELOG_BOT_TOKEN = oldBotToken;
    if (oldFallbackChatId === undefined) delete process.env.CHANGELOG_CHAT_ID;
    else process.env.CHANGELOG_CHAT_ID = oldFallbackChatId;
    if (oldDedicatedBotToken === undefined) delete process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN;
    else process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN = oldDedicatedBotToken;
    if (oldChatId === undefined) delete process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID;
    else process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID = oldChatId;
    if (oldThreadId === undefined) delete process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID;
    else process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID = oldThreadId;
  });

  it('posts a lead alert mentioning the specialist by stable telegram_id (not cached username) with escaped HTML', async () => {
    const result = await sendLeadTelegramAlert({
      qualificationId: 'qual-1',
      campaignId: 'campaign-1',
      leadEmail: 'lead@example.com',
      leadName: 'Ivan <Lead>',
      companyName: 'ACME & Co',
      campaignName: 'Growth <Q2>',
      clientName: 'Client <Acme>',
      specialistMentions: [
        { userId: 'u-1', fullName: 'Sergey Petrov', telegramId: '123456', telegramUsername: 'sergey_portal' },
      ],
      replySubject: 'Re: proposal',
      replyPreview: 'Interested <script>',
      aiReason: 'positive & explicit',
    });

    expect(result).toEqual({ sent: true, messageId: 42, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://api.telegram.org/botdev-summary-token/sendMessage');

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body).toEqual(expect.objectContaining({
      chat_id: '-100123',
      message_thread_id: 777,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }));
    // Пин инцидента Илианы (10.07.2026): кэшированный @username устаревает
    // (смена ника) → пинг молча пропадает. При наличии telegram_id упоминание
    // обязано идти по нему, а НЕ по нику.
    expect(body.text).toContain('<a href="tg://user?id=123456">Sergey Petrov</a>');
    expect(body.text).not.toContain('@sergey_portal');
    expect(body.text).toContain('Ivan &lt;Lead&gt;');
    expect(body.text).toContain('ACME &amp; Co');
    expect(body.text).toContain('Growth &lt;Q2&gt;');
    expect(body.text).toContain('Client &lt;Acme&gt;');
    expect(body.text).not.toContain('<script>');
  });

  it('falls back to tg user link when username is not linked', async () => {
    await sendLeadTelegramAlert({
      qualificationId: 'qual-2',
      campaignId: 'campaign-2',
      leadEmail: 'lead2@example.com',
      leadName: null,
      companyName: null,
      campaignName: null,
      clientName: null,
      specialistMentions: [
        { userId: 'u-2', fullName: 'Maria Ivanova', telegramId: '654321', telegramUsername: null },
      ],
      replySubject: null,
      replyPreview: null,
      aiReason: null,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('<a href="tg://user?id=654321">Maria Ivanova</a>');
  });

  it('falls back to @username mention when telegram_id is missing', async () => {
    await sendLeadTelegramAlert({
      qualificationId: 'qual-2b',
      campaignId: 'campaign-2b',
      leadEmail: 'lead2b@example.com',
      leadName: null,
      companyName: null,
      campaignName: null,
      clientName: null,
      specialistMentions: [
        { userId: 'u-3', fullName: 'Petr Sidorov', telegramId: null, telegramUsername: 'petr_portal' },
      ],
      replySubject: null,
      replyPreview: null,
      aiReason: null,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.text).toContain('@petr_portal');
  });

  it('returns the Telegram error body on a failed send (persisted to deadline_notification_log)', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"ok":false,"error_code":400,"description":"Bad Request: message thread not found"}',
    });

    const result = await sendLeadTelegramAlert({
      qualificationId: 'qual-4',
      campaignId: 'campaign-4',
      leadEmail: 'lead4@example.com',
      leadName: null,
      companyName: null,
      campaignName: null,
      clientName: null,
      specialistMentions: [],
      replySubject: null,
      replyPreview: null,
      aiReason: null,
    });

    expect(result.sent).toBe(false);
    expect(result.messageId).toBeNull();
    expect(result.error).toContain('HTTP 400');
    expect(result.error).toContain('message thread not found');
  });

  it('skips sending when chat id is not configured', async () => {
    delete process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID;
    delete process.env.CHANGELOG_CHAT_ID;

    const result = await sendLeadTelegramAlert({
      qualificationId: 'qual-3',
      campaignId: 'campaign-3',
      leadEmail: 'lead3@example.com',
      leadName: null,
      companyName: null,
      campaignName: null,
      clientName: null,
      specialistMentions: [],
      replySubject: null,
      replyPreview: null,
      aiReason: null,
    });

    expect(result).toEqual({
      sent: false,
      messageId: null,
      error: 'config missing (token=set, chat=missing)',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
