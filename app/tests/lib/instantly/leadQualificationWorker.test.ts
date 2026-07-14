/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { Email } from '@/lib/instantly/types';

let mockInstantlyDb: MockSupabaseClient | null;
let mockMainDb: MockSupabaseClient | null;

const listEmails = jest.fn();
const getLeadsByEmail = jest.fn();
const getCampaign = jest.fn();
const qualifyReply = jest.fn();
const fetchBriefByCampaign = jest.fn();
const fetchThreadContext = jest.fn();
const sendLeadTelegramAlert = jest.fn();
const sendClientReplyTelegram = jest.fn();

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
  listEmails: (...args: unknown[]) => listEmails(...args),
  getLeadsByEmail: (...args: unknown[]) => getLeadsByEmail(...args),
  getCampaign: (...args: unknown[]) => getCampaign(...args),
}));

jest.mock('@/lib/instantly/leadQualifier', () => ({
  __esModule: true,
  qualifyReply: (...args: unknown[]) => qualifyReply(...args),
  fetchBriefByCampaign: (...args: unknown[]) => fetchBriefByCampaign(...args),
  fetchThreadContext: (...args: unknown[]) => fetchThreadContext(...args),
  getBodyText: (body: Email['body']) => {
    if (!body) return '';
    if (typeof body === 'string') return body;
    return body.text ?? body.html ?? '';
  },
  isAutoReplyOrUnsubscribe: () => false,
  isJunkReply: () => false,
}));

jest.mock('@/lib/instantly/leadTelegramAlerts', () => ({
  __esModule: true,
  sendLeadTelegramAlert: (...args: unknown[]) => sendLeadTelegramAlert(...args),
}), { virtual: true });

jest.mock('@/lib/clientReplyBot/bot', () => ({
  __esModule: true,
  getClientRepliesBotToken: () => 'test-client-bot-token',
  sendClientReplyTelegram: (...args: unknown[]) => sendClientReplyTelegram(...args),
  buildClientReplyMessage: (data: unknown) => JSON.stringify(data),
}));

function replyEmail(overrides: Partial<Email>): Email {
  return {
    id: 'email-1',
    campaign_id: 'linked-campaign',
    from_address_email: 'lead@example.com',
    thread_id: 'thread-1',
    subject: 'Re: proposal',
    ue_type: 2,
    body: { text: 'Interested' },
    timestamp_email: '2026-05-13T12:00:00Z',
    ...overrides,
  } as Email;
}

describe('pollAndQualifyReplies', () => {
  const oldLeadKey = process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY;
  const oldBriefKey = process.env.OPENROUTER_BRIEF_API_KEY;
  const oldPages = process.env.INSTANTLY_LEADS_EMAIL_PAGES;

  beforeEach(() => {
    jest.resetModules();
    listEmails.mockReset();
    getLeadsByEmail.mockReset().mockResolvedValue([]);
    getCampaign.mockReset().mockResolvedValue({ id: 'linked-campaign', name: 'Кампания Новикова' });
    sendLeadTelegramAlert.mockReset().mockResolvedValue({ sent: true, messageId: 42 });
    sendClientReplyTelegram.mockReset().mockResolvedValue({ messageId: 7 });
    fetchBriefByCampaign.mockReset().mockResolvedValue(null);
    // null = контекст треда не восстановлен → кросс-клиентский guard скипается
    // (fail-open), тесты обычного потока не затрагиваются.
    fetchThreadContext.mockReset().mockResolvedValue(null);
    qualifyReply.mockReset().mockResolvedValue({
      isLead: false,
      proposalSeen: true,
      interestSignals: [],
      reason: 'Не лид',
      confidence: 0.8,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({ id: 'linked-email' }),
        threadEmails: [],
        lastOutbound: null,
      },
    });

    process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY = 'test-ai-key';
    delete process.env.OPENROUTER_BRIEF_API_KEY;
    process.env.INSTANTLY_LEADS_EMAIL_PAGES = '1';

    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
          { project_id: 'missing-project', campaign_id: 'orphan-campaign', match_source: 'auto' },
        ],
        user_instantly_campaign_preferences: [
          { user_id: 'user-1', campaign_id: 'prefs-only-campaign' },
        ],
        instantly_lead_qualifications: [],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-1', client: 'Acme', specialist_user_id: 'specialist-1' },
        ],
        profiles: [
          { id: 'specialist-1', full_name: 'Sergey Petrov', email: 'sergey@example.com' },
        ],
        telegram_links: [
          {
            user_id: 'specialist-1',
            telegram_id: '123456',
            telegram_username: 'sergey_portal',
          },
        ],
        notifications: [],
        deadline_notification_log: [],
      },
    });
  });

  afterAll(() => {
    if (oldLeadKey === undefined) delete process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY;
    else process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY = oldLeadKey;
    if (oldBriefKey === undefined) delete process.env.OPENROUTER_BRIEF_API_KEY;
    else process.env.OPENROUTER_BRIEF_API_KEY = oldBriefKey;
    if (oldPages === undefined) delete process.env.INSTANTLY_LEADS_EMAIL_PAGES;
    else process.env.INSTANTLY_LEADS_EMAIL_PAGES = oldPages;
  });

  it('polls recent replies globally and qualifies only campaigns linked to a Portal client project', async () => {
    const replies = [
      replyEmail({ id: 'linked-email', campaign_id: 'linked-campaign' }),
      replyEmail({ id: 'prefs-only-email', campaign_id: 'prefs-only-campaign' }),
      replyEmail({ id: 'orphan-email', campaign_id: 'orphan-campaign' }),
    ];
    listEmails.mockImplementation(async (params: { campaign_id?: string }) => {
      if (params.campaign_id) {
        return {
          items: replies.filter((email) => email.campaign_id === params.campaign_id),
          next_starting_after: null,
        };
      }
      return { items: replies, next_starting_after: null };
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(listEmails).toHaveBeenCalledTimes(1);
    expect(listEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        // Правильный фильтр Instantly v2 — `email_type` (string enum),
        // а не `ue_type` (response-поле). Раньше тут было `ue_type: 2`,
        // но Instantly его молча игнорировал — ловило весь трафик
        // и фильтровало вручную в `linkedReplies`.
        email_type: 'received',
        limit: expect.any(Number),
      }),
      // Replies are now fetched per Instantly account; the project-linked
      // ('под ключ') universe lives on the 'main' account.
      expect.objectContaining({ accountId: 'main' }),
    );
    expect(listEmails.mock.calls[0][0]).not.toHaveProperty('campaign_id');
    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(qualifyReply.mock.calls[0][0]).toBe('linked-campaign');
    // Контракт против двойного фетча: воркер передаёт УЖЕ зафетченный контекст
    // (здесь null — fetchThreadContext замокан в null) явно, а qualifyReply при
    // непустом prefetchedContext (включая null) НЕ рефетчит.
    expect(qualifyReply.mock.calls[0][3]).toEqual(
      expect.objectContaining({ prefetchedContext: null }),
    );
    expect(mockInstantlyDb!.upserts).toHaveLength(1);
    expect(mockInstantlyDb!.upserts[0].rows[0]).toEqual(
      expect.objectContaining({
        campaign_id: 'linked-campaign',
        instantly_email_id: 'linked-email',
      }),
    );
  });

  it('sends a Telegram alert for a newly qualified lead assigned to a linked specialist', async () => {
    qualifyReply.mockResolvedValueOnce({
      isLead: true,
      proposalSeen: true,
      interestSignals: ['asked_for_call'],
      reason: 'Просит созвон',
      confidence: 0.92,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({
          id: 'lead-email',
          body: { text: 'Давайте созвонимся' },
          subject: 'Re: proposal',
        }),
        threadEmails: [],
        lastOutbound: null,
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'lead-email', campaign_id: 'linked-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
    expect(sendLeadTelegramAlert).toHaveBeenCalledWith(expect.objectContaining({
      campaignId: 'linked-campaign',
      leadEmail: 'lead@example.com',
      leadName: null,
      companyName: null,
      campaignName: 'Кампания Новикова',
      clientName: 'Acme',
      replySubject: 'Re: proposal',
      replyPreview: 'Давайте созвонимся',
      aiReason: 'Просит созвон',
      specialistMentions: [
        {
          userId: 'specialist-1',
          fullName: 'Sergey Petrov',
          telegramId: '123456',
          telegramUsername: 'sergey_portal',
        },
      ],
    }));
  });

  // Пост-handoff эхо (кейс «Умные Новации» 10.07.2026): после передачи лида
  // клиент отвечает лиду со своей почты, наш ящик в копии → Instantly кладёт
  // письмо в кампанию как received, ИИ честно читает «просит встречу» → ложный
  // lead-алерт. Guard: письмо с handoff-адреса или его корп-домена не
  // квалифицируется, но строка пишется (дедуп), алерта и ИИ нет.
  it('skips client-authored post-handoff replies (exact handoff address + corporate-domain colleague) without AI or alert', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-1',
            client: 'Умные Новации',
            specialist_user_id: 'specialist-1',
            handoff_email: 'roman.maslikhov@umnovation.ru, boss@umnovation.ru',
          },
        ],
        profiles: [],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    listEmails.mockResolvedValue({
      items: [
        replyEmail({ id: 'client-echo', from_address_email: 'roman.maslikhov@umnovation.ru' }),
        // Коллега клиента: адреса нет в handoff-списке, но корп-домен тот же.
        replyEmail({ id: 'client-colleague', from_address_email: 'manager@umnovation.ru' }),
      ],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(2);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe('not_lead');
      expect(String(row.ai_reason)).toContain('от нашего клиента');
    }
  });

  it('does not block freemail domains: a gmail lead still qualifies even when a past forward went to a gmail client address', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        instantly_lead_qualifications: [],
        client_forwarded_leads: [
          { campaign_id: 'linked-campaign', client_email: 'client.person@gmail.com' },
        ],
      },
    });
    listEmails.mockResolvedValue({
      items: [
        // Точный клиентский адрес — глушим; чужой gmail — обычный лид (домен
        // freemail в доменный блок НЕ попадает, иначе зарубили бы всех лидов
        // с бесплатной почтой).
        replyEmail({ id: 'gmail-client', from_address_email: 'client.person@gmail.com' }),
        replyEmail({ id: 'gmail-lead', from_address_email: 'someone.else@gmail.com' }),
      ],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(2);
    expect(qualifyReply).toHaveBeenCalledTimes(1);
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    const clientRow = rows.find((r) => r.instantly_email_id === 'gmail-client');
    const leadRow = rows.find((r) => r.instantly_email_id === 'gmail-lead');
    expect(clientRow?.status).toBe('not_lead');
    expect(String(clientRow?.ai_reason)).toContain('от нашего клиента');
    expect(leadRow).toBeDefined();
    expect(String(leadRow?.ai_reason ?? '')).not.toContain('от нашего клиента');
  });

  // «Слепые» письма (кейс NAIS→KIRA.PW 10.07): нашего ящика нет в To/CC —
  // скрытая копия / чужое письмо с домена лида, приклеенное Instantly к
  // кампании. Не lead-алерт, а needs_review без пинга и без вызова ИИ.
  it('routes emails not addressed to our mailbox (BCC/stray) to needs_review without AI or alert', async () => {
    listEmails.mockResolvedValue({
      items: [
        replyEmail({
          id: 'stray-email',
          from_address_email: 'head_market@nais.ru',
          eaccount: 'lyamina@ritso-contact.ru',
          to_address_email_list: 'kirill@kira-aggregator.ru',
        }),
      ],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('needs_review');
    expect(String(rows[0].ai_reason)).toContain('нет в To/CC');
  });

  it('does not flag as stray when our mailbox IS a recipient (including "Name <addr>" format) or when To/CC data is absent', async () => {
    listEmails.mockResolvedValue({
      items: [
        // Наш ящик в To в формате с именем — обычная квалификация.
        replyEmail({
          id: 'normal-reply',
          eaccount: 'lyamina@ritso-contact.ru',
          to_address_email_list: 'Yanislava Lyamina <lyamina@ritso-contact.ru>',
        }),
        // Листинг без To/CC-полей — проверка невозможна, fail-open в ИИ-путь.
        replyEmail({
          id: 'no-recipient-data',
          from_address_email: 'other-lead@example.com',
          eaccount: 'lyamina@ritso-contact.ru',
        }),
      ],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(2);
    expect(qualifyReply).toHaveBeenCalledTimes(2);
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    for (const row of rows) {
      expect(String(row.ai_reason ?? '')).not.toContain('нет в To/CC');
    }
  });

  // Пер-проектное определение лида (projects.lead_criteria) прокидывается в
  // квалификацию — иначе кастомные критерии молча не работали бы.
  it('passes the project lead_criteria into qualifyReply (and null when not set)', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-1',
            client: 'Ritso',
            specialist_user_id: 'specialist-1',
            lead_criteria: 'Кампании собирают контакты ЛПР: контакт или предложение созвониться = лид.',
          },
        ],
        profiles: [],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'criteria-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(qualifyReply.mock.calls[0][3]).toEqual(
      expect.objectContaining({
        leadCriteria: 'Кампании собирают контакты ЛПР: контакт или предложение созвониться = лид.',
      }),
    );
  });

  // «Свой промпт» self-serve клиента (client_lead_criteria): кампания без
  // проекта берёт критерии владельца из client_instantly_access.
  it('passes the CLIENT lead criteria for a self-serve campaign (no project link)', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        instantly_lead_qualifications: [],
        client_instantly_access: [
          {
            client_user_id: 'client-7',
            resource_type: 'campaign',
            resource_id: 'self-serve-campaign',
            instantly_account_id: 'main',
          },
        ],
        client_lead_criteria: [
          { client_user_id: 'client-7', criteria: 'Лид = интерес к услуге или запрос цены.' },
        ],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'ss-email', campaign_id: 'self-serve-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(qualifyReply.mock.calls[0][3]).toEqual(
      expect.objectContaining({ leadCriteria: 'Лид = интерес к услуге или запрос цены.' }),
    );
  });

  it('project criteria beat client criteria when both exist', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-1', client: 'Acme', specialist_user_id: 'specialist-1', lead_criteria: 'ПРОЕКТНЫЕ критерии.' },
        ],
        profiles: [],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        instantly_lead_qualifications: [],
        client_instantly_access: [
          { client_user_id: 'client-7', resource_type: 'campaign', resource_id: 'linked-campaign', instantly_account_id: 'main' },
        ],
        client_lead_criteria: [
          { client_user_id: 'client-7', criteria: 'КЛИЕНТСКИЕ критерии.' },
        ],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'both-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(qualifyReply.mock.calls[0][3]).toEqual(
      expect.objectContaining({ leadCriteria: 'ПРОЕКТНЫЕ критерии.' }),
    );
  });

  // Переключатель «только лиды»: leads_only=true режет DM для не-лидов,
  // false (дефолт) — прежнее поведение «каждый человеческий ответ».
  it('leads_only=true suppresses client DM for non-lead replies; default sends everything', async () => {
    const seed = (leadsOnly: boolean) => {
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [],
          instantly_lead_qualifications: [],
          client_instantly_access: [
            { client_user_id: 'client-7', resource_type: 'campaign', resource_id: 'self-serve-campaign', instantly_account_id: 'main' },
          ],
          client_reply_telegram_links: [
            { client_user_id: 'client-7', chat_id: 111, enabled: true, leads_only: leadsOnly },
          ],
        },
      });
      listEmails.mockResolvedValue({
        items: [replyEmail({ id: `lo-${leadsOnly}`, campaign_id: 'self-serve-campaign' })],
        next_starting_after: null,
      });
    };

    // not_lead (дефолтный мок qualifyReply) + leads_only → DM подавлен
    seed(true);
    let mod = await import('@/lib/instantly/leadQualificationWorker');
    await mod.pollAndQualifyReplies();
    expect(sendClientReplyTelegram).not.toHaveBeenCalled();

    // not_lead + БЕЗ leads_only → DM уходит (прежнее поведение)
    jest.resetModules();
    sendClientReplyTelegram.mockClear();
    seed(false);
    mod = await import('@/lib/instantly/leadQualificationWorker');
    await mod.pollAndQualifyReplies();
    expect(sendClientReplyTelegram).toHaveBeenCalledTimes(1);
  });

  it('leads_only=true still DMs actual leads (with the client-criteria badge when their prompt decided)', async () => {
    qualifyReply.mockResolvedValueOnce({
      isLead: true,
      proposalSeen: true,
      interestSignals: ['цена'],
      reason: 'Запросил цену',
      confidence: 0.9,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({ id: 'lo-lead', body: { text: 'Сколько стоит?' } }),
        threadEmails: [],
        lastOutbound: null,
      },
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        instantly_lead_qualifications: [],
        client_instantly_access: [
          { client_user_id: 'client-7', resource_type: 'campaign', resource_id: 'self-serve-campaign', instantly_account_id: 'main' },
        ],
        client_lead_criteria: [
          { client_user_id: 'client-7', criteria: 'Запрос цены = лид.' },
        ],
        client_reply_telegram_links: [
          { client_user_id: 'client-7', chat_id: 111, enabled: true, leads_only: true },
        ],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'lo-lead', campaign_id: 'self-serve-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(sendClientReplyTelegram).toHaveBeenCalledTimes(1);
    const html = String(sendClientReplyTelegram.mock.calls[0][1]);
    expect(html).toContain('"isLeadByClientCriteria":true');
  });

  it('passes leadCriteria=null when the project has no custom criteria', async () => {
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'no-criteria-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(qualifyReply.mock.calls[0][3]).toEqual(
      expect.objectContaining({ leadCriteria: null }),
    );
  });

  // Холодный кэш + блип БД: критерии НЕИЗВЕСТНЫ → письмо откладывается БЕЗ
  // записи (иначе вердикт с дефолтными критериями осел бы навсегда через
  // дедуп — ровно то, что чинил cce28d618). Следующий тик обработает заново.
  it('defers the reply (no row, no AI) when criteria fetch is degraded on a cold cache', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-1', client: 'Ritso', specialist_user_id: 'specialist-1', lead_criteria: 'Контакт = лид' },
        ],
        profiles: [],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
      },
      // Прицельно роняем ТОЛЬКО запрос критериев (select lead_criteria) —
      // верификация привязки (select 'id, client') работает, кампания
      // квалифицируема, и тест реально доходит до defer-ветки.
      errorSelects: { projects: { columnsInclude: 'lead_criteria', message: 'connection timeout (blip)' } },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'deferred-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toHaveLength(0);
  });

  // Кросс-клиентский доменный матч Instantly (кейс NAIS→KIRA 10.07): лид двух
  // наших клиентов написал НОВОЕ письмо на ящик клиента A (To=eaccount, поэтому
  // BCC-guard молчит), а Instantly приклеил его по домену отправителя к
  // кампании клиента B. Детектор: eaccount ≠ ящики, писавшие лиду в треде.
  it('routes cross-client domain-matched emails (arrived at another client mailbox) to needs_review without AI or alert', async () => {
    fetchThreadContext.mockResolvedValue({
      replyEmail: replyEmail({ id: 'cross-email' }),
      threadEmails: [
        replyEmail({
          id: 'our-outbound',
          ue_type: 1,
          eaccount: 'lyamina@ritso-contact.ru',
          from_address_email: 'lyamina@ritso-contact.ru',
        }),
      ],
      lastOutbound: replyEmail({
        id: 'our-outbound',
        ue_type: 1,
        eaccount: 'lyamina@ritso-contact.ru',
        from_address_email: 'lyamina@ritso-contact.ru',
      }),
    });
    listEmails.mockResolvedValue({
      items: [
        replyEmail({
          id: 'cross-email',
          from_address_email: 'head_market@nais.ru',
          eaccount: 'kirill@kira-aggregator.ru',
          to_address_email_list: 'kirill@kira-aggregator.ru',
        }),
      ],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('needs_review');
    expect(String(rows[0].ai_reason)).toContain('kirill@kira-aggregator.ru');
    expect(String(rows[0].ai_reason)).toContain('lyamina@ritso-contact.ru');
  });

  // Слепая зона, найденная адверсариальным ревью: у «слепого» письма тред не
  // содержит наших исходящих (search идёт по адресу ОТПРАВИТЕЛЯ, кампания ему
  // не писала) → сравнение только с тредом молча fail-open'илось. Теперь guard
  // сравнивает ещё и с ящиками кампании (campaignOutboundMailboxes).
  it('flags cross-client via campaign mailboxes when the thread itself has no outbounds', async () => {
    fetchThreadContext.mockResolvedValue({
      replyEmail: replyEmail({ id: 'cross-empty-thread' }),
      threadEmails: [],
      lastOutbound: null,
      campaignOutboundMailboxes: ['lyamina@ritso-contact.ru'],
    });
    listEmails.mockResolvedValue({
      items: [
        replyEmail({
          id: 'cross-empty-thread',
          from_address_email: 'head_market@nais.ru',
          eaccount: 'kirill@kira-aggregator.ru',
          to_address_email_list: 'kirill@kira-aggregator.ru',
        }),
      ],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('needs_review');
    expect(String(rows[0].ai_reason)).toContain('kirill@kira-aggregator.ru');
  });

  // Ящики-двойники ОДНОГО клиента (несколько lookalike-доменов — стандарт
  // аутрича): та же персона или та же база домена ≠ «другой клиент». 13.07
  // guard увёл живого лида Диспы (vadim@dispa-pro.ru vs vadim@dispa-pro.online)
  // в needs_review — пин против рецидива.
  it('does not flag same-client mailbox twins (same persona or same domain base)', async () => {
    const cases = [
      // Диспа: та же персона, домены dispa-pro.ru / dispa-pro.online
      { arrived: 'vadim@dispa-pro.ru', mailed: 'vadim@dispa-pro.online' },
      // SANDS: персона olga.sands vs olga_sands, домены sandsstudio.online / sands-studio.ru
      { arrived: 'olga.sands@sandsstudio.online', mailed: 'olga_sands@sands-studio.ru' },
    ];
    for (const [i, c] of cases.entries()) {
      jest.resetModules();
      qualifyReply.mockClear();
      fetchThreadContext.mockResolvedValue({
        replyEmail: replyEmail({ id: `twin-${i}` }),
        threadEmails: [replyEmail({ id: `twin-out-${i}`, ue_type: 1, eaccount: c.mailed })],
        lastOutbound: replyEmail({ id: `twin-out-${i}`, ue_type: 1, eaccount: c.mailed }),
      });
      listEmails.mockResolvedValue({
        items: [replyEmail({ id: `twin-${i}`, eaccount: c.arrived, to_address_email_list: c.arrived })],
        next_starting_after: null,
      });
      const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
      await pollAndQualifyReplies();
      expect(qualifyReply).toHaveBeenCalledTimes(1);
    }
  });

  it('still flags cross-client when generic locals match but domains differ (hello@ everywhere)', async () => {
    fetchThreadContext.mockResolvedValue({
      replyEmail: replyEmail({ id: 'generic-email' }),
      threadEmails: [replyEmail({ id: 'generic-out', ue_type: 1, eaccount: 'hello@stratgrowthlink.online' })],
      lastOutbound: replyEmail({ id: 'generic-out', ue_type: 1, eaccount: 'hello@stratgrowthlink.online' }),
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'generic-email', eaccount: 'hello@connectifygroup.ru', to_address_email_list: 'hello@connectifygroup.ru' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).not.toHaveBeenCalled();
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows[0]?.status).toBe('needs_review');
  });

  it('does not flag cross-client when the reply arrived at the same mailbox that mailed the lead', async () => {
    fetchThreadContext.mockResolvedValue({
      replyEmail: replyEmail({ id: 'same-mailbox-email' }),
      threadEmails: [
        replyEmail({ id: 'our-outbound-2', ue_type: 1, eaccount: 'lyamina@ritso-contact.ru' }),
      ],
      lastOutbound: replyEmail({ id: 'our-outbound-2', ue_type: 1, eaccount: 'lyamina@ritso-contact.ru' }),
    });
    listEmails.mockResolvedValue({
      items: [
        replyEmail({
          id: 'same-mailbox-email',
          eaccount: 'lyamina@ritso-contact.ru',
          to_address_email_list: 'lyamina@ritso-contact.ru',
        }),
      ],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    expect(qualifyReply).toHaveBeenCalledTimes(1);
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(String(rows[0]?.ai_reason ?? '')).not.toContain('привязал его по домену');
  });
});
