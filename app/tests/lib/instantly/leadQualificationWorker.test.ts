/** @jest-environment node */

import { createMockSupabase, type MockSupabaseClient } from '@/../tests/helpers/mockSupabase';
import type { Email } from '@/lib/instantly/types';

let mockInstantlyDb: MockSupabaseClient | null;
let mockMainDb: MockSupabaseClient | null;

const listEmails = jest.fn();
const getLeadsByEmail = jest.fn();
const getCampaign = jest.fn();
const getAccountCampaignMappings = jest.fn();
const getEmail = jest.fn();
const replyToEmail = jest.fn();
const sendTestEmail = jest.fn();
const qualifyReply = jest.fn();
const fetchBriefByCampaign = jest.fn();
const fetchThreadContext = jest.fn();
const sendLeadTelegramAlert = jest.fn();
const sendClientReplyTelegram = jest.fn();
const postHandoffMessage = jest.fn();
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
  listEmails: (...args: unknown[]) => listEmails(...args),
  getLeadsByEmail: (...args: unknown[]) => getLeadsByEmail(...args),
  getCampaign: (...args: unknown[]) => getCampaign(...args),
  getAccountCampaignMappings: (...args: unknown[]) => getAccountCampaignMappings(...args),
  getEmail: (...args: unknown[]) => getEmail(...args),
  replyToEmail: (...args: unknown[]) => replyToEmail(...args),
  sendTestEmail: (...args: unknown[]) => sendTestEmail(...args),
}));

jest.mock('@/lib/instantly/handoffTelegram', () => ({
  __esModule: true,
  handoffBotToken: () => 'test-bot-token',
  handoffChatId: () => '-100123',
  handoffThreadId: () => 777,
  postHandoffMessage: (...args: unknown[]) => postHandoffMessage(...args),
  editHandoffMessage: (...args: unknown[]) => editHandoffMessage(...args),
  escapeHtml: (s: string) => s,
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

function installMailboxOwnershipConflictFixture(options?: { mappingError?: Error }) {
  const providerCampaignId = 'ritso-current-campaign';
  const candidateCampaignIds = ['mailbox-owner-campaign-a', 'mailbox-owner-campaign-b'];
  const ownerMailbox = 'interact@outreach-contact.online';
  const inbound = replyEmail({
    id: options?.mappingError ? 'mapping-error-reply' : 'ambiguous-owner-reply',
    campaign_id: providerCampaignId,
    from_address_email: 'lead@prospect.example',
    to_address_email_list: ownerMailbox,
    eaccount: ownerMailbox,
    thread_id: 'provider-thread-without-parent',
    body: { text: 'Давайте обсудим ваше предложение.' },
  });
  const providerContext = {
    replyEmail: inbound,
    threadEmails: [inbound],
    lastOutbound: null,
    // Same local-part is intentional: the old heuristic treats these as one
    // client even though the exact mailboxes belong to different projects.
    campaignOutboundMailboxes: ['interact@ritso-project.example'],
  };

  mockInstantlyDb = createMockSupabase({
    tables: {
      project_instantly_campaigns: [
        { project_id: 'project-provider', campaign_id: providerCampaignId, match_source: 'auto' },
        { project_id: 'project-owner-a', campaign_id: candidateCampaignIds[0], match_source: 'auto' },
        { project_id: 'project-owner-b', campaign_id: candidateCampaignIds[1], match_source: 'auto' },
      ],
      instantly_lead_qualifications: [],
    },
  });
  mockMainDb = createMockSupabase({
    tables: {
      projects: [
        { id: 'project-provider', client: 'Ritso', specialist_user_id: 'dmitry-id' },
        { id: 'project-owner-a', client: 'Owner A', specialist_user_id: 'owner-a-id' },
        { id: 'project-owner-b', client: 'Owner B', specialist_user_id: 'owner-b-id' },
      ],
      profiles: [
        { id: 'dmitry-id', full_name: 'Дмитрий К.', email: 'dmitry@example.com' },
        { id: 'owner-a-id', full_name: 'Owner A', email: 'owner-a@example.com' },
        { id: 'owner-b-id', full_name: 'Owner B', email: 'owner-b@example.com' },
      ],
      telegram_links: [
        { user_id: 'dmitry-id', telegram_id: '111', telegram_username: 'dmitry' },
        { user_id: 'owner-a-id', telegram_id: '222', telegram_username: 'owner_a' },
        { user_id: 'owner-b-id', telegram_id: '333', telegram_username: 'owner_b' },
      ],
      notifications: [],
      deadline_notification_log: [],
    },
  });
  getCampaign.mockImplementation(async (campaignId: string) => ({
    id: campaignId,
    name: campaignId,
    email_list: campaignId === providerCampaignId
      ? ['interact@ritso-project.example']
      : [ownerMailbox],
  }));
  getAccountCampaignMappings.mockImplementation(async (mailbox: string) => {
    if (options?.mappingError) throw options.mappingError;
    return mailbox.toLowerCase() === ownerMailbox
      ? candidateCampaignIds.map((campaignId) => ({
          campaign_id: campaignId,
          status: 1,
          timestamp_created: '2026-07-01T00:00:00.000Z',
        }))
      : [];
  });
  fetchThreadContext.mockImplementation(async (campaignId: string) =>
    campaignId === providerCampaignId ? providerContext : null,
  );
  // Neither exact-mailbox candidate contains an outbound that can be proven
  // to be the parent of this reply.
  listEmails.mockImplementation(async (params: { campaign_id?: string }) =>
    !params.campaign_id
      ? { items: [inbound], next_starting_after: null }
      : { items: [], next_starting_after: null },
  );
  qualifyReply.mockResolvedValue({
    isLead: true,
    customCriteriaMatched: false,
    proposalSeen: true,
    interestSignals: ['requested_discussion'],
    reason: 'Просит обсудить предложение.',
    confidence: 0.95,
    needsReview: false,
    objectionHandleable: false,
    objectionDraft: null,
    threadContext: providerContext,
  });

  return { providerCampaignId, candidateCampaignIds, ownerMailbox, inbound };
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
    getAccountCampaignMappings.mockReset().mockResolvedValue([]);
    getEmail.mockReset();
    replyToEmail.mockReset().mockResolvedValue({ id: 'sent-1' });
    sendTestEmail.mockReset().mockResolvedValue({ id: 'sent-test-1' });
    postHandoffMessage.mockReset().mockResolvedValue(555);
    editHandoffMessage.mockReset().mockResolvedValue(undefined);
    delete process.env.LEAD_HANDOFF_ENABLED;
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

  it('custom criterion match wins over a conflicting needs_review flag and sends the lead alert', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{
          id: 'project-1',
          client: 'Acme',
          specialist_user_id: 'specialist-1',
          lead_criteria: 'Просьба связаться по переданному номеру = лид.',
        }],
        profiles: [
          { id: 'specialist-1', full_name: 'Sergey Petrov', email: 'sergey@example.com' },
        ],
        telegram_links: [{
          user_id: 'specialist-1',
          telegram_id: '123456',
          telegram_username: 'sergey_portal',
        }],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    qualifyReply.mockResolvedValueOnce({
      isLead: true,
      customCriteriaMatched: true,
      proposalSeen: false,
      interestSignals: ['попросили связаться по переданному телефону'],
      reason: 'Ответ соответствует дополнительному критерию проекта.',
      confidence: 0.9,
      needsReview: true,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({
          id: 'custom-lead-email',
          body: { text: 'Добрый день! Узнайте по тел. 477-921' },
        }),
        threadEmails: [],
        lastOutbound: null,
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'custom-lead-email', campaign_id: 'linked-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('lead');
    expect(qualifyReply.mock.calls[0][3]).toEqual(expect.objectContaining({
      leadCriteria: 'Просьба связаться по переданному номеру = лид.',
    }));
    expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('ignores an impossible custom match flag when the campaign has no custom criteria', async () => {
    qualifyReply.mockResolvedValueOnce({
      isLead: false,
      customCriteriaMatched: true,
      proposalSeen: false,
      interestSignals: [],
      reason: 'Неконсистентный ответ провайдера.',
      confidence: 0.4,
      needsReview: true,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({ id: 'no-custom-email', body: { text: 'Нужно проверить' } }),
        threadEmails: [],
        lastOutbound: null,
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'no-custom-email', campaign_id: 'linked-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('needs_review');
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
  });

  it('writes a lead-board row for a newly qualified lead (auto columns, enrichment, step from thread)', async () => {
    process.env.GUEST_TOKEN_SECRET = 'test-board-secret';
    getLeadsByEmail.mockResolvedValueOnce([
      {
        first_name: 'Иван',
        last_name: 'Петров',
        company_name: 'ACME',
        phone: '+7 900 111-22-33',
        website: 'acme.ru',
      },
    ]);
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
        replyEmail: replyEmail({ id: 'lead-email', body: { text: 'Давайте созвонимся' } }),
        threadEmails: [
          replyEmail({ id: 'out-1', ue_type: 1 }),
          replyEmail({ id: 'out-2', ue_type: 1 }),
          replyEmail({ id: 'lead-email', ue_type: 2 }),
        ],
        lastOutbound: replyEmail({ id: 'out-2', ue_type: 1 }),
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'lead-email', campaign_id: 'linked-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    // Доска создана лениво при первом лиде проекта
    const boards = mockInstantlyDb!.getRows('project_lead_boards');
    expect(boards).toHaveLength(1);
    expect(boards[0].project_id).toBe('project-1');
    // Авто-строка: все колонки из обогащения + шаг = числу наших исходящих в треде
    const boardRows = mockInstantlyDb!.getRows('project_lead_board_rows');
    expect(boardRows).toHaveLength(1);
    const qualification = mockInstantlyDb!.getRows('instantly_lead_qualifications')[0];
    expect(boardRows[0]).toEqual(
      expect.objectContaining({
        project_id: 'project-1',
        qualification_id: qualification.id,
        campaign_id: 'linked-campaign',
        campaign_name: 'Кампания Новикова',
        lead_email: 'lead@example.com',
        lead_name: 'Иван Петров',
        company_name: 'ACME',
        phone: '+7 900 111-22-33',
        website: 'acme.ru',
        request_text: 'Давайте созвонимся',
        step_number: 2,
        reply_timestamp: '2026-05-13T12:00:00Z',
      }),
    );
    // Клиентские колонки воркером не пишутся
    expect(boardRows[0]).not.toHaveProperty('quality');
    expect(boardRows[0]).not.toHaveProperty('comment');
    expect(boardRows[0]).not.toHaveProperty('taken');
    // Ссылка на доску ушла в TG-алерт
    expect(sendLeadTelegramAlert).toHaveBeenCalledWith(
      expect.objectContaining({ boardLink: expect.stringMatching(/\/leads-board\/lb_/) }),
    );
  });

  it('board failure (DB error on board tables) does not break qualification or alert — warn only', async () => {
    // Ground rule: код едет раньше миграции / блик БД доски — money path цел.
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        instantly_lead_qualifications: [],
      },
      errorTables: { project_lead_boards: 'boom' },
    });
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
        replyEmail: replyEmail({ id: 'lead-email', body: { text: 'Давайте созвонимся' } }),
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

    expect(processed).toBe(1); // квалификация записана
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toHaveLength(1);
    expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1); // алерт ушёл — без строки ссылки
    expect(sendLeadTelegramAlert).toHaveBeenCalledWith(
      expect.objectContaining({ boardLink: null }),
    );
    expect(mockInstantlyDb!.getRows('project_lead_board_rows')).toHaveLength(0);
  });

  it('автопередача (handoff_auto_send): отправляет сразу без кнопки, pending → sent', async () => {
    process.env.LEAD_HANDOFF_ENABLED = '1';
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-1',
            client: 'Acme',
            specialist_user_id: 'specialist-1',
            handoff_email: 'client@clientco.ru',
            handoff_legend: 'Добрый день, [Имя, если есть]. Передаю коллеге в копию.',
            handoff_auto_send: true,
          },
        ],
        profiles: [
          { id: 'specialist-1', full_name: 'Sergey Petrov', email: 'sergey@example.com' },
        ],
        telegram_links: [
          { user_id: 'specialist-1', telegram_id: '123456', telegram_username: 'sergey_portal' },
        ],
      },
    });
    getEmail.mockRejectedValue(new Error('no original — cc only client'));
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
        replyEmail: replyEmail({ id: 'lead-email', from_address_email: 'lead@leadscorp.ru', body: { text: 'Давайте созвонимся' } }),
        threadEmails: [replyEmail({ id: 'out-1', ue_type: 1 })],
        lastOutbound: replyEmail({ id: 'out-1', ue_type: 1 }),
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'lead-email', campaign_id: 'linked-campaign', from_address_email: 'lead@leadscorp.ru', eaccount: 'sender@example.com' } as Partial<Email>)],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(1);
    // Карточка ушла БЕЗ кнопки (callbackData нет), с пометкой автопередачи
    expect(postHandoffMessage).toHaveBeenCalledTimes(1);
    const card = postHandoffMessage.mock.calls[0][0] as { text: string; callbackData?: string };
    expect(card.callbackData).toBeUndefined();
    expect(card.text).toContain('Автопередача включена');
    // Отправка сразу через общий sender: reply ушёл, pending → sent, трекинг записан
    expect(replyToEmail).toHaveBeenCalledTimes(1);
    const pending = mockInstantlyDb!.getRows('instantly_pending_handoffs');
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('sent');
    expect(pending[0].draft_text).toBe('Добрый день. Передаю коллеге в копию.');
    const fwd = mockInstantlyDb!.getRows('client_forwarded_leads');
    expect(fwd).toHaveLength(1);
    expect(fwd[0].forwarded_via).toBe('handoff-auto');
    expect(sendTestEmail).not.toHaveBeenCalled();
  });

  it('автопередача — сбой отправки: pending → failed, карточка помечается ошибкой', async () => {
    process.env.LEAD_HANDOFF_ENABLED = '1';
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-1',
            client: 'Acme',
            specialist_user_id: 'specialist-1',
            handoff_email: 'client@clientco.ru',
            handoff_legend: 'Передаю коллеге.',
            handoff_auto_send: true,
          },
        ],
        profiles: [
          { id: 'specialist-1', full_name: 'Sergey Petrov', email: 'sergey@example.com' },
        ],
        telegram_links: [
          { user_id: 'specialist-1', telegram_id: '123456', telegram_username: 'sergey_portal' },
        ],
      },
    });
    getEmail.mockRejectedValue(new Error('x'));
    replyToEmail.mockRejectedValue(new Error('InstantlyApiError: Instantly API 500: boom'));
    qualifyReply.mockResolvedValueOnce({
      isLead: true,
      proposalSeen: true,
      interestSignals: [],
      reason: 'интерес',
      confidence: 0.9,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({ id: 'lead-email', from_address_email: 'lead@leadscorp.ru', body: { text: 'ок' } }),
        threadEmails: [replyEmail({ id: 'out-1', ue_type: 1 })],
        lastOutbound: replyEmail({ id: 'out-1', ue_type: 1 }),
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'lead-email', campaign_id: 'linked-campaign', from_address_email: 'lead@leadscorp.ru', eaccount: 'sender@example.com' } as Partial<Email>)],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);

    const pending = mockInstantlyDb!.getRows('instantly_pending_handoffs');
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe('failed');
    expect(String(pending[0].error_message)).toContain('500');
    expect(editHandoffMessage).toHaveBeenCalledTimes(1);
    expect(editHandoffMessage.mock.calls[0][3] as string).toContain('Автопередача не отправлена');
    expect(mockInstantlyDb!.getRows('client_forwarded_leads')).toHaveLength(0);
  });

  it('кнопочный режим (auto_send выкл): карточка С кнопкой, отправки нет, pending ждёт спеца', async () => {
    process.env.LEAD_HANDOFF_ENABLED = '1';
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-1',
            client: 'Acme',
            specialist_user_id: 'specialist-1',
            handoff_email: 'client@clientco.ru',
            handoff_legend: 'Передаю коллеге.',
            handoff_auto_send: false,
          },
        ],
        profiles: [
          { id: 'specialist-1', full_name: 'Sergey Petrov', email: 'sergey@example.com' },
        ],
        telegram_links: [
          { user_id: 'specialist-1', telegram_id: '123456', telegram_username: 'sergey_portal' },
        ],
      },
    });
    getEmail.mockRejectedValue(new Error('x'));
    qualifyReply.mockResolvedValueOnce({
      isLead: true,
      proposalSeen: true,
      interestSignals: [],
      reason: 'интерес',
      confidence: 0.9,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({ id: 'lead-email', from_address_email: 'lead@leadscorp.ru', body: { text: 'ок' } }),
        threadEmails: [replyEmail({ id: 'out-1', ue_type: 1 })],
        lastOutbound: replyEmail({ id: 'out-1', ue_type: 1 }),
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'lead-email', campaign_id: 'linked-campaign', from_address_email: 'lead@leadscorp.ru', eaccount: 'sender@example.com' } as Partial<Email>)],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);

    expect(postHandoffMessage).toHaveBeenCalledTimes(1);
    const card = postHandoffMessage.mock.calls[0][0] as { callbackData?: string };
    expect(typeof card.callbackData).toBe('string');
    expect(replyToEmail).not.toHaveBeenCalled();
    expect(sendTestEmail).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('instantly_pending_handoffs')[0].status).toBe('pending');
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

  // Security-барьер (адверсариальное ревью 14.07): у управляемых («под ключ»)
  // клиентов ТОЖЕ есть client_instantly_access — их промпт НЕ должен управлять
  // квалификацией проектной кампании (спец-алерты, хэндофф), даже когда
  // проектные критерии пусты.
  it('client criteria NEVER apply to a project-linked campaign, even with empty project criteria', async () => {
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
          { client_user_id: 'client-7', criteria: 'ЛЮБОЙ ответ = лид.' },
        ],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'managed-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(qualifyReply.mock.calls[0][3]).toEqual(
      expect.objectContaining({ leadCriteria: null }),
    );
  });

  it('client criteria are skipped when the self-serve campaign is shared by multiple clients', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        instantly_lead_qualifications: [],
        client_instantly_access: [
          { client_user_id: 'client-A', resource_type: 'campaign', resource_id: 'shared-campaign', instantly_account_id: 'main' },
          { client_user_id: 'client-B', resource_type: 'campaign', resource_id: 'shared-campaign', instantly_account_id: 'main' },
        ],
        client_lead_criteria: [
          { client_user_id: 'client-A', criteria: 'Ничто не лид.' },
        ],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'shared-email', campaign_id: 'shared-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(qualifyReply.mock.calls[0][3]).toEqual(
      expect.objectContaining({ leadCriteria: null }),
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

  // Инцидент 14.07: 503 «Server Overloaded» / «fetch failed» → строка
  // status='error' с instantly_email_id → дедуп блокировал письмо НАВСЕГДА →
  // 2 горячих лида (один с назначенным звонком) потеряны безвозвратно.
  // Транзиентный сбой не должен оставлять блокирующую строку.
  it('transient AI/network failure writes NO row (so the reply is retried next tick)', async () => {
    qualifyReply.mockRejectedValueOnce(
      new Error('AI API 503: {"error":{"message":"Server Overloaded"}}'),
    );
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'transient-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(0);
    // Ключевое: строки НЕТ → на следующем тике письмо не задедуплено.
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toHaveLength(0);
  });

  it('permanent failure DOES write an error row (retry would not help; visibility matters)', async () => {
    qualifyReply.mockRejectedValueOnce(new Error('Cannot find JSON object in AI response'));
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'permanent-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('error');
  });

  it('classifies transient vs permanent failures correctly', async () => {
    const { isTransientQualifyError } = await import('@/lib/instantly/leadQualificationWorker');
    for (const msg of [
      'AI API 503: {"error":{"origin":"provider","message":"Server Overloaded"}}',
      'Upsert failed: TypeError: fetch failed',
      'AI API 429: rate limit exceeded',
      'AI classification failed after retries',
      'connect ETIMEDOUT 1.2.3.4:443',
      'socket hang up',
    ]) {
      expect(isTransientQualifyError(msg)).toBe(true);
    }
    for (const msg of [
      'Cannot find JSON object in AI response',
      'Upsert failed: null value in column "campaign_id" violates not-null constraint',
    ]) {
      expect(isTransientQualifyError(msg)).toBe(false);
    }
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

  it('routes a provider-mislabeled reply by the exact mailbox and parent outbound to the real project specialist', async () => {
    const providerCampaignId = 'ritso-campaign';
    const ownerCampaignId = 'outreachos-campaign';
    const ownerSiblingCampaignId = 'outreachos-campaign-1';
    const ownerMailbox = 'interact@outreach-contact.online';

    const inbound = replyEmail({
      id: 'varlamova-reply',
      campaign_id: providerCampaignId,
      from_address_email: 'varlamova@elma-bpm.com',
      to_address_email_list: ownerMailbox,
      eaccount: ownerMailbox,
      lead: 'partners@elma365.com',
      thread_id: '9c-lxismumVdG63WOaSlSShKCT',
      timestamp_email: '2026-08-21T06:16:03.000Z',
      body: { text: 'Я очень жду презентацию, которую смогу показать внутри.' },
    });
    const ownerOutbound = replyEmail({
      id: 'outreachos-parent-outbound',
      campaign_id: ownerCampaignId,
      from_address_email: ownerMailbox,
      to_address_email_list: 'partners@elma365.com',
      eaccount: ownerMailbox,
      lead: 'partners@elma365.com',
      thread_id: '05-lxismumVdG63WOaSlSShKCT',
      ue_type: 1,
      timestamp_email: '2026-08-20T14:05:43.000Z',
      body: { text: 'Мария, что должно произойти, чтобы мы продолжили разговор?' },
    });
    const ownerEarlierInbound = replyEmail({
      id: 'outreachos-earlier-inbound',
      campaign_id: ownerCampaignId,
      from_address_email: 'varlamova@elma-bpm.com',
      to_address_email_list: ownerMailbox,
      eaccount: ownerMailbox,
      lead: 'partners@elma365.com',
      thread_id: '05-lxismumVdG63WOaSlSShKCT',
      ue_type: 2,
      timestamp_email: '2026-08-20T13:00:00.000Z',
      body: { text: 'Да, пришлите презентацию.' },
    });
    const incidentContext = {
      replyEmail: inbound,
      // Live Instantly behaviour: querying the provider-assigned Ritso
      // campaign returns only the inbound copies. The actual parent outbound
      // remains discoverable only in the mailbox-mapped OutreachOS campaign.
      threadEmails: [inbound],
      lastOutbound: null,
      // Ritso has a different exact sender. The same local-part must not make
      // these mailboxes interchangeable across projects.
      campaignOutboundMailboxes: ['interact@polzacontacts.ru'],
    };

    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-ritso', campaign_id: providerCampaignId, match_source: 'auto' },
          { project_id: 'project-outreachos', campaign_id: ownerSiblingCampaignId, match_source: 'auto' },
          { project_id: 'project-outreachos', campaign_id: ownerCampaignId, match_source: 'auto' },
        ],
        instantly_lead_qualifications: [],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-ritso',
            client: 'Ritso',
            specialist_user_id: 'dmitry-id',
            lead_criteria: 'Ritso: лидом считается запрос расчёта.',
          },
          {
            id: 'project-outreachos',
            client: 'OutreachOS',
            specialist_user_id: 'sergey-id',
            lead_criteria: 'OutreachOS: ожидание презентации считается лидом.',
          },
        ],
        profiles: [
          { id: 'dmitry-id', full_name: 'Дмитрий К.', email: 'dmitry@example.com' },
          { id: 'sergey-id', full_name: 'Сергей Лазуткин', email: 'sergey@example.com' },
        ],
        telegram_links: [
          { user_id: 'dmitry-id', telegram_id: '111', telegram_username: 'dmitry' },
          { user_id: 'sergey-id', telegram_id: '222', telegram_username: 'jacob_brown' },
        ],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    getCampaign.mockImplementation(async (campaignId: string) => {
      if (campaignId === ownerCampaignId) {
        return { id: ownerCampaignId, name: 'OutreachOS Автоаутрич 2', email_list: [ownerMailbox] };
      }
      return {
        id: providerCampaignId,
        name: 'БазаПо1С_Ritso_hh.ru_Часть2',
        email_list: ['interact@polzacontacts.ru'],
      };
    });
    getAccountCampaignMappings.mockImplementation(async (mailbox: string) =>
      mailbox.toLowerCase() === ownerMailbox
        ? [
            { campaign_id: ownerCampaignId, status: 1, timestamp_created: '2026-07-01T00:00:00.000Z' },
            { campaign_id: ownerSiblingCampaignId, status: 1, timestamp_created: '2026-06-30T00:00:00.000Z' },
          ]
        : [],
    );
    fetchThreadContext.mockImplementation(async (campaignId: string) =>
      campaignId === providerCampaignId ? incidentContext : null,
    );
    qualifyReply.mockResolvedValue({
      isLead: true,
      customCriteriaMatched: false,
      proposalSeen: true,
      interestSignals: ['requested_materials'],
      reason: 'Ждёт обещанную презентацию.',
      confidence: 0.98,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: incidentContext,
    });
    listEmails.mockImplementation(async (params: {
      campaign_id?: string;
      email_type?: string;
      search?: string;
    }) => {
      // Main polling surface: provider mislabeled the inbound as Ritso.
      if (!params.campaign_id) return { items: [inbound], next_starting_after: null };
      // Ownership evidence must be recovered separately from OutreachOS.
      if (
        params.campaign_id === ownerCampaignId &&
        (params.email_type === 'sent' || params.search)
      ) {
        return { items: [ownerOutbound, ownerEarlierInbound], next_starting_after: null };
      }
      return { items: [], next_starting_after: null };
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(getAccountCampaignMappings).toHaveBeenCalledWith(ownerMailbox, {
      accountId: 'main',
    });

    const qualification = mockInstantlyDb!.getRows('instantly_lead_qualifications')[0];
    const notificationRecipients = mockMainDb!
      .getRows('notifications')
      .map((row) => row.user_id);
    const telegramPayload = sendLeadTelegramAlert.mock.calls[0]?.[0] as
      | { campaignId?: string; specialistMentions?: Array<{ userId: string }> }
      | undefined;

    expect({
      processed,
      qualifiedCampaign: qualifyReply.mock.calls[0]?.[0],
      leadCriteria: qualifyReply.mock.calls[0]?.[3]?.leadCriteria,
      contextReplyCampaign:
        qualifyReply.mock.calls[0]?.[3]?.prefetchedContext?.replyEmail?.campaign_id,
      contextParentCampaign:
        qualifyReply.mock.calls[0]?.[3]?.prefetchedContext?.lastOutbound?.campaign_id,
      contextEmailIds:
        qualifyReply.mock.calls[0]?.[3]?.prefetchedContext?.threadEmails?.map(
          (email: Email) => email.id,
        ),
      qualificationCampaign: qualification?.campaign_id,
      notificationRecipients,
      telegramCampaign: telegramPayload?.campaignId,
      telegramRecipients: telegramPayload?.specialistMentions?.map((mention) => mention.userId),
    }).toEqual({
      processed: 1,
      qualifiedCampaign: ownerCampaignId,
      leadCriteria: 'OutreachOS: ожидание презентации считается лидом.',
      contextReplyCampaign: ownerCampaignId,
      contextParentCampaign: ownerCampaignId,
      contextEmailIds: [
        'outreachos-earlier-inbound',
        'outreachos-parent-outbound',
        'varlamova-reply',
      ],
      qualificationCampaign: ownerCampaignId,
      notificationRecipients: ['sergey-id'],
      telegramCampaign: ownerCampaignId,
      telegramRecipients: ['sergey-id'],
    });
  });

  it('keeps an exact-mailbox conflict between two project campaigns in needs_review when no parent outbound matches', async () => {
    installMailboxOwnershipConflictFixture();

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect({
      processed,
      statuses: mockInstantlyDb!
        .getRows('instantly_lead_qualifications')
        .map((row) => row.status),
      aiCalls: qualifyReply.mock.calls.length,
      telegramCalls: sendLeadTelegramAlert.mock.calls.length,
      notificationRecipients: mockMainDb!
        .getRows('notifications')
        .map((row) => row.user_id),
    }).toEqual({
      processed: 1,
      statuses: ['needs_review'],
      aiCalls: 0,
      telegramCalls: 0,
      notificationRecipients: [],
    });
  });

  it('keeps a mailbox configured in both the provider and another project in needs_review', async () => {
    const { providerCampaignId, candidateCampaignIds } =
      installMailboxOwnershipConflictFixture();
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: providerCampaignId, status: 1 },
      { campaign_id: candidateCampaignIds[0], status: 1 },
    ]);

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect({
      statuses: mockInstantlyDb!
        .getRows('instantly_lead_qualifications')
        .map((row) => row.status),
      aiCalls: qualifyReply.mock.calls.length,
      telegramCalls: sendLeadTelegramAlert.mock.calls.length,
    }).toEqual({
      statuses: ['needs_review'],
      aiCalls: 0,
      telegramCalls: 0,
    });
  });

  it('does not use a same-subject outbound addressed to another lead as ownership proof', async () => {
    const { candidateCampaignIds, ownerMailbox, inbound } =
      installMailboxOwnershipConflictFixture();
    inbound.subject = 'Re: Обсудим поставку';
    inbound.timestamp_email = '2026-08-21T10:00:00.000Z';
    const wrongRecipientOutbound = replyEmail({
      id: 'wrong-recipient-outbound',
      campaign_id: candidateCampaignIds[0],
      ue_type: 1,
      eaccount: ownerMailbox,
      lead: 'another.lead@example.com',
      to_address_email_list: 'another.lead@example.com',
      thread_id: 'unrelated-thread',
      subject: 'Обсудим поставку',
      timestamp_email: '2026-08-20T10:00:00.000Z',
    });
    listEmails.mockImplementation(async (params: { campaign_id?: string }) => {
      if (!params.campaign_id) return { items: [inbound], next_starting_after: null };
      return {
        items: params.campaign_id === candidateCampaignIds[0]
          ? [wrongRecipientOutbound]
          : [],
        next_starting_after: null,
      };
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect({
      statuses: mockInstantlyDb!
        .getRows('instantly_lead_qualifications')
        .map((row) => row.status),
      aiCalls: qualifyReply.mock.calls.length,
      telegramCalls: sendLeadTelegramAlert.mock.calls.length,
    }).toEqual({
      statuses: ['needs_review'],
      aiCalls: 0,
      telegramCalls: 0,
    });
  });

  it('resolves more than eight mailbox campaigns when they all belong to one project', async () => {
    const providerCampaignId = 'provider-campaign';
    const candidateCampaignIds = Array.from(
      { length: 9 },
      (_, index) => `same-project-campaign-${index + 1}`,
    );
    const mailbox = 'owner@single-project.example';
    const inbound = replyEmail({
      id: 'many-campaigns-reply',
      campaign_id: providerCampaignId,
      eaccount: mailbox,
      to_address_email_list: mailbox,
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'provider-project', campaign_id: providerCampaignId },
          ...candidateCampaignIds.map((campaign_id) => ({
            project_id: 'single-owner-project',
            campaign_id,
          })),
        ],
      },
    });
    getAccountCampaignMappings.mockResolvedValue(
      candidateCampaignIds.map((campaign_id) => ({ campaign_id, status: 1 })),
    );
    fetchThreadContext.mockResolvedValue({
      replyEmail: inbound,
      threadEmails: [inbound],
      lastOutbound: null,
    });
    listEmails.mockResolvedValue({ items: [], next_starting_after: null });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail: 'lead@example.com',
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'resolved',
      effectiveCampaignId: candidateCampaignIds[0],
      effectiveProjectId: 'single-owner-project',
    }));
  });

  it('does not ignore a competing self-serve owner when a mailbox also maps to a project', async () => {
    const providerCampaignId = 'provider-project-campaign';
    const projectCampaignId = 'mapped-project-campaign';
    const selfServeCampaignId = 'mapped-self-serve-campaign';
    const mailbox = 'shared-owner@example.com';
    const inbound = replyEmail({
      id: 'project-self-serve-conflict',
      campaign_id: providerCampaignId,
      eaccount: mailbox,
      to_address_email_list: mailbox,
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'provider-project', campaign_id: providerCampaignId },
          { project_id: 'mapped-project', campaign_id: projectCampaignId },
        ],
        client_instantly_access: [
          {
            client_user_id: 'self-serve-client',
            resource_type: 'campaign',
            resource_id: selfServeCampaignId,
          },
        ],
      },
    });
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: projectCampaignId, status: 1 },
      { campaign_id: selfServeCampaignId, status: 1 },
    ]);
    fetchThreadContext.mockResolvedValue({
      replyEmail: inbound,
      threadEmails: [inbound],
      lastOutbound: null,
    });
    listEmails.mockResolvedValue({ items: [], next_starting_after: null });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail: 'lead@example.com',
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous' }));
  });

  it('defers mailbox ownership resolution without writing a row when the exact mapping lookup fails transiently', async () => {
    installMailboxOwnershipConflictFixture({
      mappingError: new Error('Instantly API 503: Service Unavailable'),
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect({
      qualificationRows: mockInstantlyDb!.getRows('instantly_lead_qualifications').length,
      aiCalls: qualifyReply.mock.calls.length,
      telegramCalls: sendLeadTelegramAlert.mock.calls.length,
      notificationRecipients: mockMainDb!
        .getRows('notifications')
        .map((row) => row.user_id),
    }).toEqual({
      qualificationRows: 0,
      aiCalls: 0,
      telegramCalls: 0,
      notificationRecipients: [],
    });
  });

  // Исторический outbound может остаться на старом lookalike-ящике после
  // ротации. Решение принимает не похожий local-part/domain, а живая exact
  // mapping конфигурация: физически принявший ящик назначен этой кампании.
  it('trusts an exact current mailbox mapping over a different historical lookalike mailbox', async () => {
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
      getAccountCampaignMappings.mockResolvedValue([
        { campaign_id: 'linked-campaign', status: 1 },
      ]);
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

/**
 * Сироты (инцидент 11.08.2026): письмо пришло через Others-контур вотчдога,
 * Instantly его к кампании НЕ привязал. qualifyOneReply получает
 * opts.outOfCampaign и обязан: (а) прокинуть флаг + eaccount в DM клиенту
 * (buildClientReplyMessage замокан как JSON.stringify(data) — видим сырой
 * payload), (б) записать новые колонки reply_out_of_campaign/eaccount во ВСЕХ
 * upsert'ах (lead / needs_review — единообразно).
 */
describe('qualifyOneReply — сирота (outOfCampaign) из Others-контура', () => {
  beforeEach(() => {
    jest.resetModules();
    getLeadsByEmail.mockReset().mockResolvedValue([]);
    getCampaign.mockReset().mockResolvedValue({
      id: 'self-serve-campaign',
      name: 'OutreachOS Автоаутрич 2',
    });
    // Self-serve campaigns intentionally have no project_* link. A live exact
    // mapping to the provider campaign must therefore keep the provider owner,
    // not turn every reply into an ownership ambiguity.
    getAccountCampaignMappings.mockReset().mockResolvedValue([
      { campaign_id: 'self-serve-campaign', status: 1 },
    ]);
    getEmail.mockReset();
    postHandoffMessage.mockReset().mockResolvedValue(555);
    editHandoffMessage.mockReset().mockResolvedValue(undefined);
    delete process.env.LEAD_HANDOFF_ENABLED;
    sendLeadTelegramAlert.mockReset().mockResolvedValue({ sent: true, messageId: 42 });
    sendClientReplyTelegram.mockReset().mockResolvedValue({ messageId: 7 });
    fetchBriefByCampaign.mockReset().mockResolvedValue(null);
    fetchThreadContext.mockReset().mockResolvedValue(null);
    qualifyReply.mockReset().mockResolvedValue({
      isLead: true,
      proposalSeen: true,
      interestSignals: ['asked_for_call'],
      reason: 'Просит созвон',
      confidence: 0.92,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({ id: 'stray-email-1', body: { text: 'Давайте созвонимся' } }),
        threadEmails: [],
        lastOutbound: null,
      },
    });

    process.env.OPENROUTER_INSTANTLY_LEAD_API_KEY = 'test-ai-key';

    mockMainDb = createMockSupabase({
      tables: { projects: [], profiles: [], telegram_links: [], notifications: [], deadline_notification_log: [] },
    });
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
        client_reply_telegram_links: [
          { client_user_id: 'client-7', chat_id: 111, enabled: true },
        ],
      },
    });
  });

  it('пробрасывает outOfCampaign + eaccount в DM и пишет новые колонки в lead-upsert', async () => {
    const { qualifyOneReply } = await import('@/lib/instantly/leadQualificationWorker');
    await qualifyOneReply(
      mockInstantlyDb! as unknown as Parameters<typeof qualifyOneReply>[0],
      replyEmail({
        id: 'stray-email-1',
        campaign_id: 'self-serve-campaign',
        eaccount: 'sales@clientmail.ru',
        body: { text: 'Давайте созвонимся' },
      }),
      'test-ai-key',
      'main',
      null,
      { clientDmOnlyOnLead: true, outOfCampaign: true },
    );

    // DM ушёл (вердикт lead), и в payload — честный флаг сироты + ящик.
    expect(sendClientReplyTelegram).toHaveBeenCalledTimes(1);
    const html = String(sendClientReplyTelegram.mock.calls[0][1]);
    expect(html).toContain('"outOfCampaign":true');
    expect(html).toContain('"eaccount":"sales@clientmail.ru"');

    // Основной upsert пишет новые колонки.
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        instantly_email_id: 'stray-email-1',
        status: 'lead',
        reply_out_of_campaign: true,
        eaccount: 'sales@clientmail.ru',
      }),
    );
  });

  it('без opts (main-poll контур) → reply_out_of_campaign=false, eaccount из письма', async () => {
    const { qualifyOneReply } = await import('@/lib/instantly/leadQualificationWorker');
    await qualifyOneReply(
      mockInstantlyDb! as unknown as Parameters<typeof qualifyOneReply>[0],
      replyEmail({ id: 'linked-1', campaign_id: 'self-serve-campaign', eaccount: 'sales@clientmail.ru' }),
      'test-ai-key',
      'main',
      null,
    );

    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        reply_out_of_campaign: false,
        eaccount: 'sales@clientmail.ru',
      }),
    );
    // DM — прежний формат данных: сироты нет.
    expect(sendClientReplyTelegram).toHaveBeenCalledTimes(1);
    const html = String(sendClientReplyTelegram.mock.calls[0][1]);
    expect(html).toContain('"outOfCampaign":false');
  });

  it('письмо без eaccount → колонка eaccount=null (не пустая строка)', async () => {
    const { qualifyOneReply } = await import('@/lib/instantly/leadQualificationWorker');
    await qualifyOneReply(
      mockInstantlyDb! as unknown as Parameters<typeof qualifyOneReply>[0],
      replyEmail({ id: 'no-eaccount', campaign_id: 'self-serve-campaign', eaccount: undefined }),
      'test-ai-key',
      'main',
      null,
    );

    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].eaccount).toBeNull();
  });

  it('guard-upsert («слепое» письмо → needs_review) тоже пишет новые колонки (единообразно)', async () => {
    const { qualifyOneReply } = await import('@/lib/instantly/leadQualificationWorker');
    await qualifyOneReply(
      mockInstantlyDb! as unknown as Parameters<typeof qualifyOneReply>[0],
      replyEmail({
        id: 'stray-bcc',
        campaign_id: 'self-serve-campaign',
        from_address_email: 'head_market@nais.ru',
        eaccount: 'sales@clientmail.ru',
        // Нашего ящика нет в To → stray-guard ДО ИИ.
        to_address_email_list: 'someone@else.ru',
      }),
      'test-ai-key',
      'main',
      null,
      { clientDmOnlyOnLead: true, outOfCampaign: true },
    );

    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendClientReplyTelegram).not.toHaveBeenCalled();
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        status: 'needs_review',
        reply_out_of_campaign: true,
        eaccount: 'sales@clientmail.ru',
      }),
    );
  });

  it('окно «код без миграции»: проба колонок упала → пишем БЕЗ новых колонок, DM уходит честным', async () => {
    // Пересобираем instantly-мок: ЛЮБОЙ select по instantly_lead_qualifications
    // падает (как PostgREST 42703 до применения миграции 20260812_0001). Проба
    // strayColumnsSupported видит ошибку → колонки из payload'ов вырезаются.
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
        client_reply_telegram_links: [
          { client_user_id: 'client-7', chat_id: 111, enabled: true },
        ],
      },
      errorSelects: {
        instantly_lead_qualifications: {
          columnsInclude: 'reply_out_of_campaign',
          message: 'column instantly_lead_qualifications.reply_out_of_campaign does not exist',
        },
      },
    });

    const { qualifyOneReply } = await import('@/lib/instantly/leadQualificationWorker');
    await qualifyOneReply(
      mockInstantlyDb! as unknown as Parameters<typeof qualifyOneReply>[0],
      replyEmail({
        id: 'stray-pre-migration',
        campaign_id: 'self-serve-campaign',
        eaccount: 'team@outreach-contact.ru',
        body: { text: 'Давайте созвонимся' },
      }),
      'test-ai-key',
      'main',
      null,
      { clientDmOnlyOnLead: true, outOfCampaign: true },
    );

    // Письмо обработано штатно (status=lead, НЕ error-строка — дедуп не
    // заблокирован навсегда), и в строке нет новых колонок — иначе upsert бы упал.
    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('lead');
    expect(rows[0]).not.toHaveProperty('reply_out_of_campaign');
    expect(rows[0]).not.toHaveProperty('eaccount');

    // DM при этом уходит честным: флаг/ящик едут из памяти, не из БД.
    expect(sendClientReplyTelegram).toHaveBeenCalledTimes(1);
    const html = String(sendClientReplyTelegram.mock.calls[0][1]);
    expect(html).toContain('"outOfCampaign":true');
    expect(html).toContain('"eaccount":"team@outreach-contact.ru"');
  });
});
