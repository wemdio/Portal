/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import { signHandoffCallback } from '@/lib/instantly/handoffCallback';

let mockInstantlyDb: MockSupabaseClient | null;
let mockMainDb: MockSupabaseClient | null;

const replyToEmail = jest.fn();
const sendTestEmail = jest.fn();
const getEmail = jest.fn();
const answerCallback = jest.fn();
const editHandoffMessage = jest.fn();

jest.mock('@/lib/supabaseInstantly', () => ({
  get supabaseInstantly() {
    return mockInstantlyDb;
  },
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockMainDb;
  },
}));

jest.mock('@/lib/instantly/client', () => ({
  __esModule: true,
  replyToEmail: (...args: unknown[]) => replyToEmail(...args),
  sendTestEmail: (...args: unknown[]) => sendTestEmail(...args),
  getEmail: (...args: unknown[]) => getEmail(...args),
}));

jest.mock('@/lib/instantly/handoffTelegram', () => ({
  __esModule: true,
  handoffBotToken: () => 'test-bot-token',
  answerCallback: (...args: unknown[]) => answerCallback(...args),
  editHandoffMessage: (...args: unknown[]) => editHandoffMessage(...args),
}));

jest.mock('@/lib/loggerServer', () => ({
  __esModule: true,
  logError: async () => undefined,
}));

const HOOK_SECRET = 'hook-secret';
const QUAL_ID = 'q-others-1';
const LEAD = 'lead@example.com';
const CLIENT = 'client@example.com';
const CAMPAIGN_400 =
  'InstantlyApiError: Instantly API 400: {"statusCode":400,"error":"Bad Request","message":"The email you are replying to is not part of an Instantly campaign, so you cannot reply to it (missing campaign_id)"}';

function makeUpdate() {
  return {
    callback_query: {
      id: 'cq-1',
      data: signHandoffCallback(QUAL_ID, 'test-bot-token'),
      from: { id: 12345 },
      message: { message_id: 777, chat: { id: -100123 } },
    },
  };
}

function fakeReq(update: unknown) {
  return {
    json: async () => update,
    headers: { get: (k: string) => (k === 'x-telegram-bot-api-secret-token' ? HOOK_SECRET : null) },
  } as never;
}

async function importRoute() {
  return import('@/app/api/telegram/handoff/webhook/route');
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  process.env.LEAD_HANDOFF_WEBHOOK_SECRET = HOOK_SECRET;

  mockInstantlyDb = createMockSupabase({
    tables: {
      instantly_pending_handoffs: [
        {
          id: 'ph-1',
          qualification_id: QUAL_ID,
          status: 'pending',
          draft_text: 'Добрый день! Передаю вас коллегам.',
          reply_to_uuid: 'email-others-1',
          eaccount: 'sender@example.com',
          client_email: CLIENT,
          responsible_user_id: 'spec-1',
          campaign_id: 'camp-1',
        },
      ],
      instantly_lead_qualifications: [
        {
          id: QUAL_ID,
          reply_subject: 'Re: "Системы Комфорта"',
          lead_email: LEAD,
          lead_name: 'Венера',
          reply_body: 'Добрый день, я к обсуждению готова.',
          reply_timestamp: '2026-07-27T12:00:00.000Z',
          campaign_name: 'Производства_АДК',
        },
      ],
      client_forwarded_leads: [],
    },
  });
  mockMainDb = createMockSupabase({
    tables: {
      telegram_links: [{ user_id: 'spec-1', telegram_id: 12345, telegram_username: 'spec' }],
    },
  });
  getEmail.mockRejectedValue(new Error('no original — cc only client'));
  sendTestEmail.mockResolvedValue({ id: 'sent-1' });
});

describe('handoff webhook: Others-fallback на тест-эндпоинт', () => {
  it('reply 400 «not part of an Instantly campaign» → тест-эндпоинт с лидом и клиентом в To', async () => {
    replyToEmail.mockRejectedValue(new Error(CAMPAIGN_400));
    const { POST } = await importRoute();

    const res = await POST(fakeReq(makeUpdate()));
    expect(res.status).toBe(200);

    expect(sendTestEmail).toHaveBeenCalledTimes(1);
    const call = sendTestEmail.mock.calls[0][0] as {
      eaccount: string;
      to_address_email_list: string;
      subject: string;
      body: { html: string };
    };
    expect(call.eaccount).toBe('sender@example.com');
    expect(call.to_address_email_list).toContain(LEAD);
    expect(call.to_address_email_list).toContain(CLIENT);
    expect(call.subject).toBe('Re: "Системы Комфорта"');
    expect(call.body.html).toContain('Передаю вас коллегам');

    // pending → sent, трекинг с меткой handoff-auto-test, кнопка «съедена»
    const pending = mockInstantlyDb!.getRows('instantly_pending_handoffs')[0];
    expect(pending.status).toBe('sent');
    const forwarded = mockInstantlyDb!.getRows('client_forwarded_leads');
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ lead_email: LEAD, forwarded_via: 'handoff-auto-test' });
    expect(editHandoffMessage).toHaveBeenCalledTimes(1);
    const editText = editHandoffMessage.mock.calls[0][3] as string;
    expect(editText).toContain('треда в Unibox не будет');
    expect(answerCallback).toHaveBeenCalledWith('test-bot-token', 'cq-1', 'Передано клиенту ✅');
  });

  it('другая ошибка reply (500) → БЕЗ fallback: status failed, тест-эндпоинт не вызывается', async () => {
    replyToEmail.mockRejectedValue(new Error('InstantlyApiError: Instantly API 500: oops'));
    const { POST } = await importRoute();

    await POST(fakeReq(makeUpdate()));
    expect(sendTestEmail).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('instantly_pending_handoffs')[0].status).toBe('failed');
    expect(mockInstantlyDb!.getRows('client_forwarded_leads')).toHaveLength(0);
  });

  it('штатный reply (письмо в кампании) → обычный путь, тест-эндпоинт не нужен', async () => {
    replyToEmail.mockResolvedValue({ id: 'replied-1' });
    const { POST } = await importRoute();

    await POST(fakeReq(makeUpdate()));
    expect(sendTestEmail).not.toHaveBeenCalled();
    // Пиним primary-путь: те же аргументы reply, что и до фикса
    const reply = replyToEmail.mock.calls[0][0] as {
      reply_to_uuid: string;
      eaccount: string;
      subject: string;
      body: { html: string; text: string };
      cc_address_email_list?: string;
    };
    expect(reply.reply_to_uuid).toBe('email-others-1');
    expect(reply.eaccount).toBe('sender@example.com');
    expect(reply.subject).toBe('Re: "Системы Комфорта"');
    expect(reply.body.html).toContain('Передаю вас коллегам');
    expect(reply.body.text).toContain('Добрый день, я к обсуждению готова.');
    expect(reply.cc_address_email_list).toBe(CLIENT);
    const forwarded = mockInstantlyDb!.getRows('client_forwarded_leads');
    expect(forwarded[0]).toMatchObject({ forwarded_via: 'handoff-auto' });
    const editText = editHandoffMessage.mock.calls[0][3] as string;
    expect(editText).not.toContain('треда в Unibox не будет');
  });

  it('campaign-400, но lead_email пуст → БЕЗ fallback: status failed, тест-эндпоинт не вызывается', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        instantly_pending_handoffs: [
          {
            id: 'ph-2',
            qualification_id: QUAL_ID,
            status: 'pending',
            draft_text: 'Драфт.',
            reply_to_uuid: 'email-others-1',
            eaccount: 'sender@example.com',
            client_email: CLIENT,
            responsible_user_id: 'spec-1',
            campaign_id: 'camp-1',
          },
        ],
        instantly_lead_qualifications: [
          { id: QUAL_ID, reply_subject: 'Re: x', lead_email: '', reply_body: 'текст' },
        ],
        client_forwarded_leads: [],
      },
    });
    replyToEmail.mockRejectedValue(new Error(CAMPAIGN_400));
    const { POST } = await importRoute();

    await POST(fakeReq(makeUpdate()));
    expect(sendTestEmail).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('instantly_pending_handoffs')[0].status).toBe('failed');
  });
});
