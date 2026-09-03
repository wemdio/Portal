/**
 * @jest-environment node
 *
 * Focused policy regressions from the September 2026 Instantly lead audit.
 * These cases cover production false positives/negatives at the qualification
 * boundary without restoring the former broad leadQualifier test suite.
 */

import { runInNewContext } from 'node:vm';
import type { Email } from '@/lib/instantly/types';
import {
  classifyMachineReply,
  qualifyReply,
  type ThreadContext,
} from '@/lib/instantly/leadQualifier';

jest.mock('@/lib/supabaseInstantly', () => ({
  supabaseInstantly: null,
}));

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: null,
}));

jest.mock('@/lib/instantly/client', () => ({
  __esModule: true,
  listEmails: jest.fn(),
}));

const CONTACT_ONLY_OUTBOUND_TEXT =
  'Подскажите, пожалуйста, кто у вас отвечает за развитие продаж? Буду признательна за контакт.';

const INFORMATIKA_OUTBOUND_TEXT =
  'Добрый день! Хочу направить короткую информацию о нашем решении. Подскажите, пожалуйста, ответственного или контакт.';

const SUBSTANTIVE_OUTBOUND_TEXT = [
  'Добрый день!',
  'Предлагаем единую систему для автоматизации продаж и обработки входящих заявок.',
  'Решение помогает команде быстрее отвечать новым клиентам, контролировать этапы работы и сокращать ручные операции.',
  'Готовы показать сценарий внедрения под ваши процессы и обсудить подходящий следующий шаг.',
].join('\n');

const SUBSTANTIVE_PHONE_CTA_OUTBOUND_TEXT = [
  SUBSTANTIVE_OUTBOUND_TEXT,
  'Подскажите, пожалуйста, ваш номер телефона — свяжемся и покажем подходящий сценарий.',
].join('\n');

const HOCO_BODY = [
  'Благодарим Вас за обращение!',
  'Мы получили Ваше письмо и хотим подтвердить его получение.',
  'Наши специалисты уже занимаются рассмотрением вашего запроса и постараются ответить в ближайшее время.',
  'Если срочно, свяжитесь: Telegram @hoco4345, WhatsApp +7 903 434-34-35.',
  'Спасибо за терпение!',
].join(' ');

const ELTEX_BODY = [
  'Спасибо за Вашу заявку на оборудование ELTEX!',
  'Ваш персональный менеджер Артём Трифонов свяжется с Вами в ближайшее время.',
  'Также Вы можете связаться с ним по телефону +7 (383) 274-10-01.',
].join(' ');

const GRACIE_BODY = 'Добрый день! Мы обязательно ответим вам в ближайшее время! Если ваш запрос актуален и требует ответа, то свяжитесь с нами по телефону: +79824500811 или Telegram: @gr_web';

const TOBYLAB_OUTBOUND_TEXT = [
  'Hi,',
  'If TobyLab is looking to create more qualified sales opportunities, Polza can quickly test relevant segments and find leads there.',
  "We'll bring you 3 sales-qualified leads, or continue working for free until we do.",
  'Am I in the right inbox for growth or outbound?',
  'Julia Mirinova',
  'Account Manager',
  'Polza Agency',
  'P.S. If Anna Kon owns growth or outbound, could you forward this to them?',
].join('\n\n');

const TOBYLAB_REPLY_TEXT = [
  'Hi Julia!',
  'We are 2 co-founders Anna and Svetlana. We are looking for sales opportunities, could you please',
  'send a intro presentation about your services?',
  '',
  'Svetlana',
  '',
  'вт, 1 сент. 2026 г. в 11:24, Julia Mirinova <sales@example.com>:',
  ...TOBYLAB_OUTBOUND_TEXT.split('\n').map((line) => `> ${line}`),
].join('\n');

const FORMAL_MAILBOX_CHANGE_BODY = [
  'ООО Ромашка обновило свой основной электронный почтовый адрес.',
  'Все официальные письма необходимо направлять на новый адрес info@new.example.',
  'Старый электронный адрес переадресовал ваше сообщение.',
  'Вы можете направить письмо на новый адрес.',
].join(' ');

const MACHINE_ACK_FIXTURES = [
  {
    name: 'Gracie receiptless response promise with a conditional contact',
    email: {
      from_address_email: 'info@gracie.example',
      subject: 'Re: Re:',
      body: { text: GRACIE_BODY },
      content_preview: GRACIE_BODY,
    },
  },
  {
    name: 'HOCO generic service acknowledgement',
    email: {
      from_address_email: 'info@hoco.example',
      subject: 'Auto-reply: Re: Запрос по сотрудничеству',
      body: { text: HOCO_BODY },
      content_preview: HOCO_BODY,
    },
  },
  {
    name: 'ELTEX equipment application acknowledgement',
    email: {
      from_address_email: 'info@eltex.example',
      subject: 'Уведомление о получении заявки',
      body: { text: ELTEX_BODY },
      content_preview: ELTEX_BODY,
    },
  },
] as const;

const OUTREACH_OS_CRITERIA = [
  'Это холодный B2B-аутрич инструмента для рассылок.',
  'Считай ЛИДОМ, когда ответственный отвечает САМ: если человек В ТЕКСТЕ письма представляется тем, кто занимается продажами, привлечением клиентов, маркетингом или развитием (например, «я занимаюсь...», «это ко мне»).',
  'НЕ лид:',
  '- просто передача контакта — своего или чужого — без выраженного интереса: «можете написать сюда», «напишите на почту X», «вот контакт Ивана», «направьте на info@…» — это маршрутизация, а не интерес.',
].join('\n');

const ADK_CRITERIA = [
  'Дополнительно считать лидом, если дали номер телефона и Имя, предложили созвониться или попросили связаться.',
  'Оставили какой-то мессенджер для связи и попросили связаться в нем.',
  'Также считать лидом если поделились кодом в АТИ (ati.su).',
  'Также считать лидом, если поделились почтой.',
  'Также считать лидом, если попросили сделать расчет заявки, рассчитать стоимость перевозки.',
].join(' ');

const CONTACT_CRITERIA_CASES = [
  { name: 'default', leadCriteria: undefined },
  { name: 'custom contact criterion', leadCriteria: ADK_CRITERIA },
];

function email(overrides: Partial<Email>): Email {
  return {
    id: 'email-1',
    campaign_id: 'campaign-1',
    from_address_email: 'lead@example.com',
    to_address_email_list: 'sales@example.com',
    thread_id: 'thread-1',
    ue_type: 2,
    subject: 'Re: outreach',
    body: { text: 'Ответ' },
    timestamp_email: '2026-09-01T12:00:00Z',
    ...overrides,
  };
}

function contextWithReply(
  replyText: string,
  outboundText: string | null = CONTACT_ONLY_OUTBOUND_TEXT,
): ThreadContext {
  const reply = email({
    id: 'reply-1',
    body: { text: replyText },
    timestamp_email: '2026-09-01T12:00:00Z',
  });
  const outbound = outboundText === null
    ? null
    : email({
        id: 'outbound-1',
        ue_type: 1,
        from_address_email: 'sales@example.com',
        to_address_email_list: 'lead@example.com',
        body: { text: outboundText },
        timestamp_email: '2026-09-01T11:00:00Z',
      });

  return {
    replyEmail: reply,
    threadEmails: outbound ? [outbound, reply] : [reply],
    lastOutbound: outbound,
  };
}

const originalFetch = global.fetch;
const fetchMock = jest.fn();

function mockAiResult(overrides: Record<string, unknown> = {}) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{
        finish_reason: 'stop',
        message: {
          content: JSON.stringify({
            is_lead: true,
            custom_criteria_matched: false,
            proposal_seen: false,
            interest_signals: ['модель увидела интерес'],
            reason: 'Модель квалифицировала ответ как лид.',
            confidence: 0.8,
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

async function qualify(
  replyText: string,
  options: {
    outboundText?: string | null;
    leadCriteria?: string;
  } = {},
) {
  return qualifyReply('campaign-1', 'lead@example.com', 'thread-1', {
    apiKey: 'test-key',
    maxRetries: 0,
    briefText: '',
    leadCriteria: options.leadCriteria,
    prefetchedContext: contextWithReply(
      replyText,
      options.outboundText === undefined
        ? CONTACT_ONLY_OUTBOUND_TEXT
        : options.outboundText,
    ),
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
  mockAiResult();
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('machine acknowledgement policy', () => {
  it('leaves an unrecognized long contact plus a human request to AI without blocking the worker', () => {
    const fixture = email({
      body: { text: `Добрый день! Мы обязательно ответим вам в ближайшее время! Если ваш запрос актуален и требует ответа, то свяжитесь с нами по телефону: ${'9'.repeat(150)} пришлите КП` },
    });
    // A VM deadline bounds the regression even if a future regexp backtracks.
    expect(runInNewContext('classify(email)', {
      classify: classifyMachineReply, email: fixture,
    }, { timeout: 200 })).toBeNull();
  });

  it.each(MACHINE_ACK_FIXTURES)('recognizes $name', ({ email: fixture }) => {
    expect(classifyMachineReply(fixture)).toBe('service_acknowledgement');
  });

  it.each(MACHINE_ACK_FIXTURES)(
    'does not hide a commercial request appended to $name',
    ({ email: fixture }) => {
      expect(classifyMachineReply({
        ...fixture,
        body: {
          text: `${fixture.body.text}\n\nОтдельно по вашему предложению: пришлите КП с ценами.`,
        },
      })).toBeNull();
    },
  );

  it.each(MACHINE_ACK_FIXTURES)(
    'does not consume an inline commercial request inside $name',
    ({ email: fixture }) => {
      const inlineBody = fixture.body.text.replace(/[.!?]\s*$/u, '');
      expect(classifyMachineReply({
        ...fixture,
        body: {
          text: `${inlineBody}; отдельно пришлите КП с ценами.`,
        },
      })).toBeNull();
    },
  );

  it('keeps a formal mailbox-change routing instruction classified as an auto-reply', () => {
    expect(classifyMachineReply({
      from_address_email: 'old@example.ru',
      subject: 'Уведомление о смене электронного адреса',
      body: { text: FORMAL_MAILBOX_CHANGE_BODY },
      content_preview: FORMAL_MAILBOX_CHANGE_BODY,
    })).toBe('auto_reply');
  });

  it.each(CONTACT_CRITERIA_CASES)(
    'does not call AI for a receiptless acknowledgement with $name',
    async ({ leadCriteria }) => {
      const ctx = contextWithReply(GRACIE_BODY);
      ctx.replyEmail.body = { html: `<div>${GRACIE_BODY}</div>` };
      const result = await qualifyReply('campaign-1', 'lead@example.com', 'thread-1', {
        apiKey: 'test-key', maxRetries: 0, briefText: '', leadCriteria, prefetchedContext: ctx,
      });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        isLead: false, customCriteriaMatched: false, needsReview: false,
        interestSignals: [], objectionHandleable: false, objectionDraft: null,
      });
    },
  );

  it.each(CONTACT_CRITERIA_CASES)(
    'respects an AI machine verdict before lead promotion with $name',
    async ({ leadCriteria }) => {
      mockAiResult({
        machine_reply_kind: 'service_acknowledgement',
        is_lead: true, custom_criteria_matched: true,
        objection_handleable: true, objection_draft: 'Не отправлять',
      });
      // An unfamiliar service template is intentionally left for the AI layer.
      const result = await qualify('Обработка продолжается. Свяжитесь с нами по адресу service@example.com.', {
        leadCriteria,
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        isLead: false, customCriteriaMatched: false, needsReview: false,
        proposalSeen: false, interestSignals: [], objectionHandleable: false, objectionDraft: null,
      });
    },
  );

  it('ignores absent or unrecognized AI machine values for a human call request', async () => {
    for (const machineReplyKind of [undefined, null, false, true, 'false', 'unknown']) {
      mockAiResult({ is_lead: false, machine_reply_kind: machineReplyKind });
      const result = await qualify('Можете связаться со мной завтра.');
      expect(result).toMatchObject({ isLead: true, machineReplyKind: null });
    }
  });
});

describe('plain contact routing policy', () => {
  it.each([
    'Здравствуйте! запишите мой тел 89104886003 Алан',
    'Можете связаться с Артёмом. 89250310331',
    'можете связаться с Таисией в телеграмме @taisiaone',
  ])('rejects a contact-only answer to a contact-only opener: %s', async (replyText) => {
    const result = await qualify(replyText);

    expect(fetchMock.mock.calls.length).toBe(0);
    expect(result).toMatchObject({
      isLead: false,
      customCriteriaMatched: false,
      needsReview: false,
      interestSignals: [],
      objectionHandleable: false,
      objectionDraft: null,
    });
  });

  it('honors an explicit custom exclusion even when AI reports a positive custom match', async () => {
    mockAiResult({
      is_lead: true,
      custom_criteria_matched: true,
      interest_signals: ['переданы имя и телефон'],
      reason: 'Ответ соответствует кастомному критерию.',
      confidence: 0.95,
      needs_review: false,
      objection_handleable: true,
      objection_draft: 'Этот черновик должен быть удалён.',
    });

    const result = await qualify('Александр, 89231889488', {
      leadCriteria: OUTREACH_OS_CRITERIA,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isLead: false,
      customCriteriaMatched: false,
      needsReview: false,
      interestSignals: [],
      objectionHandleable: false,
      objectionDraft: null,
    });
  });

  it('preserves the positive ADK name-and-phone custom criterion', async () => {
    mockAiResult({
      is_lead: false,
      custom_criteria_matched: true,
      interest_signals: ['переданы имя и телефон'],
      reason: 'Ответ соответствует дополнительному критерию проекта.',
      confidence: 0.95,
      needs_review: true,
      objection_handleable: true,
      objection_draft: 'Этот черновик должен быть удалён.',
    });

    const result = await qualify('8 953 909 6065 Мария', {
      leadCriteria: ADK_CRITERIA,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isLead: true,
      customCriteriaMatched: true,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
    });
  });
});

describe('elliptical material request policy', () => {
  it.each([
    { name: 'outbound and quote', outboundText: TOBYLAB_OUTBOUND_TEXT },
    { name: 'quote only', outboundText: null },
  ])(
    'keeps the TobyLab presentation request with its concrete sales outcome offer: $name',
    async ({ outboundText }) => {
      mockAiResult({ is_lead: true, proposal_seen: true, needs_review: false });
      const result = await qualify(TOBYLAB_REPLY_TEXT, { outboundText });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ isLead: true, proposalSeen: true, needsReview: false });
    },
  );

  it.each([
    { name: 'Informatika', replyText: 'Можно мне прислать', outboundText: INFORMATIKA_OUTBOUND_TEXT },
    {
      name: 'English contact opener with a long signature',
      replyText: 'Could you please send a presentation about your services?',
      outboundText: [
        'Hi, we will be grateful if you forward this email to whoever owns growth or outbound at your company.',
        'Could you share the name and contact details of the right person? We can send more information to them directly.',
        'Kind regards, Julia Mirinova, Account Manager, Polza Agency. Thank you for your help.',
      ].join('\n'),
    },
  ])('rejects generic materials without a confirmed proposal: $name', async ({ replyText, outboundText }) => {
    mockAiResult({
      is_lead: true,
      custom_criteria_matched: false,
      proposal_seen: true,
      interest_signals: ['модель ошибочно увидела коммерческий интерес'],
      reason: 'Модель ошибочно квалифицировала общий запрос как лид.',
      needs_review: false,
    });

    const result = await qualify(replyText, { outboundText });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isLead: false,
      needsReview: false,
      interestSignals: [],
      objectionHandleable: false,
      objectionDraft: null,
    });
  });

  it('keeps the same material request as a lead after a confirmed proposal', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель не распознала продолжение интереса.',
      confidence: 0.4,
      needs_review: true,
    });

    const result = await qualify('Можно мне прислать', {
      outboundText: SUBSTANTIVE_OUTBOUND_TEXT,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isLead: true,
      proposalSeen: true,
      needsReview: false,
    });
  });

  it('does not turn a department-routing object into materials after a confirmed proposal', async () => {
    mockAiResult({
      is_lead: false,
      proposal_seen: true,
      interest_signals: [],
      reason: 'Получатель перенаправил запрос в общий отдел без собственного интереса.',
      confidence: 0.95,
      needs_review: false,
    });

    const result = await qualify('Можете направить запрос в отдел закупок', {
      outboundText: SUBSTANTIVE_OUTBOUND_TEXT,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      isLead: false,
      needsReview: false,
      interestSignals: [],
    });
  });
});

describe('positive lead controls', () => {
  it.each([
    {
      name: 'КП with an elliptical modal prefix',
      replyText: 'Можно мне прислать КП с ценами?',
      outboundText: null,
    },
    {
      name: 'price request',
      replyText: 'Сколько стоит?',
      outboundText: null,
    },
    {
      name: 'self-targeted call CTA after a contact opener',
      replyText: 'Можете связаться со мной завтра.',
      outboundText: CONTACT_ONLY_OUTBOUND_TEXT,
    },
    {
      name: 'a human response promise with a concrete call request',
      replyText: 'Ответим по вашему КП завтра. Давайте созвонимся сегодня.',
      outboundText: null,
    },
    {
      name: 'a human commercial request alongside an acknowledgement',
      replyText: `${GRACIE_BODY}\n\nОтдельно по вашему предложению: пришлите КП с ценами.`,
      outboundText: null,
    },
    {
      name: 'interest after a substantive offer',
      replyText: 'Интересно.',
      outboundText: SUBSTANTIVE_OUTBOUND_TEXT,
    },
    {
      name: 'deferred self-interest',
      replyText: 'Сейчас не актуально, но напишите через месяц.',
      outboundText: null,
    },
    {
      name: 'own phone supplied for an offer CTA',
      replyText: 'Мой номер 89997588928, Влада',
      outboundText: SUBSTANTIVE_PHONE_CTA_OUTBOUND_TEXT,
    },
  ])('preserves $name', async ({ replyText, outboundText }) => {
    mockAiResult({
      is_lead: false,
      proposal_seen: false,
      interest_signals: [],
      reason: 'Модель пропустила детерминированный положительный сигнал.',
      confidence: 0.4,
      needs_review: true,
    });

    const result = await qualify(replyText, { outboundText });

    expect(result.isLead).toBe(true);
    expect(result.needsReview).toBe(false);
  });
});
