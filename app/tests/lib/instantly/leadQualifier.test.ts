/** @jest-environment node */

import type { Email } from '@/lib/instantly/types';
import type { ThreadContext } from '@/lib/instantly/leadQualifier';
import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';

let mockInstantlyDb: MockSupabaseClient | null = null;
let mockMainDb: MockSupabaseClient | null = null;

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

const formalMailboxChangeSubject =
  'Уведомление о смене электронного почтового адреса ООО «СК Энерготехстрой» Re: Кому направить запрос по П-проектам';
const formalMailboxOperationalContact =
  'Если у Вас есть срочные вопросы, свяжитесь с нами по телефону: +7 (812) 982-97-62.';
const formalMailboxChangeBody = [
  'Уважаемый отправитель,',
  '',
  'Благодарим за Ваше сообщение! ООО «СК Энерготехстрой» обновила свой основной электронный почтовый адрес в рамках модернизации IT-инфраструктуры.',
  '',
  'С 24 ноября 2025 года все официальные письма следует направлять на новый адрес:',
  'info@example.ru',
  '',
  `Старый адрес old@example.com перенаправил Ваше сообщение на info@example.ru, но для оперативности рекомендуем использовать новый. ${formalMailboxOperationalContact}`,
  '',
  'Спасибо за понимание и сотрудничество!',
].join('\n');

describe('fetchBriefByCampaign ownership isolation', () => {
  afterEach(() => {
    mockInstantlyDb = null;
    mockMainDb = null;
  });

  it('does not select either project brief when legacy and period links disagree', async () => {
    jest.resetModules();
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { campaign_id: 'campaign-1', project_id: 'project-a' },
        ],
        project_period_instantly_campaigns: [
          { campaign_id: 'campaign-1', project_id: 'project-b' },
        ],
        instantly_brief_campaigns: [],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-a', brief_text: 'Чужой brief A' },
          { id: 'project-b', brief_text: 'Чужой brief B' },
        ],
      },
    });

    const { fetchBriefByCampaign } = await import('@/lib/instantly/leadQualifier');
    await expect(fetchBriefByCampaign('campaign-1')).rejects.toThrow(/multiple project owners/i);
    expect(mockMainDb.selects.filter((call) => call.table === 'projects')).toHaveLength(0);
  });

  it('uses only the caller-proven project and never re-resolves a different link', async () => {
    jest.resetModules();
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { campaign_id: 'campaign-1', project_id: 'stale-project' },
        ],
        project_period_instantly_campaigns: [],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'proven-project', brief_text: 'Правильный brief' },
          { id: 'stale-project', brief_text: 'Старый brief' },
        ],
      },
    });

    const { fetchBriefByCampaign } = await import('@/lib/instantly/leadQualifier');
    await expect(fetchBriefByCampaign('campaign-1', {
      projectId: 'proven-project',
      ownershipProven: true,
    })).resolves.toBe('Правильный brief');
    expect(mockInstantlyDb.selects.filter((call) =>
      call.table === 'project_instantly_campaigns' ||
      call.table === 'project_period_instantly_campaigns'
    )).toHaveLength(0);
  });

  it('does not fall back to a stale legacy brief when the proven managed project has no brief', async () => {
    jest.resetModules();
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        instantly_brief_campaigns: [
          {
            campaign_id: 'campaign-1',
            brief_id: 'legacy-brief',
            instantly_briefs: { brief_text: 'Старый brief предыдущего владельца' },
          },
        ],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{ id: 'proven-project', brief_text: null }],
      },
    });

    const { fetchBriefByCampaign } = await import('@/lib/instantly/leadQualifier');
    await expect(fetchBriefByCampaign('campaign-1', {
      projectId: 'proven-project',
      ownershipProven: true,
    })).resolves.toBeNull();
    expect(mockInstantlyDb.selects.filter((call) =>
      call.table === 'instantly_brief_campaigns'
    )).toHaveLength(0);
  });

  it('propagates a managed project brief read failure so qualification can retry', async () => {
    jest.resetModules();
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        instantly_brief_campaigns: [],
      },
    });
    mockMainDb = createMockSupabase({
      errorSelects: {
        projects: {
          columnsInclude: 'brief_text',
          message: 'project brief unavailable',
        },
      },
      tables: {
        projects: [{ id: 'proven-project', brief_text: 'Правильный brief' }],
      },
    });

    const { fetchBriefByCampaign } = await import('@/lib/instantly/leadQualifier');
    await expect(fetchBriefByCampaign('campaign-1', {
      projectId: 'proven-project',
      ownershipProven: true,
    })).rejects.toThrow(/project brief unavailable/i);
    expect(mockInstantlyDb.selects.filter((call) =>
      call.table === 'instantly_brief_campaigns'
    )).toHaveLength(0);
  });

  it('propagates a self-serve legacy brief read failure instead of caching it as absent', async () => {
    jest.resetModules();
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
        instantly_brief_campaigns: [],
      },
      errorSelects: {
        instantly_brief_campaigns: {
          columnsInclude: 'brief_id',
          message: 'legacy brief storage unavailable',
        },
      },
    });
    mockMainDb = createMockSupabase({ tables: { projects: [] } });

    const { fetchBriefByCampaign } = await import('@/lib/instantly/leadQualifier');
    await expect(fetchBriefByCampaign('campaign-1', {
      projectId: null,
      ownershipProven: true,
    })).rejects.toThrow(/legacy brief storage unavailable/i);
  });
});

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

describe('classifyMachineReply — формальное уведомление о смене почты', () => {
  it('распознаёт полный production-кейс несмотря на дежурный контактный CTA', async () => {
    const { classifyMachineReply } = await import('@/lib/instantly/leadQualifier');

    expect(classifyMachineReply(email({
      subject: formalMailboxChangeSubject,
      body: { text: formalMailboxChangeBody },
    }))).toBe('auto_reply');
  });

  it.each([
    {
      name: 'одна формальная тема без подтверждающего тела',
      subject: formalMailboxChangeSubject,
      body: 'Добрый день! Пришлите КП с ценами на этот адрес.',
    },
    {
      name: 'живой запрос КП после сообщения об обновлении адреса',
      subject: 'Re: proposal',
      body: 'Мы обновили электронный почтовый адрес. Пришлите КП с ценами на new@example.ru.',
    },
    {
      name: 'обновление email-функции продукта и предложение созвона',
      subject: 'Re: proposal',
      body: 'Мы обновили email в вашей системе. Давайте созвонимся завтра.',
    },
  ])('не блокирует человеческий ответ: $name', async ({ subject, body }) => {
    const { classifyMachineReply } = await import('@/lib/instantly/leadQualifier');

    expect(classifyMachineReply(email({ subject, body: { text: body } }))).toBeNull();
  });

  it.each([
    'Отдельно по вашему предложению: пришлите КП с ценами на новый адрес.',
    'Ваше предложение интересно. Давайте созвонимся завтра.',
  ])('не скрывает настоящий коммерческий CTA после служебного текста: %s', async (cta) => {
    const { classifyMachineReply } = await import('@/lib/instantly/leadQualifier');

    expect(classifyMachineReply(email({
      subject: formalMailboxChangeSubject,
      body: { text: `${formalMailboxChangeBody}\n\n${cta}` },
    }))).toBeNull();
  });

  it.each([
    'отдельно по вашему предложению пришлите КП с ценами.',
    'давайте созвонимся завтра.',
  ])('не удаляет коммерческий CTA после служебного контакта в той же строке: %s', async (cta) => {
    const { classifyMachineReply } = await import('@/lib/instantly/leadQualifier');
    const bodyWithInlineCta = formalMailboxChangeBody.replace(
      formalMailboxOperationalContact,
      `${formalMailboxOperationalContact.slice(0, -1)}; ${cta}`,
    );

    expect(classifyMachineReply(email({
      subject: formalMailboxChangeSubject,
      body: { text: bodyWithInlineCta },
    }))).toBeNull();
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
  function mockAiResult(overrides: Record<string, unknown> = {}) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              is_lead: true,
              proposal_seen: false,
              interest_signals: ['прямой CTA'],
              reason: 'Клиент предложил конкретный следующий шаг',
              confidence: 0.9,
              needs_review: false,
              objection_handleable: false,
              objection_draft: null,
              ...overrides,
            }),
          },
        }],
      }),
    });
  }

  function contextWithReply(
    text: string,
    lastOutbound: Email | null = outboundContactRequest,
    replyOverrides: Partial<Email> = {},
  ): ThreadContext {
    const reply = {
      ...callInviteReply,
      ...replyOverrides,
      body: { text },
    } as Email;
    return {
      replyEmail: reply,
      threadEmails: lastOutbound ? [lastOutbound, reply] : [reply],
      lastOutbound,
    };
  }

  const outboundProposal = {
    ...outboundContactRequest,
    body: {
      text: [
        'Добрый день!',
        'Предлагаем единую систему ТОиР для распределённых объектов.',
        'Она помогает контролировать заявки, ремонты и запасы на всех площадках.',
        'Подготовим план решения задач с учётом вашей структуры. Какие шаги нужны, чтобы обсудить реализацию?',
      ].join('\n'),
    },
  } as Email;

  const adkEmailCriteria = [
    'Дополнительно считать лидом, если дали номер телефона и Имя, предложили созвониться или попросили связаться.',
    'Оставили какой-то мессенджер для связи и попросили связаться в нем.',
    'Также считать лидом если поделились кодом в АТИ (ati.su).',
    'Также считать лидом, если поделились почтой.',
    'Также считать лидом, если попросили сделать расчет заявки, рассчитать стоимость перевозки.',
  ].join(' ');
  const camozziEmailRoutingReply = [
    'Добрый день, Никита.',
    'В Санкт-Петербург только отдел продаж, склада нет.',
    'Попробуйте уточнить информацию по этому адресу: info@camozzi.ru',
    '',
    'С уважением,',
    'Мария Иванова',
    'Менеджер отдела продаж',
    'maria.ivanova@camozzi.ru',
  ].join('\n');

  async function qualifyEmailCriterionReply(
    replyText: string,
    options: {
      leadCriteria?: string;
      aiOverrides?: Record<string, unknown>;
    } = {},
  ) {
    mockAiResult({
      is_lead: false,
      custom_criteria_matched: false,
      interest_signals: [],
      reason: 'Модель не распознала кастомный критерий.',
      needs_review: false,
      ...options.aiOverrides,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    return qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: options.leadCriteria ?? adkEmailCriteria,
      prefetchedContext: contextWithReply(replyText),
    });
  }

  function replyWithQuotedProposal(authoredReply: string): string {
    return [
      authoredReply,
      '',
      'С уважением,',
      'Иванова Светлана Евгеньевна',
      'начальник отдела продаж',
      'АО «АК Корвет»',
      '(3522) 476-748',
      'svetlana.ivanova@korvet-jsc.ru',
      '',
      '18.08.2026 11:21, Dmitrij Kasilov пишет:',
      '> Добрый день!',
      '> Предлагаем единую систему ТОиР для распределённых объектов.',
      '> Подготовим план решения задач. Какие шаги нужны, чтобы обсудить реализацию?',
    ].join('\n');
  }

  async function qualifyQuotedProposalReply(authoredReply: string, leadCriteria?: string) {
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    return qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria,
      prefetchedContext: contextWithReply(
        replyWithQuotedProposal(authoredReply),
        outboundProposal,
      ),
    });
  }

  async function qualifyInterestAfterOutbound(outboundText: string) {
    const outbound = {
      ...outboundProposal,
      body: { text: outboundText },
    } as Email;
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    return qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Интересно.', outbound),
    });
  }

  it('отсекает подтверждение службы поддержки ArtTech до AI даже при кастомном критерии', async () => {
    mockAiResult({
      is_lead: true,
      custom_criteria_matched: true,
      reason: 'В письме есть имя и телефон.',
    });
    const artTechReply = [
      'Здравствуйте!',
      '',
      'Спасибо за обращение в службу поддержки ArtTech.',
      '',
      'Ваш запрос получен и зарегистрирован.',
      'Мы уже работаем над вашим вопросом и ответим в ближайшее время.',
      '',
      'Если обращение срочное, пожалуйста, свяжитесь с нами:',
      '+7 (700) 783-08-88',
      '',
      '—',
      'Служба поддержки ArtTech',
      'arttech.kz',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Если поделились номером телефона и именем — это лид.',
      prefetchedContext: contextWithReply(artTechReply, outboundProposal, {
        from_address_email: 'support@arttech.kz',
        subject: 'ArtTech — обращение в поддержку принято',
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      isLead: false,
      customCriteriaMatched: false,
      needsReview: false,
    });
    expect(res.reason).toMatch(/служебн|автоответ/i);
  });

  it('отсекает чистое HTML-only подтверждение поддержки с div-блоками', async () => {
    mockAiResult({
      is_lead: true,
      reason: 'Модель не должна вызываться для чистого acknowledgement.',
    });
    const htmlContext = contextWithReply('', outboundProposal, {
      from_address_email: 'support@arttech.kz',
      subject: 'ArtTech — обращение в поддержку принято',
    });
    htmlContext.replyEmail.body = {
      html: [
        '<div>Здравствуйте!</div>',
        '<div>Спасибо за обращение в службу поддержки ArtTech.</div>',
        '<div>Ваш запрос получен и зарегистрирован.</div>',
        '<div>Мы уже работаем над вашим вопросом и ответим в ближайшее время.</div>',
        '<div>Служба поддержки ArtTech</div>',
        '<div>arttech.kz</div>',
      ].join(''),
    };
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: htmlContext,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.isLead).toBe(false);
  });

  it('отсекает отчёт postmaster о переполненном ящике до AI', async () => {
    mockAiResult({
      is_lead: true,
      reason: 'Получатель предложил вернуться к нему позже.',
    });
    const deliveryFailure = [
      'Не удалось выполнить доставку следующим получателям или группам:',
      'cs@ruschem.ru',
      '',
      'Почтовый ящик получателя переполнен и в данный момент не может принимать сообщения.',
      'Попытайтесь повторно отправить это сообщение позже или обратитесь к получателю напрямую.',
      '',
      'Диагностические сведения для администраторов:',
      'Формирующий сервер: cit.cs',
      '#554-5.2.2 mailbox full 554 5.2.2 STOREDRV Deliver.Exception:QuotaExceededException',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(deliveryFailure, outboundProposal, {
        from_address_email: 'postmaster@cit.cs',
        subject: 'Не удается доставить: Re: подключение «СЗ» к сервису',
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      isLead: false,
      customCriteriaMatched: false,
      needsReview: false,
    });
    expect(res.reason).toMatch(/достав|служебн/i);
  });

  it('не блокирует живой коммерческий ответ только из-за адреса support@', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП', 'обсуждение'],
      reason: 'Получатель проявил интерес и запросил КП.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Интересно, пришлите КП и давайте обсудим на следующей неделе.',
        outboundProposal,
        {
          from_address_email: 'support@company.ru',
          subject: 'Re: предложение',
        },
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('не блокирует человеческое упоминание ошибки доставки с прямым CTA', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП'],
      reason: 'Получатель попросил прислать КП ему.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'У коллеги вчера delivery failed, но пришлите КП мне на этот адрес.',
        outboundProposal,
        {
          from_address_email: 'ivan@company.ru',
          subject: 'Re: предложение',
        },
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('передаёт в AI живой коммерческий ответ внутри обёртки службы поддержки', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП'],
      reason: 'Получатель запросил коммерческое предложение.',
    });
    const wrappedHumanReply = [
      'Ваш запрос получен и зарегистрирован.',
      'Наша служба поддержки ответит в ближайшее время.',
      '',
      'По вашему предложению: интересно, пришлите КП с ценами.',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(wrappedHumanReply, outboundProposal, {
        from_address_email: 'support@company.ru',
        subject: 'Ваше обращение принято',
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('передаёт в AI неизвестный содержательный вопрос внутри support-обёртки', async () => {
    mockAiResult({
      is_lead: false,
      interest_signals: ['вопрос по интеграции'],
      reason: 'Содержательный вопрос требует обычной AI-квалификации.',
      needs_review: true,
    });
    const wrappedQuestion = [
      'Ваш запрос получен и зарегистрирован.',
      'Наша служба поддержки ответит в ближайшее время.',
      '',
      'Пока дорого; уточните, как решение интегрируется с 1С?',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(wrappedQuestion, outboundProposal, {
        from_address_email: 'support@company.ru',
        subject: 'Ваше обращение принято',
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.needsReview).toBe(true);
  });

  it('не принимает служебную просьбу тикета о дополнительных материалах за интерес', async () => {
    mockAiResult({
      is_lead: true,
      reason: 'Модель ошибочно приняла служебную инструкцию за интерес.',
    });
    const serviceRequest = [
      'Ваш запрос получен и зарегистрирован.',
      'Наша служба поддержки ответит в ближайшее время.',
      'Для обработки обращения пришлите дополнительную информацию и материалы.',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(serviceRequest, outboundProposal, {
        from_address_email: 'support@company.ru',
        subject: 'Ваше обращение принято',
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.isLead).toBe(false);
  });

  it.each([
    'Автоматический ответ: я в отпуске. Давайте созвонимся после 10 сентября.',
    'Интересно, но больше не пишите.',
  ])('явный автоответ или отписка остаётся безусловным стопом: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      reason: 'Модель не должна вызываться для доказанного машинного ответа.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, outboundProposal),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.isLead).toBe(false);
  });

  it('отсекает production-уведомление о смене почты до AI и кастомных критериев', async () => {
    mockAiResult({
      is_lead: true,
      custom_criteria_matched: true,
      reason: 'Модель ошибочно приняла email и телефон автоответчика за лид.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Если поделились почтой или телефоном — это лид.',
      prefetchedContext: contextWithReply(formalMailboxChangeBody, outboundProposal, {
        from_address_email: 'old@example.com',
        subject: formalMailboxChangeSubject,
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      isLead: false,
      customCriteriaMatched: false,
      needsReview: false,
    });
  });

  it('передаёт в AI настоящий запрос КП после формального уведомления о смене почты', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП'],
      reason: 'Получатель отдельно запросил коммерческое предложение.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        `${formalMailboxChangeBody}\n\nОтдельно по вашему предложению: пришлите КП с ценами.`,
        outboundProposal,
        {
          from_address_email: 'old@example.com',
          subject: formalMailboxChangeSubject,
        },
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('распознаёт сильный auto-reply marker после приветствия и благодарности', async () => {
    mockAiResult({
      is_lead: true,
      custom_criteria_matched: true,
      reason: 'Модель ошибочно приняла телефон автоответчика за кастомный лид.',
    });
    const delayedMarkerReply = [
      'Hello!',
      'Thank you for your email.',
      'This is an automatic response: your message will be reviewed shortly.',
      'Phone: +1 555 123 4567',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Если поделились именем и номером телефона — это лид.',
      prefetchedContext: contextWithReply(delayedMarkerReply, outboundProposal, {
        from_address_email: 'notifications@company.com',
        subject: 'Re: proposal',
      }),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      isLead: false,
      customCriteriaMatched: false,
      needsReview: false,
    });
  });

  it('не блокирует голый заголовок automatic response в третьем человеческом абзаце', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос цены'],
      reason: 'Получатель обсуждает функцию продукта и запросил цену.',
    });
    const humanProductReply = [
      'Hello!',
      'We are interested in your proposal.',
      'Automatic response: this feature is supported in our current system.',
      'Please send pricing.',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(humanProductReply, outboundProposal),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('оставляет OOO с дежурным вопросом и контактами машинным письмом', async () => {
    mockAiResult({
      is_lead: true,
      custom_criteria_matched: true,
      reason: 'Модель ошибочно приняла дежурный контакт за кастомный лид.',
    });
    const oooWithHelpQuestion = [
      'Я сейчас в отпуске до 10 сентября.',
      'По срочным вопросам пишите Ивану.',
      'Нужна срочная помощь?',
      'Телефон: +7 999 123-45-67',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Если поделились именем и номером телефона — это лид.',
      prefetchedContext: contextWithReply(oooWithHelpQuestion, outboundProposal),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.isLead).toBe(false);
  });

  it('передаёт в AI коммерческий вопрос внутри OOO', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос стоимости'],
      reason: 'Получатель запросил стоимость.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Я сейчас в отпуске до 10 сентября. Какая стоимость вашего решения?',
        outboundProposal,
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it.each([
    'Сейчас отсутствует возможность созвониться, но завтра давайте обсудим.',
    'Нас интересует автоматическая система, пришлите КП с ценами.',
    'We are interested in your automatic warehouse solution. Please send pricing.',
    'Нам нужно автоматическое уведомление о заявках, пришлите КП.',
    'We need an automatic response system for support tickets. Please send pricing.',
    'Официальная почта компании изменилась; пришлите КП на new-address@company.ru.',
    'Я сейчас в отпуске, давайте созвонимся после 10 сентября.',
  ])('не принимает лексику продукта/доступности за доказанный автоответ: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['коммерческий интерес'],
      reason: 'Получатель выразил интерес к предложению.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, outboundProposal),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('передаёт в AI пересланный человеком DSN с собственным коммерческим запросом', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП'],
      reason: 'Отправитель добавил собственный запрос поверх отчёта о недоставке.',
    });
    const forwardedDeliveryReport = [
      'Не удалось выполнить доставку: mailbox full, 554 5.2.2.',
      'Диагностические сведения для администраторов: QuotaExceededException.',
      '',
      'Но мне ваше предложение интересно — пришлите КП сюда.',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(forwardedDeliveryReport, outboundProposal, {
        from_address_email: 'ivan@company.ru',
        subject: 'Delivery failed: Re: предложение',
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('не считает унаследованную тему автоответа достаточной для блокировки живого CTA', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП'],
      reason: 'Основной ответ написан человеком и содержит запрос КП.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Да, интересно. Пришлите КП, пожалуйста.',
        outboundProposal,
        {
          from_address_email: 'ivan@company.ru',
          subject: 'Re: Автоматический ответ: предложение',
        },
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('не принимает unsubscribe из HTML-цитаты за отписку автора ответа', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП'],
      reason: 'Unsubscribe находится только в процитированном исходящем письме.',
    });
    const htmlContext = contextWithReply('', outboundProposal);
    htmlContext.replyEmail.body = {
      html: [
        '<div>Да, интересно. Пришлите КП с ценами.</div>',
        '<blockquote><div>Our original proposal</div><div>Unsubscribe</div></blockquote>',
      ].join(''),
    };
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: htmlContext,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('не блокирует живой адрес, название которого лишь начинается с bounce', async () => {
    mockAiResult({
      is_lead: true,
      interest_signals: ['запрос КП'],
      reason: 'Получатель запросил КП.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Интересно, пришлите КП с ценами.',
        outboundProposal,
        {
          from_address_email: 'bouncehouse@company.ru',
          subject: 'Re: предложение',
        },
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it('принимает custom_criteria_matched только как строгий JSON boolean', async () => {
    const { _private } = await import('@/lib/instantly/leadQualifier');
    const actualTrue = _private.parseAIResult('{"custom_criteria_matched": true}');
    const stringFalse = _private.parseAIResult('{"custom_criteria_matched": "false"}');

    expect(actualTrue.customCriteriaMatched).toBe(true);
    expect(stringFalse.customCriteriaMatched).toBe(false);
  });

  it('одиночное «КП» по дефолтному критерию доходит до AI и считается лидом', async () => {
    mockAiResult({
      is_lead: true,
      custom_criteria_matched: false,
      interest_signals: ['запрос КП'],
      reason: 'Получатель запросил коммерческое предложение.',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('КП', null),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each(['Да', 'Yes'])(
    'короткий ответ «%s» доходит до кастомного критерия и получает его приоритет',
    async (replyText) => {
      mockAiResult({
        is_lead: false,
        custom_criteria_matched: true,
        interest_signals: ['совпадение с кастомным критерием'],
        reason: 'Ответ соответствует определению проекта.',
        needs_review: true,
      });
      const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
      const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
        apiKey: 'test-key',
        briefText: '',
        leadCriteria: 'Одиночный ответ «Да» или «Yes» считать лидом.',
        prefetchedContext: contextWithReply(replyText, null),
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(res.customCriteriaMatched).toBe(true);
      expect(res.isLead).toBe(true);
      expect(res.needsReview).toBe(false);
    },
  );

  it.each(['.', 'Спасибо'])(
    'реальный мусор «%s» по-прежнему отсекается до AI',
    async (replyText) => {
      const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
      const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
        apiKey: 'test-key',
        briefText: '',
        leadCriteria: 'Одиночный ответ «Да» или «Yes» считать лидом.',
        prefetchedContext: contextWithReply(replyText, null),
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(res.customCriteriaMatched).toBe(false);
      expect(res.isLead).toBe(false);
    },
  );

  it.each([
    'Можете меня набрать в 14.00-15.00.',
    'Давайте завтра проведём встречу.',
    'Пришлите КП',
    'Напишите КП',
    'Пришлите, пожалуйста, КП на этот адрес.',
    'Пришлите КП, ivan@example.com',
    'Позвоните +7 999 123-45-67',
    'Позвоните по телефону +7 999 123-45-67',
    'Свяжитесь со мной завтра после 15:00.',
    'Когда можем поговорить?',
    'Можно пообщаться на этой неделе?',
    'Пришлите, пожалуйста, прайс.',
    'Во сколько обойдётся внедрение?',
    'Я ответственный. Какие у вас тарифы?',
    'Я ответственный. Позвоните завтра.',
    'Ответственный Иван просит прислать коммерческое предложение.',
    'Я ответственный. Не готов сегодня созваниваться но пришлите КП.',
    'Я ответственный, позвоните завтра.',
    'Я ответственный. Сколько у вас стоит?',
    'I am responsible. What is the price?',
    'Ответственный я. Звоните завтра.',
    'Я ответственный, согласен на встречу.',
    'Я ответственный, покажите демо.',
    'Я ответственный, запустим пилот.',
    'Я ответственный, оформляем заказ.',
    'John is responsible. Call tomorrow.',
    'John is responsible. We can meet Tuesday.',
    'John is responsible. Book a demo.',
    'John is responsible. We need a quote.',
    'Send Quote',
    'Book Demo',
    'Call Tomorrow',
    'Заказ 1234567890 подтверждаем.',
    'Я ответственный. Выставляйте счёт.',
    'Я ответственный, готовы начать.',
    'Я ответственный: присылайте договор.',
  ])('без кастомных критериев прямой CTA после запроса контакта доходит до ИИ: %s', async (replyText) => {
    mockAiResult();
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
  });

  it.each([
    'Ответственный я, мне интересно.',
    'Ответственный я. Мне хотелось бы узнать подробнее.',
    'Я ответственный. Что вы предлагаете?',
    'John is responsible. Interested.',
    'Интересно.',
  ])('неоднозначный интерес после запроса контакта доходит до ИИ и может уйти на проверку: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      interest_signals: [],
      reason: 'Интерес есть, но конкретного следующего шага нет',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(true);
  });

  it.each([
    'Интересно.',
    'Да, интересно.',
    'Нам интересно.',
    'Возможно, нам это интересно.',
    'Звучит интересно.',
  ])('подтверждённый оффер + положительный интерес становится лидом: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель оставила положительный интерес на проверке',
      needs_review: true,
    });

    const res = await qualifyQuotedProposalReply(replyText);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.proposalSeen).toBe(true);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('положительный интерес к предложению');
  });

  it.each([
    {
      offerStyle: 'реальный оффер АСМО-ТОиР',
      outboundText: [
        'Добрый день! Пишу по поводу частой проблемы производственных компаний с несколькими площадками.',
        'Мы как раз помогаем производственным и инфраструктурным предприятиям со сложной филиальной структурой навести порядок в этих процессах с помощью АСМО-ТОиР — единой системы для управления техническим обслуживанием и ремонтом на всех объектах.',
        'Команда видит заявки, ремонты, запасы и риски простоя в одном месте. Готовы показать план внедрения под вашу структуру.',
      ].join('\n'),
    },
    {
      offerStyle: 'реальный оффер Deep',
      outboundText: [
        'Добрый день! Пишу, чтобы узнать, как сейчас справляетесь с потребностью в контейнерах под ваши маршруты.',
        'Мы в Deep можем закрыть вопрос с тарой практически в режиме реального времени и забираем на себя поиск свободной тары, простои платформ и комиссии посредникам.',
        'Наши цены ниже рыночных за счёт эксклюзивных контрактов, а контейнеры готовы к железнодорожным и морским отправкам. Давайте обсудим ближайшие рейсы и расчёты.',
      ].join('\n'),
    },
    {
      offerStyle: '«Хотим предложить сервис»',
      outboundText: [
        'Добрый день! Хотим предложить сервис для автоматизации обработки заявок и контроля работы распределённой команды.',
        'Сервис объединяет входящие обращения, сроки и ответственность сотрудников, чтобы руководитель видел узкие места и не терял заявки между филиалами.',
        'Подготовим демонстрацию на ваших сценариях и покажем ожидаемый эффект для команды. Удобно обсудить решение на этой неделе?',
      ].join('\n'),
    },
    {
      offerStyle: '«У нас есть решение»',
      outboundText: [
        'Добрый день! У нас есть решение для контроля технического обслуживания, ремонтов и запасов на нескольких объектах.',
        'Оно помогает собрать заявки в одной системе, видеть просроченные работы и заранее понимать риск простоя оборудования.',
        'Можем подготовить план запуска с учётом вашей структуры и показать экономический эффект. Удобно будет коротко обсудить ваши текущие процессы?',
      ].join('\n'),
    },
  ])('$offerStyle подтверждает оффер для ответа «Интересно»', async ({ outboundText }) => {
    expect(outboundText.length).toBeGreaterThanOrEqual(200);
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель оставила положительный интерес на проверке',
      needs_review: true,
    });

    const res = await qualifyInterestAfterOutbound(outboundText);

    expect(res.proposalSeen).toBe(true);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it('содержательный первый оффер сохраняет контекст после короткого follow-up', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель увидела только короткий follow-up',
      needs_review: true,
    });
    const followUp = {
      ...outboundProposal,
      id: 'out-follow-up',
      body: { text: 'Добрый день! Успели посмотреть предыдущее письмо?' },
      timestamp_email: '2026-07-13T08:30:00Z',
    } as Email;
    const reply = {
      ...callInviteReply,
      body: { text: 'Интересно.' },
    } as Email;
    const context: ThreadContext = {
      replyEmail: reply,
      threadEmails: [outboundProposal, followUp, reply],
      lastOutbound: followUp,
    };
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');

    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: context,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const requestBody = JSON.parse(String(init.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    const aiUserMessage = requestBody.messages.find((message) => message.role === 'user')?.content;
    expect(aiUserMessage).toContain('Предлагаем единую систему ТОиР');
    expect(aiUserMessage).toContain('Успели посмотреть предыдущее письмо?');
    expect(res.proposalSeen).toBe(true);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Мы обсудим с коллегами и сообщим Вам. Надеюсь на возможное сотрудничество.',
    'Если честно, надеюсь на возможное сотрудничество.',
  ])('самостоятельная надежда на сотрудничество становится лидом даже без восстановленного исходящего: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель оставила ответ на проверке',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('готовность к сотрудничеству');
  });

  it.each([
    'Пришлите материалы. Надеюсь на возможное сотрудничество.',
    'Надеюсь на возможное сотрудничество. Пришлите презентацию.',
    'Пришлите информацию, мы хотели бы сотрудничать.',
  ])('общая просьба о материалах не подавляет самостоятельную готовность сотрудничать: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только запрос материалов',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('готовность к сотрудничеству');
  });

  it('самостоятельная надежда на сотрудничество остаётся лидом, даже если модель ошибочно сняла проверку', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно не увидела прямой интерес',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Обсудим с коллегами. Надеюсь на возможное сотрудничество.',
        null,
      ),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('готовность к сотрудничеству');
  });

  it.each([
    'Я не надеюсь на возможное сотрудничество.',
    'Я не очень надеюсь на возможное сотрудничество.',
    'Мы вряд ли надеемся на сотрудничество.',
    'Надеюсь на сотрудничество, если это станет актуально.',
  ])('отрицательный или условный интерес не повышается до лида: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Получатель не выразил безусловный интерес',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Будем рады сотрудничеству в будущем.',
    'Хотели бы сотрудничать в будущем.',
    'Вернитесь через месяц.',
    'Напишите мне летом.',
    'Свяжитесь со мной позже.',
    'Сейчас не актуально, но напишите через месяц.',
    'Вернёмся к этому осенью.',
    'Я напишу вам позже.',
    'Давайте вернёмся к вопросу в сентябре.',
    'В будущем будем рады сотрудничеству.',
    'Через месяц напишите мне.',
    'Летом свяжитесь со мной.',
    'In two months contact me.',
  ])('собственный отложенный интерес или явный будущий CTA считается лидом: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно не повысила отложенный интерес',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it.each([
    'Если удобно, свяжитесь со мной через месяц.',
    'Свяжитесь со мной через месяц, если вам удобно.',
  ])('условие вежливости не отменяет прямой личный будущий CTA: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно приняла вежливость за условный интерес',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it.each([
    'Сейчас не интересно, но давайте обсудим через месяц.',
    'Не интересно сейчас, но свяжитесь со мной летом.',
    'Пока не интересно, но напишите через месяц.',
    'Сейчас это не интересно, но напишите через месяц.',
    'Нам сейчас это не интересно, но свяжитесь со мной летом.',
    'Сейчас нам не интересно, но напишите через месяц.',
    'Пока мне не интересно, но свяжитесь со мной летом.',
    'Not interested right now, but contact me next month.',
    'We are not interested now, contact us next month.',
  ])('временное «не интересно» не отменяет явный личный будущий CTA: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно приняла временный отказ за окончательный',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it('простое «не сейчас» без приглашения вернуться не повышается до лида', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: ['не сейчас'],
      reason: 'Получатель пока не готов продолжать',
      needs_review: false,
      objection_handleable: true,
    });
    const res = await qualifyQuotedProposalReply('Не сейчас.');

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
    expect(res.objectionHandleable).toBe(true);
  });

  it.each([
    'Нам не интересно. Напишите через месяц.',
    'Обратитесь к Ивану через месяц.',
    'Сейчас не актуально, но обратитесь к Ивану через месяц.',
    'Напишите коллегам через месяц.',
    'Call John next month.',
    'Через месяц обратитесь к Ивану.',
    'Я не напишу позже.',
    'Мы не свяжемся через месяц.',
    'Мы не вернёмся к этому летом.',
  ])('категоричный отказ или перенаправление к третьему лицу не становится отложенным лидом: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Нет собственного отложенного интереса получателя',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Нам не интересно. Пришлите материалы.',
    'Нам не интересно. Напишите через месяц.',
    'Если коллегам будет интересно, пришлите презентацию.',
    'Call John next month.',
  ])('дефолтные защитные правила снимают ошибочный AI lead: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель ошибочно увидела интерес'],
      reason: 'Ошибочный положительный вердикт модели',
      confidence: 0.92,
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('личная просьба вернуться позже остаётся отложенным лидом', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель пропустила личный отложенный CTA',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Обратитесь ко мне через месяц.', null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it('срок относится к ближайшему личному CTA, а не к более раннему перенаправлению', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только перенаправление',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Напишите коллегам, а со мной свяжитесь через месяц.',
        null,
      ),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it.each([
    'Обратитесь к ответственному сотруднику через месяц.',
    'Через месяц свяжитесь с нашим менеджером.',
    'Позвоните моему руководителю через месяц.',
    'Свяжитесь с нашим коммерческим директором через месяц.',
    'Позвоните финансовому директору через месяц.',
    'Свяжитесь с ответственным за закупки сотрудником через месяц.',
    'Свяжитесь с его менеджером через месяц.',
    'Свяжитесь с её менеджером через месяц.',
    'Свяжитесь со своим руководителем через месяц.',
    'Мы свяжемся с менеджером через месяц.',
    'Через месяц обсудим с коллегами.',
    'Contact our manager next month.',
    'Contact my manager next month.',
    'Follow up with our manager next month.',
  ])('будущий контакт с ролевым адресатом не становится собственным CTA: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель ошибочно увидела отложенный CTA'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('смешанный адресат с явным «мне» сохраняет личный будущий CTA', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только перенаправление коллегам',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Напишите коллегам и мне через месяц.',
        null,
      ),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it('общий будущий срок применяется и к следующему личному CTA', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только перенаправление коллегам',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Через месяц напишите коллегам и свяжитесь со мной.',
        null,
      ),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it.each([
    'Мне звонить не надо, позвоните менеджеру через месяц.',
    'Не надо мне звонить, позвоните менеджеру через месяц.',
  ])('отказ от личного контакта не делает лидом будущий контакт с менеджером: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель ошибочно увидела личный отложенный CTA'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('адресат перед вторым действием не теряется при привязке будущего срока', async () => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель ошибочно увидела личный отложенный CTA'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(
      'Напишите мне сейчас, с коллегами свяжитесь через месяц.',
    );

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('кириллическая граница не принимает «мне интересно» за отрицание', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель оставила ответ на проверке',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Мне интересно. Надеюсь на возможное сотрудничество.',
        null,
      ),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it('процитированный содержательный оффер подтверждает контекст для «Интересно», когда outbound не восстановился', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель не восстановила контекст цитаты',
      needs_review: true,
    });
    const quotedProposal = [
      'Интересно.',
      '',
      '> Добрый день! Предлагаем единую систему ТОиР для распределённых объектов.',
      '> Она помогает контролировать заявки, ремонты и запасы на всех площадках.',
      '> Подготовим план решения задач с учётом вашей структуры и покажем, как сократить простои.',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(quotedProposal, null),
    });

    expect(res.proposalSeen).toBe(true);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Мы не готовы. Надеемся на возможное сотрудничество.',
    'Сейчас не актуально. Надеемся на сотрудничество.',
    'Спасибо, нам это не интересно. Надеемся на возможное сотрудничество.',
    'Мы не заинтересованы. Надеемся на сотрудничество.',
    'Не планируем сотрудничать. Надеемся на сотрудничество.',
    'В случае интереса коллег они свяжутся. Надеемся на сотрудничество.',
    'We are not interested. We hope to collaborate.',
  ])('явный отказ имеет приоритет над вежливой фразой о сотрудничестве: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Получатель явно отказался',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Мы не видим возможности для сотрудничества. Надеемся на сотрудничество.',
    'Нам это не подходит. Надеемся на сотрудничество в будущем.',
  ])('явный отказ не повышается до лида, даже если модель оставила его на проверке: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель увидела противоречивые сигналы',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(false);
  });

  it('вежливая фраза не перебивает уверенный not_lead для неизвестной формулировки отказа', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Получатель отказался от текущего предложения',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Для нас это тупиковый вариант. Надеемся на сотрудничество в будущем.',
        null,
      ),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('«Не будем скрывать» не принимается за отказ и не отменяет готовность к сотрудничеству', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель оставила ответ на проверке',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Не будем скрывать: надеемся на возможное сотрудничество.',
        null,
      ),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    {
      replyText: 'Спасибо, но не интересно.',
      reason: 'Явный отрицательный ответ',
      needsReview: false,
    },
    {
      replyText: 'Возможно, коллегам будет интересно. Если заинтересуются, они свяжутся.',
      reason: 'Условный интерес третьих лиц',
      needsReview: true,
    },
    {
      replyText: 'Если коллегам будет интересно, напишите им летом.',
      reason: 'Условный интерес третьих лиц с будущим сроком',
      needsReview: true,
    },
  ])('отрицание и условный интерес третьих лиц не повышаются до лида: $replyText', async ({ replyText, reason, needsReview }) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason,
      needs_review: needsReview,
    });

    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(needsReview);
  });

  it('одиночное «Интересно» без восстановленного оффера остаётся на проверке даже при ошибочном proposal_seen от AI', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Без контекста нельзя подтвердить, к чему относится интерес',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Интересно.', null),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(true);
  });

  it('длинный запрос контакта не считается подтверждённым оффером только из-за длины', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'AI ошибочно принял длинное письмо за оффер',
      needs_review: true,
    });
    const verboseContactRequest = {
      ...outboundContactRequest,
      body: {
        text: [
          'Добрый день! Пишу, чтобы уточнить организационный вопрос и не беспокоить неподходящего сотрудника.',
          'Подскажите, пожалуйста, кто в вашей компании отвечает за закупки и входящие обращения от поставщиков?',
          'Буду признателен только за имя, рабочую почту или телефон ответственного коллеги. Само предложение направим ему отдельно.',
        ].join('\n'),
      },
    } as Email;
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Интересно.', verboseContactRequest),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(true);
  });

  it('кастомное определение не переопределяется новым дефолтным правилом интереса', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      custom_criteria_matched: false,
      interest_signals: [],
      reason: 'Положительный ответ не соответствует более узкому критерию проекта',
      needs_review: true,
    });

    const res = await qualifyQuotedProposalReply(
      'Интересно.',
      'Лидом считать только запрос цены или сметы.',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(true);
  });

  it('слово «интересно» только в цитате не повышает нейтральный основной ответ', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'В основном ответе нет положительного интереса',
      needs_review: false,
    });
    const quotedInterest = [
      'Спасибо, информацию получили.',
      '',
      'С уважением,',
      'Иванова Светлана',
      '',
      '18.08.2026 11:21, Dmitrij Kasilov пишет:',
      '> Интересно.',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(quotedInterest, outboundProposal),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('фраза о сотрудничестве только в Gmail-цитате без символа > не становится лидом', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'В основном ответе нет положительного интереса',
      needs_review: false,
    });
    const gmailQuoteWithoutMarkers = [
      'Спасибо, информацию получили.',
      '',
      'вт, 18 авг. 2026 г. в 11:21, Dmitrij Kasilov <sales@example.com>:',
      'Надеюсь на возможное сотрудничество.',
    ].join('\n');
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(gmailQuoteWithoutMarkers, outboundProposal),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('личный номер и имя в ответ на явный CTA из предложения становятся лидом', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Модель приняла номер за простую передачу контакта',
      needs_review: false,
    });
    const proposalWithPhoneCta = {
      ...outboundProposal,
      body: {
        text: [
          'Добрый день! Предлагаем решение для автоматизации продаж и обработки заявок.',
          'Покажу подходящие сценарии и материалы в мессенджере.',
          'Решение сокращает ручную работу команды и помогает быстрее отвечать новым клиентам.',
          'Подскажите ваш номер? Скину материалы в мессенджер.',
        ].join('\n'),
      },
    } as Email;
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Мой номер 89997588928, Влада', proposalWithPhoneCta),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('выполнен CTA — передан личный номер');
  });

  it.each([
    '+79991234567',
    '89991234567',
  ])('только номер в ответ на явный CTA из предложения тоже становится лидом: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Модель приняла номер за нейтральный контакт',
      needs_review: false,
    });
    const proposalWithPhoneCta = {
      ...outboundProposal,
      body: {
        text: [
          'Добрый день! Предлагаем решение для автоматизации продаж и обработки заявок.',
          'Покажу подходящие сценарии и материалы в мессенджере.',
          'Решение сокращает ручную работу команды и помогает быстрее отвечать новым клиентам.',
          'Подскажите ваш номер? Скину материалы в мессенджер.',
        ].join('\n'),
      },
    } as Email;
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, proposalWithPhoneCta),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Ответственный Иван Петров, ivan@example.com.',
    'За закупки отвечает Иван Куприянов, ivan@example.com.',
    'По оценке лицензий обращайтесь к Ивану: ivan@example.com.',
    'Офис на Набережной, ответственный Иван: ivan@example.com.',
    'Не звоните мне, обратитесь к Ивану: ivan@example.com.',
    'ivan@example.com',
    'Иван, +7 999 123-45-67',
    '@ivan_petrov',
    'Иван Петров',
    'Иван Петров, директор по закупкам',
    'Иван, телефон 123-45-67',
    'ИВАН ПЕТРОВ',
    'John Smith, Procurement Director',
    'The right person is John Smith',
    'Talk to John Smith',
    'За КП отвечает Иван',
    'Позвоните мне по любым вопросам.',
    'Feel free to contact me if you have any questions.',
  ])('просто переданный контакт после contact-only opener по-прежнему не вызывает ИИ: %s', async (replyText) => {
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText),
    });

    expect(res.isLead).toBe(false);
    expect(res.reason).toContain('запрос контакта');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    'Пришлите предложение.',
    'Пришлите информацию.',
    'Пришлите материалы.',
    'Пришлите презентацию.',
    'Я ответственный. Пришлите материалы.',
  ])('общий ознакомительный запрос доходит до семантической проверки, но остаётся не лидом: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      interest_signals: [],
      reason: 'Запрошены только ознакомительные материалы',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('защита общего запроса материалов без оффера снимает ошибочный AI lead', async () => {
    mockAiResult({
      is_lead: true,
      proposal_seen: false,
      interest_signals: ['модель ошибочно увидела коммерческий интерес'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Пришлите материалы.', null),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Пришлите материалы, давайте созвонимся.',
    'Давайте завтра проведём встречу и пришлите презентацию.',
    'Пришлите информацию и запустим тест.',
    'Send the presentation and let us schedule a call.',
  ])('общая просьба о материалах не подавляет отдельный прямой CTA: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только запрос материалов',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Давайте не созвонимся.',
    'Вы не можете связаться со мной.',
    'Сейчас вы не можете мне позвонить.',
    'Не начнём пилот.',
    'We cannot schedule a call.',
    "We can't schedule a call.",
    'We cannot have a meeting.',
    'Let us not schedule a call.',
  ])('отрицание прямого CTA не превращается в лид: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель пропустила отрицание CTA'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Пришлите предложение.',
    'Пришлите информацию о компании.',
    'Пришлите материалы.',
    'Пришлите презентацию.',
    'Пришлите материалы, возможно, когда-нибудь посмотрим.',
  ])('запрос дополнительных материалов после подтверждённого оффера считается лидом: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Модель ошибочно сочла запрос общим любопытством',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(true);
    expect(res.proposalSeen).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('запрошены дополнительные материалы по предложению');
  });

  it.each([
    'Нам не интересно. Пришлите материалы.',
    'Сейчас не актуально. Пришлите материалы.',
    'Не сейчас. Пришлите презентацию.',
    'Если коллегам будет интересно, пришлите презентацию.',
  ])('отказ или условный интерес не превращается в лид из-за просьбы о материалах: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Просьба о материалах не отменяет отрицательный сигнал',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('неопределённый будущий интерес после подтверждённого оффера считается лидом', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Модель посчитала будущий интерес слишком слабым',
      needs_review: true,
    });
    const res = await qualifyQuotedProposalReply('Возможно, когда-нибудь посмотрим.');

    expect(res.isLead).toBe(true);
    expect(res.proposalSeen).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it('неопределённое «когда-нибудь посмотрим» без подтверждённого оффера остаётся на проверке', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: ['неопределённый будущий интерес'],
      reason: 'Без оффера смысл ответа неоднозначен',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Возможно, когда-нибудь посмотрим.', null),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(true);
  });

  it('неопределённый будущий интерес без оффера остаётся на проверке даже при ошибочном AI lead', async () => {
    mockAiResult({
      is_lead: true,
      proposal_seen: false,
      interest_signals: ['модель переоценила неопределённый интерес'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Возможно, когда-нибудь посмотрим.', null),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(true);
  });

  it.each([
    'Возможно, когда-нибудь посмотрим. Спасибо.',
    'Когда-нибудь посмотрим ваше предложение.',
  ])('неопределённый будущий интерес с обычным хвостом без оффера остаётся на проверке: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      proposal_seen: false,
      interest_signals: ['модель переоценила неопределённый интерес'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(true);
  });

  it('отрицательная просьба не становится лидом из-за слова «материалы»', async () => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель ошибочно увидела запрос материалов'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply('Не присылайте материалы.');

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Не присылайте материалы. Нам интересно.',
    'Не присылайте презентацию, но ваше предложение интересно.',
  ])('отказ от материала не отменяет прямой интерес к подтверждённому предложению: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Модель ошибочно остановилась на отказе от материала',
      needs_review: true,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('положительный интерес к предложению');
  });

  it('отрицание относится к тому же коммерческому запросу и не превращается в лид', async () => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель пропустила отрицание'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(
      "Please don't send a commercial proposal.",
    );

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('отрицательное «не присылайте КП» снимает ошибочный AI lead', async () => {
    mockAiResult({
      is_lead: true,
      proposal_seen: true,
      interest_signals: ['модель пропустила отрицание'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply('Не присылайте КП.');

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('собственный отложенный CTA сильнее сопровождающей просьбы о материалах', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только временный отказ',
      needs_review: true,
    });
    const res = await qualifyQuotedProposalReply(
      'Сейчас не актуально, но напишите через месяц и пришлите материалы.',
    );

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('отложенный интерес');
  });

  it('прямой запрос коммерческого предложения сильнее временного отказа и не требует оффера в треде', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только временный отказ',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(
        'Сейчас не готов созваниваться, но пришлите коммерческое предложение.',
        null,
      ),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Пришлите предложение с ценами.',
    'Пришлите информацию о стоимости.',
    'Пришлите материалы и тарифы.',
    'Send materials with pricing.',
  ])('запрос цены остаётся коммерческим даже вместе с общими материалами: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только ознакомительные материалы',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('прямой коммерческий запрос');
  });

  it.each([
    'Пришлите информацию. Сколько стоит?',
    'Пришлите материалы. Какие у вас тарифы?',
    'Пришлите презентацию, выставляйте счёт.',
    'Пришлите материалы, готовы купить.',
  ])('общие материалы не подавляют отдельный коммерческий или покупательский сигнал: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно увидела только ознакомительные материалы',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('прямой коммерческий запрос');
  });

  it.each([
    'Пришлите материалы без цен.',
    'Send materials without pricing.',
    'Пришлите материалы, но не указывайте цены.',
    'Пришлите материалы без указания стоимости.',
    'Пришлите материалы, стоимость можно не указывать.',
    'Send materials, but do not include pricing.',
    'Do not, please, send a quote.',
  ])('исключённая из материалов цена и отрицательный запрос КП не являются коммерческим интересом: %s', async (replyText) => {
    mockAiResult({
      is_lead: true,
      proposal_seen: false,
      interest_signals: ['модель ошибочно увидела коммерческий запрос'],
      reason: 'Ошибочный положительный вердикт модели',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Пришлите информацию о ценностях компании.',
    'Пришлите реквизиты расчётного счёта.',
    'Send information about your corporate structure.',
  ])('слова, похожие на цену или расчёт, не создают коммерческий запрос: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'В ответе нет коммерческого запроса',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(false);
  });

  it.each([
    'Не присылайте презентацию, пришлите КП.',
    'Не отправляйте материалы, подготовьте коммерческое предложение.',
  ])('отказ от одного материала не отменяет последующий прямой коммерческий запрос: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель ошибочно остановилась на отрицании',
      needs_review: true,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(replyText, null),
    });

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('прямой коммерческий запрос');
  });

  it.each([
    'Не присылайте презентацию, пришлите материалы.',
    "Don't send a presentation, send materials.",
  ])('отказ от одного материала не отменяет позитивную просьбу о другом после оффера: %s', async (replyText) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Модель ошибочно остановилась на отрицании',
      needs_review: true,
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.interestSignals).toContain('запрошены дополнительные материалы по предложению');
  });

  it('Информатика: перенаправление в общую приёмную не становится лидом из-за процитированного предложения', async () => {
    mockAiResult();
    const res = await qualifyQuotedProposalReply(
      'Добрый день, обращайтесь, пож-та, в приемную.\n+7 (3522) 234161 <tel:+73522234161>',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.isLead).toBe(false);
    expect(res.proposalSeen).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.reason).toContain('общий контакт');
  });

  it.each([
    'По этому вопросу обратитесь в приёмную.\n+7 (3522) 234161',
    'Просьба обращаться в приёмную.\n+7 (3522) 234161',
    'Свяжитесь с отделом закупок.\n+7 (3522) 234161',
    'Обращайтесь в приёмную по телефону +7 (3522) 234161',
    'Обращайтесь в приёмную.\nС уважением, Светлана Иванова',
    'Свяжитесь с приёмной.',
    'Просим обратиться в приёмную.',
    'Обратитесь к нашему отделу.',
    'Обратитесь в отдел информационных технологий.',
    'Свяжитесь с отделом по работе с клиентами.',
  ])('распознаёт безопасные варианты перенаправления на общий контакт: %s', async (authoredReply) => {
    mockAiResult();
    const res = await qualifyQuotedProposalReply(authoredReply);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Позвоните в отдел закупок летом.',
    'Обратитесь в приёмную через месяц.',
    'Не пишите нам позже.',
  ])('общий или отрицательный будущий контакт не становится отложенным лидом: %s', async (authoredReply) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Нет собственного отложенного интереса получателя',
      needs_review: false,
    });
    const res = await qualifyQuotedProposalReply(authoredReply);

    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('личная просьба позвонить и обсудить остаётся лидом даже с подписью и цитатой', async () => {
    mockAiResult({
      proposal_seen: true,
      interest_signals: ['просьба позвонить и обсудить внедрение'],
    });
    const res = await qualifyQuotedProposalReply(
      'Позвоните мне завтра, обсудим внедрение.\n+7 (3522) 234161',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it.each([
    'Обратитесь в отдел закупок пришлите КП.',
    'Обратитесь в отдел продаж обсудить внедрение.',
    'Позвоните в отдел закупок стоимость интересует.',
    'Напишите в отдел КП.',
    'Напишите в отдел цену.',
    'Позвоните в отдел обсудим.',
    'Напишите в отдел заявку.',
    'Напишите в отдел реквизиты.',
    'Напишите в отдел счёт.',
    'Позвоните в отдел согласуем.',
    'Звоните в отдел покажем.',
    'Напишите в отдел образец.',
    'Позвоните в отдел оплатим.',
  ])('упоминание отдела не скрывает отдельный коммерческий сигнал: %s', async (replyText) => {
    mockAiResult({
      proposal_seen: true,
      interest_signals: ['конкретный коммерческий сигнал'],
    });
    const res = await qualifyQuotedProposalReply(replyText);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it('совпавший кастомный критерий может считать перенаправление в приёмную лидом', async () => {
    mockAiResult({
      is_lead: false,
      needs_review: true,
      custom_criteria_matched: true,
      interest_signals: ['передан общий номер приёмной'],
    });
    const res = await qualifyQuotedProposalReply(
      'Обращайтесь, пожалуйста, в приёмную.\n+7 (3522) 234161',
      'Обращение в приёмную или по переданному общему номеру = лид.',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.customCriteriaMatched).toBe(true);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
  });

  it('нерелевантный кастомный критерий не отключает защиту от перенаправления на общий контакт', async () => {
    mockAiResult({
      is_lead: true,
      needs_review: false,
      custom_criteria_matched: false,
      interest_signals: ['модель ошибочно приняла приёмную за следующий шаг'],
    });
    const res = await qualifyQuotedProposalReply(
      'Обращайтесь, пожалуйста, в приёмную.\n+7 (3522) 234161',
      'Запрос цены или сметы = лид.',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
    expect(res.reason).toContain('общий контакт');
  });

  it('АДК Транс: явная передача email в основном ответе побеждает ошибочный not_lead модели', async () => {
    const res = await qualifyEmailCriterionReply(camozziEmailRoutingReply, {
      aiOverrides: {
        proposal_seen: false,
        reason: 'Перенаправление на общий почтовый ящик без собственного интереса.',
        confidence: 0.95,
        objection_handleable: true,
        objection_draft: 'Лишний черновик возражения.',
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.customCriteriaMatched).toBe(true);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.objectionHandleable).toBe(false);
    expect(res.objectionDraft).toBeNull();
    expect(res.interestSignals).toContain('передан email по кастомному критерию проекта');
  });

  it.each([
    {
      title: 'email находится только в подписи',
      replyText: 'Спасибо за письмо.\n\nС уважением,\nМария Иванова\nmaria.ivanova@camozzi.ru',
    },
    {
      title: 'email находится только в процитированной истории',
      replyText: 'Спасибо за письмо.\n\n18.08.2026 11:21, Никита пишет:\n> Напишите на info@camozzi.ru',
    },
    {
      title: 'email находится только в перенаправленном сообщении',
      replyText: 'Спасибо за письмо.\n\nПеренаправленное сообщение\nFrom: colleague@camozzi.ru\nПишите на info@camozzi.ru',
    },
    {
      title: 'email находится в подписи без формального разделителя',
      replyText: 'Спасибо за письмо.\n\nМария Иванова\nМенеджер отдела продаж\nmaria.ivanova@camozzi.ru',
    },
    {
      title: 'слово contact находится только внутри email подписи',
      replyText: 'Спасибо за письмо.\n\nМария Иванова\nМенеджер отдела продаж\ncontact@camozzi.ru',
    },
    {
      title: 'Freight Forwarder является должностью, а не командой переслать',
      replyText: 'Спасибо за письмо.\n\nJohn Smith\nFreight Forwarder\njohn@camozzi.ru',
    },
    {
      title: 'email находится в юридическом футере',
      replyText: 'Спасибо за письмо.\n\nООО «Камоцци»\nЮридический адрес: Санкт-Петербург\nE-mail: info@camozzi.ru',
    },
    {
      title: 'email находится после английской границы пересылки',
      replyText: 'Спасибо за письмо.\n\n----- Forwarded message -----\nПишите на info@camozzi.ru',
    },
    {
      title: 'email находится после Begin forwarded message',
      replyText: 'Спасибо за письмо.\n\nBegin forwarded message:\nПишите на info@camozzi.ru',
    },
  ])('email-критерий не использует служебный текст: $title', async ({ replyText }) => {
    const res = await qualifyEmailCriterionReply(replyText, {
      aiOverrides: { reason: 'В основном ответе email не передан.' },
    });

    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
  });

  it.each([
    'Лидом считать только запрос цены или сметы.',
    'Не считать лидом, если поделились общей почтой.',
    'Считать лидом, если дали имя и почту.',
    'Считать лидом, если поделились именем и почтой.',
    'Считать лидом, если поделились почтой и телефоном.',
    'Считать лидом, если поделились только корпоративной почтой.',
    'Считать лидом, если поделились почтой. Общую почту лидом не считать.',
    'Считать лидом, если поделились почтой. Кроме общей почты.',
    'Считать лидом, если поделились почтой. Только личная почта.',
  ])('не расширяет более узкий или отрицательный кастомный критерий: %s', async (leadCriteria) => {
    const res = await qualifyEmailCriterionReply(camozziEmailRoutingReply, {
      leadCriteria,
      aiOverrides: { reason: 'Кастомный критерий не совпал.' },
    });

    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
  });

  it('запрет писать на упомянутый email не считается передачей контакта', async () => {
    const res = await qualifyEmailCriterionReply(
      'Не пишите на info@camozzi.ru, этот адрес не используется.',
      {
        aiOverrides: { reason: 'Получатель запретил использовать упомянутый адрес.' },
      },
    );

    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
  });

  it.each([
    'Спасибо за обращение. Ваш запрос зарегистрирован. По вопросам напишите support@camozzi.ru.',
    'Благодарим за обращение. Ваш запрос успешно зарегистрирован. По вопросам писать на support@camozzi.ru.',
    'Thank you for contacting us. Your request has been received. For additional questions, write to support@camozzi.com.',
    'Напишите подробнее. E-mail: info@camozzi.ru',
    'Напишите подробнее, E-mail: info@camozzi.ru',
    'Напишите ваш номер\nE-mail: info@camozzi.ru',
    'Напишите имена\nE-mail: info@camozzi.ru',
    'Send the photo\nE-mail: info@camozzi.com',
    'Писать на info@camozzi.ru не нужно.',
    'Пишите на info@camozzi.ru нельзя.',
    'Write to info@camozzi.com is not allowed.',
    'Вы не можете писать на info@camozzi.ru.',
    'Не рекомендуем писать на info@camozzi.ru.',
    'You are not allowed to write to info@camozzi.com.',
    'Не нужно пока писать на info@camozzi.ru.',
    'Писать на info@camozzi.ru запрещено.',
    'Мы получили ваше письмо. По вопросам писать на support@camozzi.ru.',
    'We have received your email. For questions write to support@camozzi.com.',
    'Ваше обращение было зарегистрировано. По вопросам пишите на support@camozzi.ru.',
    'Your request was received. For questions write to support@camozzi.com.',
  ])('шаблонный или не связанный с email призыв не даёт детерминированный lead: %s', async (replyText) => {
    const res = await qualifyEmailCriterionReply(replyText, {
      aiOverrides: { reason: 'Email не является сознательно переданным контактом.' },
    });

    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
  });

  it.each([
    'info@camozzi.ru',
    'Добрый день! Напишите на sales@camozzi.ru.',
    'Можно писать на logistics@camozzi.ru.',
    'Можете написать на logistics@camozzi.ru.',
    'Не я отвечаю за логистику, напишите на info@camozzi.ru.',
    'Не знаю, попробуйте написать на info@camozzi.ru.',
    'Спасибо за письмо. По этому вопросу напишите на ivan@camozzi.ru.',
    'Thank you for your email. Please write to Jane at jane@camozzi.com.',
    'Напишите по e-mail: info@camozzi.ru.',
    'Напишите на эту почту: info@camozzi.ru.',
  ])('однозначно переданный email удовлетворяет атомарному критерию: %s', async (replyText) => {
    const res = await qualifyEmailCriterionReply(replyText);

    expect(res.customCriteriaMatched).toBe(true);
    expect(res.isLead).toBe(true);
  });

  it('email в автоответе не становится лидом по кастомному критерию', async () => {
    const res = await qualifyEmailCriterionReply(
      'Автоматический ответ: данный почтовый ящик больше не обслуживается. Пишите на info@camozzi.ru.',
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
  });

  it('без email-критерия перенаправление на общий адрес не получает детерминированный lead', async () => {
    mockAiResult({
      is_lead: false,
      custom_criteria_matched: false,
      interest_signals: [],
      reason: 'Перенаправление на общий почтовый ящик без собственного интереса.',
      needs_review: false,
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply(camozziEmailRoutingReply),
    });

    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
  });

  it('прямой CTA без восстановленного исходящего письма доходит до ИИ и остаётся лидом', async () => {
    mockAiResult();
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      prefetchedContext: contextWithReply('Да, давайте созвонимся завтра.', null),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toContain('(не найдено)');
    expect(body.messages[1].content).toContain('давайте созвонимся завтра');
    expect(body.messages[0].content).toContain('НЕ является обязательным');
    expect(res.isLead).toBe(true);
  });

  it('с кастомными критериями ранний выход отключён, промпт содержит приоритетный блок, вердикт ИИ проходит', async () => {
    mockAiResult({
      interest_signals: ['предложил созвониться'],
      reason: 'Просит звонок в конкретное окно',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Контакт ЛПР или предложение созвониться = лид. Развёрнутое предложение не требуется.',
      prefetchedContext: contextWithReply('Ответственный Иван Петров, ivan@example.com.'),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    const systemPrompt: string = body.messages[0].content;
    expect(systemPrompt).toContain('ОПРЕДЕЛЕНИЕ ЛИДА ДЛЯ ЭТОГО ПРОЕКТА');
    expect(systemPrompt).toContain('Контакт ЛПР или предложение созвониться = лид.');
    expect(res.isLead).toBe(true);
  });

  it.each([
    {
      replyText: '8 953 909 6065 Мария',
      ai: {
        is_lead: false,
        needs_review: true,
        custom_criteria_matched: true,
        interest_signals: ['переданы имя и телефон'],
        reason: 'Ответ соответствует дополнительному критерию проекта.',
        objection_handleable: true,
        objection_draft: 'Лишний черновик, который должен быть очищен.',
      },
    },
    {
      replyText: 'Добрый день! Узнайте по тел. 477-921',
      ai: {
        is_lead: true,
        needs_review: true,
        custom_criteria_matched: true,
        interest_signals: ['попросили связаться по переданному телефону'],
        reason: 'Ответ соответствует дополнительному критерию проекта.',
      },
    },
  ])('сработавший кастомный критерий жёстко даёт lead без needs_review: $replyText', async ({ replyText, ai }) => {
    mockAiResult(ai);
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Имя и телефон либо просьба связаться по переданному номеру = лид.',
      prefetchedContext: contextWithReply(replyText),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.messages[1].content).toContain(
      'для custom_criteria_matched учитывай только основной нецитированный ответ человека',
    );
    expect(res.customCriteriaMatched).toBe(true);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(false);
    expect(res.objectionHandleable).toBe(false);
    expect(res.objectionDraft).toBeNull();
  });

  it('не повышает конфликтный вердикт до лида, когда модель явно не нашла совпадение с кастомным критерием', async () => {
    mockAiResult({
      is_lead: true,
      needs_review: true,
      custom_criteria_matched: false,
      interest_signals: ['попросили связаться по переданному телефону'],
      reason: 'Нужно проверить вручную; кастомный критерий не совпал.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Просьба связаться по переданному номеру = лид.',
      prefetchedContext: contextWithReply('Добрый день! Узнайте по тел. 477-921'),
    });

    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(true);
    expect(res.needsReview).toBe(true);
  });

  it('контакты только в автоответе не становятся лидом даже при кастомном критерии', async () => {
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Имя и телефон = лид.',
      prefetchedContext: contextWithReply(
        'Автоматический ответ: я в отпуске до 20 августа. Мария, +7 999 123-45-67.',
      ),
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });

  it('имя и телефон только в подписи не считаются совпадением с кастомным критерием', async () => {
    mockAiResult({
      is_lead: false,
      needs_review: false,
      custom_criteria_matched: false,
      interest_signals: [],
      reason: 'Контакты находятся только в подписи.',
    });
    const { qualifyReply } = await import('@/lib/instantly/leadQualifier');
    const res = await qualifyReply('camp-1', 'lead@x.ru', 'thread-1', {
      apiKey: 'test-key',
      briefText: '',
      leadCriteria: 'Имя и телефон = лид.',
      prefetchedContext: contextWithReply(
        'С уважением,\nМария Иванова\nМенеджер отдела продаж\n+7 999 123-45-67',
      ),
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.customCriteriaMatched).toBe(false);
    expect(res.isLead).toBe(false);
    expect(res.needsReview).toBe(false);
  });
});
