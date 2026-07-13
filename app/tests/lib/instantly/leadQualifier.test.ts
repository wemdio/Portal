/** @jest-environment node */

import type { Email } from '@/lib/instantly/types';
import type { ThreadContext } from '@/lib/instantly/leadQualifier';

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: null,
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: null,
}));

const mockListEmails = jest.fn();

jest.mock('@/lib/instantly/client', () => ({
  __esModule: true,
  listEmails: (...args: unknown[]) => mockListEmails(...args),
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

describe('qualifyReply prefetchedContext contract', () => {
  // null = «вызывающий УЖЕ фетчил контекст, его нет» — рефетч удваивал бы
  // /emails-вызовы ровно на деградирующем Instantly (общий лимит воркспейса).
  // Пин против отката `!== undefined` обратно на `??`.
  it('prefetchedContext: null → БЕЗ повторного fetchThreadContext, сразу needs_review', async () => {
    mockListEmails.mockClear();
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');

    const res = await qualifyReply('campaign-1', 'lead@example.com', 'thread-1', {
      apiKey: 'test-key',
      prefetchedContext: null,
    });

    expect(res.needsReview).toBe(true);
    expect(res.reason).toContain('Не удалось восстановить контекст');
    expect(mockListEmails).not.toHaveBeenCalled();
  });
});

describe('fetchThreadContext campaignOutboundMailboxes', () => {
  it('собирает ящики кампании из campaign-wide fallback (нормализованные) — база кросс-клиентского guard', async () => {
    mockListEmails.mockClear();
    const inbound = email({
      id: 'stray-1',
      ue_type: 2,
      from_address_email: 'head_market@nais.ru',
      to_address_email_list: 'kirill@kira-aggregator.ru',
      eaccount: 'kirill@kira-aggregator.ru',
      thread_id: 'thread-X',
    });
    const campaignOutbound = email({
      id: 'camp-out-1',
      ue_type: 1,
      // Регистр+пробел — пин нормализации.
      eaccount: ' Lyamina@Ritso-Contact.ru',
      from_address_email: 'lyamina@ritso-contact.ru',
      to_address_email_list: 'hr@nais.ru',
      thread_id: 'thread-Y',
      timestamp_email: '2026-07-01T00:00:00Z',
    });
    mockListEmails
      .mockResolvedValueOnce({ items: [inbound] }) // search=адрес отправителя
      .mockResolvedValueOnce({ items: [campaignOutbound] }); // campaign-wide fallback

    const { fetchThreadContext } = await import('@/lib/instantly/leadQualifier');
    const ctx = await fetchThreadContext('campaign-1', 'head_market@nais.ru', 'thread-X');

    expect(ctx).not.toBeNull();
    // Тред «слепого» письма наших исходящих не содержит…
    expect(ctx!.lastOutbound).toBeNull();
    // …но ящики кампании собраны из campaign-wide страницы — guard'у есть с чем сравнить.
    expect(ctx!.campaignOutboundMailboxes).toEqual(['lyamina@ritso-contact.ru']);
  });
});

describe('isAutoReplyOrUnsubscribe — уведомления о смене/закрытии ящика', () => {
  // Ложный лид stroytim_plus 29.06 (баг №1 от спеца): «почта прекратила свою
  // работу» + список новых контактов ИИ вероятностно читал как интерес.
  // Класс отсекается детерминированно, ДО модели.
  it('матчит реальные формальные уведомления (кейсы из прода)', async () => {
    const { isAutoReplyOrUnsubscribe } = await import('@/lib/instantly/leadQualifier');
    const positives = [
      'ООО «СТРОЙТАЙМ ПЛЮС» информирует Вас о том, что почта stroytim_plus@mail.ru прекратила свою работу. Официальная почта компании info@st-plus33.ru',
      'Просим Вас вести переписку с сотрудниками по направлениям деятельности.',
      'ООО "Татнефть-Самара" сообщает о смене адреса электронной почты.',
      'Данный почтовый ящик больше не обслуживается.',
      'This email address is no longer in use, please contact sales@example.com',
      'Просим направлять корреспонденцию на info@example.ru',
    ];
    for (const text of positives) {
      expect(isAutoReplyOrUnsubscribe(text)).toBe(true);
    }
  });

  it('НЕ матчит живые ответы с упоминанием адреса/почты (их решает ИИ)', async () => {
    const { isAutoReplyOrUnsubscribe } = await import('@/lib/instantly/leadQualifier');
    const negatives = [
      'Добрый день! Пришлите, пожалуйста, цены и условия.',
      'Интересно. Вышлите предложение на info@company.ru, это почта директора.',
      'Отправьте КП на другой адрес: zakupki@firma.ru, там быстрее посмотрят.',
      'Да, тема актуальна. Давайте созвонимся во вторник.',
    ];
    for (const text of negatives) {
      expect(isAutoReplyOrUnsubscribe(text)).toBe(false);
    }
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

// Пер-проектные критерии лида (ecbadde9c): кастомный текст отключает
// детерминированный ранний выход «ответ на запрос контакта = не лид» и
// попадает в промпт приоритетным блоком. Без критериев — поведение прежнее.
describe('qualifyReply — пер-проектное определение лида', () => {
  const oldFetch = global.fetch;
  const fetchMock = jest.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = oldFetch;
  });

  const outboundContactRequest = {
    id: 'out-1',
    ue_type: 1,
    body: { text: 'Подскажите, пожалуйста, кто у вас отвечает за 1С? Буду признательна за контакт.' },
    timestamp_email: '2026-07-13T08:00:00Z',
  } as Email;
  const callInviteReply = {
    id: 'in-1',
    ue_type: 2,
    body: { text: 'Можете меня набрать в 14.00-15.00.' },
    timestamp_email: '2026-07-13T09:00:00Z',
  } as Email;
  const ctx: ThreadContext = {
    replyEmail: callInviteReply,
    threadEmails: [outboundContactRequest, callInviteReply],
    lastOutbound: outboundContactRequest,
  };

  it('без кастомных критериев ответ на запрос контакта отсекается детерминированно, БЕЗ вызова ИИ', async () => {
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: ctx,
    });
    expect(res.isLead).toBe(false);
    expect(res.reason).toContain('запрос контакта');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('с кастомными критериями ранний выход отключён, промпт содержит приоритетный блок, вердикт ИИ проходит', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              is_lead: true,
              proposal_seen: false,
              interest_signals: ['предложил созвониться'],
              reason: 'Просит звонок в конкретное окно',
              confidence: 0.9,
              needs_review: false,
              objection_handleable: false,
              objection_draft: null,
            }),
          },
        }],
      }),
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Контакт ЛПР или предложение созвониться = лид. Развёрнутое предложение не требуется.',
      prefetchedContext: ctx,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const systemPrompt: string = body.messages[0].content;
    expect(systemPrompt).toContain('ОПРЕДЕЛЕНИЕ ЛИДА ДЛЯ ЭТОГО ПРОЕКТА');
    expect(systemPrompt).toContain('Контакт ЛПР или предложение созвониться = лид.');
    expect(res.isLead).toBe(true);
  });
});
