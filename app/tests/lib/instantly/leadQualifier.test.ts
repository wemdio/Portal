/** @jest-environment node */

import type { Email } from '@/lib/instantly/types';
import type { ThreadContext } from '@/lib/instantly/leadQualifier';

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: null,
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: null,
}));

jest.mock('@/lib/instantly/client', () => ({
  __esModule: true,
}));

function email(overrides: Partial<Email>): Email {
  return {
    id: 'email-1',
    campaign_id: 'campaign-1',
    from_address_email: 'lead@example.com',
    to_address_email_list: 'sales@example.com',
    thread_id: 'thread-1',
    ue_type: 2,
    subject: 'Re: proposal',
    body: { text: 'Сколько стоит?' },
    timestamp_email: '2026-05-13T12:00:00Z',
    ...overrides,
  } as Email;
}

function threadContext(): ThreadContext {
  const outbound = email({
    id: 'out-1',
    ue_type: 1,
    body: { text: 'Развернутое предложение '.repeat(30) },
    timestamp_email: '2026-05-13T11:00:00Z',
  });
  const reply = email({
    id: 'reply-1',
    ue_type: 2,
    body: { text: 'Сколько стоит? Давайте созвонимся.' },
    timestamp_email: '2026-05-13T12:00:00Z',
  });
  return { replyEmail: reply, threadEmails: [outbound, reply], lastOutbound: outbound };
}

describe('classifyWithAI', () => {
  const oldMaxTokens = process.env.INSTANTLY_LEAD_QUAL_MAX_TOKENS;

  beforeEach(() => {
    delete process.env.INSTANTLY_LEAD_QUAL_MAX_TOKENS;
    global.fetch = jest.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  is_lead: true,
                  proposal_seen: true,
                  interest_signals: ['запрос цены'],
                  reason: 'Клиент запросил цену.',
                  confidence: 0.9,
                  needs_review: false,
                  objection_handleable: false,
                  objection_draft: null,
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
  });

  afterAll(() => {
    if (oldMaxTokens === undefined) delete process.env.INSTANTLY_LEAD_QUAL_MAX_TOKENS;
    else process.env.INSTANTLY_LEAD_QUAL_MAX_TOKENS = oldMaxTokens;
  });

  it('uses a large enough max_tokens budget for Gemini JSON output', async () => {
    const { classifyWithAI } = await import('@/lib/instantly/leadQualifier');

    await classifyWithAI(threadContext(), { apiKey: 'test-key' });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { max_tokens?: number };
    expect(body.max_tokens).toBeGreaterThanOrEqual(2000);
  });

  it('allows max_tokens override from env for production tuning', async () => {
    process.env.INSTANTLY_LEAD_QUAL_MAX_TOKENS = '2400';
    const { classifyWithAI } = await import('@/lib/instantly/leadQualifier');

    await classifyWithAI(threadContext(), { apiKey: 'test-key' });

    const [, init] = (global.fetch as jest.Mock).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as { max_tokens?: number };
    expect(body.max_tokens).toBe(2400);
  });
});

describe('getBodyText', () => {
  it('декодирует числовые HTML-сущности в html-only письмах (mail.ru)', async () => {
    const { getBodyText } = await import('@/lib/instantly/leadQualifier');
    const html =
      '<div>&#1047;&#1076;&#1088;&#1072;&#1074;&#1089;&#1090;&#1074;&#1091;&#1081;&#1090;&#1077;, ' +
      '&laquo;&#1058;&#1077;&#1089;&#1090;&raquo; &mdash; &#x442;&#x435;&#x441;&#x442;</div>';
    expect(getBodyText({ html } as Email['body'])).toBe('Здравствуйте, «Тест» — тест');
  });

  it('декодирует &amp; последним (двойное кодирование не схлопывается)', async () => {
    const { getBodyText } = await import('@/lib/instantly/leadQualifier');
    expect(getBodyText({ html: 'a &amp;lt; b' } as Email['body'])).toBe('a &lt; b');
  });

  it('не трогает некорректные коды и неизвестные сущности', async () => {
    const { getBodyText } = await import('@/lib/instantly/leadQualifier');
    expect(getBodyText({ html: '&#99999999; &copy; ок' } as Email['body'])).toBe('&#99999999; &copy; ок');
  });

  it('plain-text часть возвращается как есть (без декода)', async () => {
    const { getBodyText } = await import('@/lib/instantly/leadQualifier');
    expect(getBodyText({ text: 'обычный текст &#1059;' } as Email['body'])).toBe('обычный текст &#1059;');
  });
});
