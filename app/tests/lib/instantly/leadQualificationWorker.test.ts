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

function installMailboxOwnershipConflictFixture(options?: {
  mappingError?: Error;
  webhookRequeueError?: string;
  qualificationInsertError?: { code: string; message: string };
  qualificationUpsertError?: { code: string; message: string };
}) {
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
    errorUpdates: options?.webhookRequeueError
      ? {
          instantly_webhook_events: {
            message: options.webhookRequeueError,
            patchIncludes: { processed: false },
          },
        }
      : undefined,
    errorInserts: options?.qualificationInsertError
      ? { instantly_lead_qualifications: options.qualificationInsertError }
      : undefined,
    errorUpserts: options?.qualificationUpsertError
      ? { instantly_lead_qualifications: options.qualificationUpsertError }
      : undefined,
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

function installCurrentProviderWithStaleMailboxOwnersFixture(options?: {
  strongProviderParent?: boolean;
  providerProjectIds?: string[];
  incompleteWorkspaceSearch?: boolean;
  currentSiblingWithDuplicateProviderOwner?: boolean;
}) {
  const providerCampaignId = 'enagency-current-campaign';
  const providerProjectIds = options?.providerProjectIds ?? ['project-enagency'];
  const staleCampaignIds = Array.from(
    { length: 6 },
    (_, index) => `stale-mailbox-campaign-${index + 1}`,
  );
  const mailbox = 'julia@enagency.example';
  const leadEmail = 'decision-maker@prospect.example';
  const inbound = replyEmail({
    id: 'enagency-reply',
    campaign_id: providerCampaignId,
    from_address_email: leadEmail,
    to_address_email_list: mailbox,
    eaccount: mailbox,
    lead: leadEmail,
    thread_id: '9c-enagency-thread',
    timestamp_email: '2026-08-24T14:02:00.000Z',
    body: { text: 'Interested in exploring this further, please send your proposal.' },
  });
  const parent = replyEmail({
    id: 'enagency-provider-parent',
    campaign_id: providerCampaignId,
    from_address_email: mailbox,
    to_address_email_list: leadEmail,
    eaccount: mailbox,
    lead: leadEmail,
    thread_id: '05-enagency-thread',
    ue_type: 1,
    timestamp_email: '2026-08-23T10:00:00.000Z',
    body: { text: 'Here is our detailed proposal and a concrete next step for your team.' },
  });
  const providerContext = {
    replyEmail: inbound,
    threadEmails: options?.strongProviderParent ? [parent, inbound] : [inbound],
    lastOutbound: options?.strongProviderParent ? parent : null,
    campaignOutboundMailboxes: [mailbox],
  };

  mockInstantlyDb = createMockSupabase({
    tables: {
      project_instantly_campaigns: [
        ...providerProjectIds.map((project_id) => ({
          project_id,
          campaign_id: providerCampaignId,
          match_source: 'auto',
        })),
        ...staleCampaignIds.map((campaign_id, index) => ({
          project_id: `project-stale-${index + 1}`,
          campaign_id,
          match_source: 'auto',
        })),
        ...(options?.currentSiblingWithDuplicateProviderOwner
          ? [{
              project_id: providerProjectIds[0],
              campaign_id: staleCampaignIds[0],
              match_source: 'auto',
            }]
          : []),
      ],
    },
  });
  getAccountCampaignMappings.mockResolvedValue([
    {
      campaign_id: providerCampaignId,
      status: 1,
      timestamp_created: '2026-08-20T00:00:00.000Z',
    },
    ...staleCampaignIds.map((campaign_id, index) => ({
      campaign_id,
      status: options?.currentSiblingWithDuplicateProviderOwner && index === 0 ? 1 : 3,
      timestamp_created: `2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    })),
  ]);
  fetchThreadContext.mockResolvedValue(providerContext);
  listEmails.mockImplementation(async (params: {
    search?: string;
    email_type?: string;
    starting_after?: string;
  }) => {
    if (params.search && options?.incompleteWorkspaceSearch) {
      return {
        items: [],
        next_starting_after: params.starting_after ? 'ownership-page-3' : 'ownership-page-2',
      };
    }
    return { items: [], next_starting_after: null };
  });

  return {
    providerCampaignId,
    providerContext,
    staleCampaignIds,
    mailbox,
    leadEmail,
    inbound,
  };
}

const OWNERSHIP_REVIEW_REASON =
  'Не удалось однозначно определить проект-владельца ответа: mailbox history is ambiguous. ' +
  'Автоматические уведомления и передача отключены до ручной проверки.';

function ownershipReviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ownership-review-qualification',
    campaign_id: 'linked-campaign',
    campaign_name: 'Кампания Новикова',
    lead_email: 'lead@example.com',
    thread_id: 'ownership-thread',
    reply_subject: 'Re: proposal',
    reply_preview: 'Interested',
    reply_body: 'Interested',
    status: 'needs_review',
    proposal_seen: false,
    interest_signals: [],
    ai_reason: OWNERSHIP_REVIEW_REASON,
    ai_confidence: 0,
    instantly_email_id: 'ownership-email',
    reply_timestamp: '2026-08-24T12:00:00.000Z',
    created_at: '2026-08-24T12:00:05.000Z',
    updated_at: '2026-08-24T12:00:05.000Z',
    ...overrides,
  };
}

function installOwnershipReviewRetryFixture(options?: {
  verdict?: 'lead' | 'not_lead';
  ambiguous?: boolean;
  enforceQueryWindows?: boolean;
  row?: Record<string, unknown>;
}) {
  const mailbox = 'julia@enagency.example';
  const inbound = replyEmail({
    id: 'ownership-email',
    campaign_id: 'linked-campaign',
    from_address_email: 'lead@example.com',
    to_address_email_list: mailbox,
    eaccount: mailbox,
    lead: 'lead@example.com',
    thread_id: '9c-ownership-thread',
    timestamp_email: '2026-08-24T12:00:00.000Z',
    body: { text: 'Interested in exploring this further, please send your proposal.' },
  });
  const parent = replyEmail({
    id: 'ownership-parent',
    campaign_id: 'linked-campaign',
    from_address_email: mailbox,
    to_address_email_list: 'lead@example.com',
    eaccount: mailbox,
    lead: 'lead@example.com',
    thread_id: '05-ownership-thread',
    ue_type: 1,
    timestamp_email: '2026-08-23T10:00:00.000Z',
    body: { text: 'Our proposal can reduce your acquisition costs. Shall we discuss it?' },
  });
  const context = {
    replyEmail: inbound,
    threadEmails: options?.ambiguous ? [inbound] : [parent, inbound],
    lastOutbound: options?.ambiguous ? null : parent,
    campaignOutboundMailboxes: [mailbox],
  };
  const links = [
    { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
    ...(options?.ambiguous
      ? [{ project_id: 'project-2', campaign_id: 'other-owner-campaign', match_source: 'auto' }]
      : []),
  ];

  mockInstantlyDb = createMockSupabase({
    enforceQueryWindows: options?.enforceQueryWindows,
    tables: {
      project_instantly_campaigns: links,
      project_period_instantly_campaigns: [],
      client_instantly_access: [],
      client_forwarded_leads: [],
      instantly_lead_qualifications: [ownershipReviewRow(options?.row)],
    },
  });
  mockMainDb = createMockSupabase({
    tables: {
      projects: [
        { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
        ...(options?.ambiguous
          ? [{ id: 'project-2', client: 'Other client', specialist_user_id: 'specialist-2' }]
          : []),
      ],
      profiles: [
        { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
        ...(options?.ambiguous
          ? [{ id: 'specialist-2', full_name: 'Другой специалист', email: 'other@example.com' }]
          : []),
      ],
      telegram_links: [
        { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
      ],
      notifications: [],
      deadline_notification_log: [],
    },
  });

  getEmail.mockResolvedValue(inbound);
  getAccountCampaignMappings.mockResolvedValue(
    options?.ambiguous
      ? [
          { campaign_id: 'linked-campaign', status: 1, timestamp_created: '2026-08-20T00:00:00Z' },
          { campaign_id: 'other-owner-campaign', status: 1, timestamp_created: '2026-08-20T00:00:01Z' },
        ]
      : [{ campaign_id: 'linked-campaign', status: 1, timestamp_created: '2026-08-20T00:00:00Z' }],
  );
  fetchThreadContext.mockResolvedValue(context);
  listEmails.mockResolvedValue({ items: [], next_starting_after: null });

  const isLead = options?.verdict !== 'not_lead';
  qualifyReply.mockResolvedValue({
    isLead,
    customCriteriaMatched: false,
    proposalSeen: true,
    interestSignals: isLead ? ['requested_proposal'] : [],
    reason: isLead ? 'Просит предложение после подтверждённого интереса.' : 'Нет коммерческого интереса.',
    confidence: 0.95,
    needsReview: false,
    objectionHandleable: false,
    objectionDraft: null,
    threadContext: context,
  });

  return { inbound };
}

function installLeadNotificationRecoveryFixture(options?: {
  logRow?: Record<string, unknown>;
  notificationRows?: Array<Record<string, unknown>>;
}) {
  const qualification = ownershipReviewRow({
    id: 'recoverable-lead-qualification',
    status: 'lead',
    ai_reason: 'Просит коммерческое предложение.',
    ai_confidence: 0.96,
    created_at: '2026-08-24T17:00:00.000Z',
    updated_at: '2026-08-24T17:00:00.000Z',
  });
  mockInstantlyDb = createMockSupabase({
    tables: {
      project_instantly_campaigns: [
        { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
      ],
      project_period_instantly_campaigns: [],
      instantly_lead_qualifications: [qualification],
    },
  });
  mockMainDb = createMockSupabase({
    tables: {
      projects: [
        { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
      ],
      profiles: [
        { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
      ],
      telegram_links: [
        { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
      ],
      notifications: options?.notificationRows ?? [],
      deadline_notification_log: options?.logRow ? [options.logRow] : [],
    },
  });
}

async function withWebhookDrainEnabled<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED;
  process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED = '1';
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED;
    else process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED = previous;
  }
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

  it('keeps the committed project snapshot when ownership changes immediately after persistence', async () => {
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-1', client: 'Owner A', specialist_user_id: 'specialist-1' },
          { id: 'project-2', client: 'Owner B', specialist_user_id: 'specialist-2' },
        ],
        profiles: [
          { id: 'specialist-1', full_name: 'Specialist A', email: 'a@example.com' },
          { id: 'specialist-2', full_name: 'Specialist B', email: 'b@example.com' },
        ],
        telegram_links: [
          { user_id: 'specialist-1', telegram_id: '111', telegram_username: 'specialist_a' },
          { user_id: 'specialist-2', telegram_id: '222', telegram_username: 'specialist_b' },
        ],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    const instantlyDb = mockInstantlyDb!;
    const originalFrom = instantlyDb.from.bind(instantlyDb);
    let ownershipChanged = false;
    instantlyDb.from = ((table: string) => {
      const builder = originalFrom(table);
      if (table !== 'instantly_lead_qualifications') return builder;
      const originalUpsert = builder.upsert.bind(builder);
      builder.upsert = ((...args: Parameters<typeof builder.upsert>) => {
        const upsertBuilder = originalUpsert(...args);
        const originalMaybeSingle = upsertBuilder.maybeSingle.bind(upsertBuilder);
        upsertBuilder.maybeSingle = async () => {
          const result = await originalMaybeSingle();
          if (!ownershipChanged && result.data) {
            ownershipChanged = true;
            await originalFrom('project_instantly_campaigns')
              .delete()
              .eq('project_id', 'project-1')
              .eq('campaign_id', 'linked-campaign');
            await originalFrom('project_instantly_campaigns').insert({
              project_id: 'project-2',
              campaign_id: 'linked-campaign',
              match_source: 'auto-text',
            });
          }
          return result;
        };
        return upsertBuilder;
      }) as typeof builder.upsert;
      return builder;
    }) as typeof instantlyDb.from;
    qualifyReply.mockResolvedValueOnce({
      isLead: true,
      proposalSeen: true,
      interestSignals: ['asked_for_call'],
      reason: 'Просит созвон',
      confidence: 0.94,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({
          id: 'owner-race-email',
          body: { text: 'Давайте созвонимся' },
        }),
        threadEmails: [],
        lastOutbound: null,
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'owner-race-email', campaign_id: 'linked-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
      expect.objectContaining({
        status: 'lead',
        qualified_project_id: 'project-1',
        qualified_project_owner_proven: true,
      }),
    );
    expect(mockInstantlyDb!.getRows('project_lead_board_rows')[0]).toEqual(
      expect.objectContaining({ project_id: 'project-1' }),
    );
    expect(sendLeadTelegramAlert).toHaveBeenCalledWith(expect.objectContaining({
      clientName: 'Owner A',
      specialistMentions: [expect.objectContaining({ userId: 'specialist-1' })],
    }));
    expect(sendLeadTelegramAlert).not.toHaveBeenCalledWith(expect.objectContaining({
      specialistMentions: [expect.objectContaining({ userId: 'specialist-2' })],
    }));
  });

  it('defers without side effects when the database rejects a snapshot changed during AI', async () => {
    const instantlyDb = mockInstantlyDb!;
    const originalFrom = instantlyDb.from.bind(instantlyDb);
    let rejectSnapshot = true;
    instantlyDb.from = ((table: string) => {
      const builder = originalFrom(table);
      if (table !== 'instantly_lead_qualifications') return builder;
      const originalUpsert = builder.upsert.bind(builder);
      builder.upsert = ((rows: unknown, options?: unknown) => {
        const row = (Array.isArray(rows) ? rows[0] : rows) as Record<string, unknown>;
        if (rejectSnapshot && row.qualified_project_owner_proven === true) {
          rejectSnapshot = false;
          return {
            select: () => ({
              maybeSingle: async () => ({
                data: null,
                error: {
                  code: '40001',
                  message: 'qualification_project_ownership_changed',
                },
              }),
            }),
          } as unknown as ReturnType<typeof originalUpsert>;
        }
        return originalUpsert(
          rows as Parameters<typeof originalUpsert>[0],
          options as Parameters<typeof originalUpsert>[1],
        );
      }) as typeof builder.upsert;
      return builder;
    }) as typeof instantlyDb.from;
    qualifyReply.mockResolvedValueOnce({
      isLead: true,
      proposalSeen: true,
      interestSignals: ['asked_for_call'],
      reason: 'Просит созвон',
      confidence: 0.94,
      needsReview: false,
      objectionHandleable: false,
      objectionDraft: null,
      threadContext: {
        replyEmail: replyEmail({ id: 'owner-cas-email', body: { text: 'Созвонимся' } }),
        threadEmails: [],
        lastOutbound: null,
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'owner-cas-email', campaign_id: 'linked-campaign' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'owner-cas-email',
        status: 'needs_review',
        ai_reason: expect.stringContaining('Reply ownership deferred'),
      }),
    ]);
    expect(mockInstantlyDb!.getRows('project_lead_board_rows')).toHaveLength(0);
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
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

  it('handoff fails closed when legacy and period links point to different projects', async () => {
    process.env.LEAD_HANDOFF_ENABLED = '1';
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-a', campaign_id: 'linked-campaign' },
        ],
        project_period_instantly_campaigns: [
          { project_id: 'project-b', campaign_id: 'linked-campaign' },
        ],
        instantly_pending_handoffs: [],
        client_forwarded_leads: [],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-a',
            client: 'Client A',
            specialist_user_id: 'specialist-a',
            handoff_email: 'client-a@example.com',
            handoff_legend: 'Передаю клиенту A.',
            handoff_auto_send: true,
          },
          {
            id: 'project-b',
            client: 'Client B',
            specialist_user_id: 'specialist-b',
            handoff_email: 'client-b@example.com',
            handoff_legend: 'Передаю клиенту B.',
            handoff_auto_send: true,
          },
        ],
        profiles: [
          { id: 'specialist-a', full_name: 'Специалист A' },
          { id: 'specialist-b', full_name: 'Специалист B' },
        ],
      },
    });
    const { maybePostLeadHandoff } = await import('@/lib/instantly/leadQualificationWorker');

    await maybePostLeadHandoff({
      instantlyDb: mockInstantlyDb! as unknown as Parameters<typeof maybePostLeadHandoff>[0]['instantlyDb'],
      qualificationId: 'qualification-with-two-owners',
      campaignId: 'linked-campaign',
      reply: replyEmail({ id: 'lead-email', eaccount: 'sender@example.com' }),
      leadEmail: 'lead@example.com',
      leadName: 'Lead',
      campaignName: 'Campaign',
      leadReplyText: 'Интересно',
      lastOutboundText: 'Наше предложение',
      apiKey: 'test-ai-key',
      accountId: 'main',
    });

    expect(postHandoffMessage).not.toHaveBeenCalled();
    expect(replyToEmail).not.toHaveBeenCalled();
    expect(sendTestEmail).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('instantly_pending_handoffs')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('client_forwarded_leads')).toHaveLength(0);
  });

  it('handoff has no side effects when either project-link lookup fails', async () => {
    process.env.LEAD_HANDOFF_ENABLED = '1';
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-a', campaign_id: 'linked-campaign' },
        ],
        project_period_instantly_campaigns: [],
        instantly_pending_handoffs: [],
        client_forwarded_leads: [],
      },
      errorTables: {
        project_period_instantly_campaigns: 'period link lookup unavailable',
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{
          id: 'project-a',
          client: 'Client A',
          specialist_user_id: 'specialist-a',
          handoff_email: 'client-a@example.com',
          handoff_legend: 'Передаю клиенту A.',
          handoff_auto_send: true,
        }],
        profiles: [{ id: 'specialist-a', full_name: 'Специалист A' }],
      },
    });
    const { maybePostLeadHandoff } = await import('@/lib/instantly/leadQualificationWorker');

    await maybePostLeadHandoff({
      instantlyDb: mockInstantlyDb! as unknown as Parameters<typeof maybePostLeadHandoff>[0]['instantlyDb'],
      qualificationId: 'qualification-with-link-error',
      campaignId: 'linked-campaign',
      reply: replyEmail({ id: 'lead-email', eaccount: 'sender@example.com' }),
      leadEmail: 'lead@example.com',
      leadName: null,
      campaignName: 'Campaign',
      leadReplyText: 'Интересно',
      lastOutboundText: 'Наше предложение',
      apiKey: 'test-ai-key',
      accountId: 'main',
    });

    expect(postHandoffMessage).not.toHaveBeenCalled();
    expect(replyToEmail).not.toHaveBeenCalled();
    expect(sendTestEmail).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('instantly_pending_handoffs')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('client_forwarded_leads')).toHaveLength(0);
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

  it('does not treat historical forwarded addresses from a previous project owner as the current client', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-new-owner', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        project_period_instantly_campaigns: [],
        instantly_lead_qualifications: [],
        client_forwarded_leads: [
          { campaign_id: 'linked-campaign', client_email: 'old.client@former-owner.example' },
        ],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{
          id: 'project-new-owner',
          client: 'New owner',
          specialist_user_id: null,
          handoff_email: 'current.client@new-owner.example',
        }],
        profiles: [],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({
        id: 'former-owner-address-reply',
        campaign_id: 'linked-campaign',
        from_address_email: 'old.client@former-owner.example',
      })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'former-owner-address-reply',
        ai_reason: 'Не лид',
      }),
    ]);
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
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{
          id: 'project-1',
          client: 'Acme',
          specialist_user_id: 'specialist-1',
          // Exact current-project proof; the historical forwarded row alone
          // is intentionally insufficient after an ownership transfer.
          handoff_email: 'client.person@gmail.com',
        }],
        profiles: [
          { id: 'specialist-1', full_name: 'Sergey Petrov', email: 'sergey@example.com' },
        ],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
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

  it('invalidates criteria and brief caches when the proven project owner changes inside the TTL', async () => {
    const seedOwner = (projectId: string, suffix: string, emailId: string) => {
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: projectId, campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          instantly_lead_qualifications: [],
        },
      });
      mockMainDb = createMockSupabase({
        tables: {
          projects: [{
            id: projectId,
            client: `Client ${suffix}`,
            specialist_user_id: null,
            lead_criteria: `Критерии ${suffix}`,
          }],
          profiles: [],
          telegram_links: [],
          notifications: [],
          deadline_notification_log: [],
        },
      });
      listEmails.mockResolvedValue({
        items: [replyEmail({ id: emailId, campaign_id: 'linked-campaign', eaccount: undefined })],
        next_starting_after: null,
      });
    };

    seedOwner('project-owner-a', 'A', 'owner-a-reply');
    fetchBriefByCampaign.mockImplementation(async (
      _campaignId: string,
      options?: { projectId?: string | null },
    ) => options?.projectId ? `Бриф ${options.projectId}` : null);
    const worker = await import('@/lib/instantly/leadQualificationWorker');
    await worker.pollAndQualifyReplies();

    // Same campaign, same module/cache, but catalog ownership moved cleanly.
    seedOwner('project-owner-b', 'B', 'owner-b-reply');
    await worker.pollAndQualifyReplies();

    expect(qualifyReply).toHaveBeenCalledTimes(2);
    expect(qualifyReply.mock.calls.map((call) => ({
      criteria: call[3]?.leadCriteria,
      brief: call[3]?.briefText,
    }))).toEqual([
      { criteria: 'Критерии A', brief: 'Бриф project-owner-a' },
      { criteria: 'Критерии B', brief: 'Бриф project-owner-b' },
    ]);
    expect(fetchBriefByCampaign).toHaveBeenNthCalledWith(
      1,
      'linked-campaign',
      { projectId: 'project-owner-a', ownershipProven: true },
    );
    expect(fetchBriefByCampaign).toHaveBeenNthCalledWith(
      2,
      'linked-campaign',
      { projectId: 'project-owner-b', ownershipProven: true },
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

  it.each([
    { label: 'distinct project owners', errorTable: null },
    { label: 'a partial project-owner read', errorTable: 'project_period_instantly_campaigns' },
  ])('client DM has no side effects for $label', async ({ errorTable }) => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-a', campaign_id: 'linked-campaign' },
        ],
        project_period_instantly_campaigns: errorTable
          ? []
          : [{ project_id: 'project-b', campaign_id: 'linked-campaign' }],
        client_reply_telegram_links: [
          { client_user_id: 'client-a', chat_id: 101, enabled: true },
          { client_user_id: 'client-b', chat_id: 202, enabled: true },
        ],
      },
      errorTables: errorTable ? { [errorTable]: 'ownership read unavailable' } : undefined,
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-a', client_user_id: 'client-a' },
          { id: 'project-b', client_user_id: 'client-b' },
        ],
      },
    });
    const { notifyClientOfReply } = await import('@/lib/instantly/leadQualificationWorker');

    await notifyClientOfReply(
      mockInstantlyDb! as unknown as Parameters<typeof notifyClientOfReply>[0],
      'linked-campaign',
      {
        campaignName: 'Campaign',
        leadEmail: 'lead@example.com',
        leadName: null,
        companyName: null,
        replySubject: 'Re: offer',
        replyBody: 'Interested',
        replyTimestamp: '2026-08-24T10:00:00.000Z',
        isLead: true,
      },
    );

    expect(sendClientReplyTelegram).not.toHaveBeenCalled();
  });

  // Инцидент 14.07: 503 «Server Overloaded» / «fetch failed» → строка
  // status='error' с instantly_email_id → дедуп блокировал письмо НАВСЕГДА →
  // 2 горячих лида (один с назначенным звонком) потеряны безвозвратно.
  // Транзиентный сбой не должен оставлять terminal error с реальным email id.
  it('transient AI/network failure writes a durable retry row, not terminal error', async () => {
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
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'transient-email',
        status: 'needs_review',
        ai_confidence: 0,
      }),
    ]);
  });

  // Production incident 26.08: Requesty returned HTTP 402 while the
  // organisation balance was empty. Persisting that provider-wide outage as a
  // terminal error poisons the instantly_email_id dedup forever, so topping up
  // cannot recover replies that arrived during the outage.
  it('Requesty low-balance 402 writes a durable retry row, not terminal error', async () => {
    qualifyReply.mockRejectedValueOnce(
      new Error(
        'AI API 402: {"error":{"origin":"router","message":"Your organization\'s balance is too low to run this request. Top up or enable auto-top-up"}}',
      ),
    );
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'requesty-balance-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    const processed = await pollAndQualifyReplies();

    expect(processed).toBe(0);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'requesty-balance-email',
        status: 'needs_review',
        ai_confidence: 0,
      }),
    ]);
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
      'AI API 402: {"error":{"origin":"router","message":"Your organization\'s balance is too low to run this request"}}',
      'AI API 403: insufficient credits for this API key',
      'AI classification failed after retries',
      'connect ETIMEDOUT 1.2.3.4:443',
      'socket hang up',
      'Reply ownership deferred: campaign project owner changed before qualification commit',
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

  // Холодный кэш + блип БД: критерии НЕИЗВЕСТНЫ → письмо уходит в durable retry,
  // а не квалифицируется по дефолту и не теряется после выпадения из provider window.
  it('defers to durable retry without AI when criteria fetch is degraded on a cold cache', async () => {
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
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({ instantly_email_id: 'deferred-email', status: 'needs_review' }),
    ]);
  });

  it('defers to durable retry when the proven project brief read fails transiently', async () => {
    fetchBriefByCampaign.mockRejectedValueOnce(new Error('Project brief lookup failed: unavailable'));
    listEmails.mockResolvedValue({
      items: [replyEmail({ id: 'brief-deferred-email' })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    await pollAndQualifyReplies();

    expect(qualifyReply).not.toHaveBeenCalled();
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'brief-deferred-email',
        status: 'needs_review',
      }),
    ]);
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
      // New bounded ownership lookup: one workspace-wide search returns both
      // the polluted provider row and the real historical parent.
      if (params.search && !params.campaign_id) {
        return {
          items: [inbound, ownerOutbound, ownerEarlierInbound],
          next_starting_after: null,
        };
      }
      // A mature workspace almost always has more than 100 total sent emails.
      // Same-owner enrichment must still use the exact stable-thread parent
      // already found by search; global sent pagination cannot change owner.
      if (params.email_type === 'sent' && !params.campaign_id) {
        return { items: [], next_starting_after: 'more-workspace-sent' };
      }
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

    const ownershipSearchCalls = listEmails.mock.calls.filter(
      ([params]) => (params as { search?: string }).search === 'partners@elma365.com',
    );
    expect(ownershipSearchCalls).toHaveLength(1);
    expect(listEmails).toHaveBeenCalledTimes(3);
    expect(
      listEmails.mock.calls.filter(
        ([params]) => Boolean((params as { campaign_id?: string }).campaign_id),
      ),
    ).toHaveLength(0);
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

    const ownershipCalls = listEmails.mock.calls.filter(([params]) => {
      const query = params as { search?: string; email_type?: string };
      return Boolean(query.search) || query.email_type === 'sent';
    });
    expect(ownershipCalls).toHaveLength(2);
    expect(ownershipCalls.map(([params]) => params)).toEqual([
      expect.objectContaining({
        search: 'lead@prospect.example',
        mode: 'emode_all',
      }),
      expect.objectContaining({
        email_type: 'sent',
        mode: 'emode_all',
      }),
    ]);
    expect(ownershipCalls[1]?.[0]).not.toHaveProperty('search');
    expect(
      ownershipCalls.every(
        ([params]) => !(params as { campaign_id?: string }).campaign_id,
      ),
    ).toBe(true);
  });

  it('fails closed before AI and every side effect when a no-eaccount provider campaign has two project owners', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-owner-a', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        project_period_instantly_campaigns: [
          { project_id: 'project-owner-b', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        instantly_lead_qualifications: [],
        instantly_pending_handoffs: [],
        client_reply_telegram_links: [
          { client_user_id: 'client-a', chat_id: 101, enabled: true, leads_only: false },
          { client_user_id: 'client-b', chat_id: 202, enabled: true, leads_only: false },
        ],
      },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          {
            id: 'project-owner-a',
            client: 'Client A',
            client_user_id: 'client-a',
            specialist_user_id: 'specialist-a',
            lead_criteria: 'Любой ответ = лид A.',
          },
          {
            id: 'project-owner-b',
            client: 'Client B',
            client_user_id: 'client-b',
            specialist_user_id: 'specialist-b',
            lead_criteria: 'Любой ответ = лид B.',
          },
        ],
        profiles: [],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
      },
    });
    listEmails.mockResolvedValue({
      items: [replyEmail({
        id: 'no-eaccount-duplicate-owner',
        campaign_id: 'linked-campaign',
        eaccount: undefined,
        body: { text: 'Interested, please send the proposal.' },
      })],
      next_starting_after: null,
    });

    const { pollAndQualifyReplies, OWNERSHIP_REVIEW_REASON_PREFIX } = await import(
      '@/lib/instantly/leadQualificationWorker'
    );
    expect(await pollAndQualifyReplies()).toBe(1);

    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        status: 'needs_review',
        ai_reason: expect.stringContaining(OWNERSHIP_REVIEW_REASON_PREFIX),
      }),
    ]);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(fetchBriefByCampaign).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    expect(sendClientReplyTelegram).not.toHaveBeenCalled();
    expect(postHandoffMessage).not.toHaveBeenCalled();
    expect(mockMainDb!.getRows('notifications')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('instantly_pending_handoffs')).toHaveLength(0);
  });

  it('defers a no-eaccount provider reply when either project-owner lookup fails', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
      },
      errorTables: {
        project_period_instantly_campaigns: 'period ownership lookup unavailable',
      },
    });
    const inbound = replyEmail({
      id: 'no-eaccount-owner-read-error',
      campaign_id: 'linked-campaign',
      eaccount: undefined,
    });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId: 'linked-campaign',
      leadEmail: inbound.from_address_email ?? '',
      accountId: 'main',
      prefetchedContext: null,
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'defer',
      reason: expect.stringContaining('period ownership lookup unavailable'),
    }));
    expect(qualifyReply).not.toHaveBeenCalled();
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
    const unrelatedOutbound = replyEmail({
      id: 'same-lead-unrelated-outbound',
      campaign_id: candidateCampaignIds[0],
      eaccount: mailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: 'different-thread',
      ue_type: 1,
      timestamp_email: '2026-05-12T11:00:00.000Z',
      body: { text: 'Другое исходящее тому же контакту.' },
    });
    listEmails.mockResolvedValue({ items: [unrelatedOutbound], next_starting_after: null });

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
    if (result.status !== 'resolved') throw new Error('expected resolved ownership');
    expect(result.context?.lastOutbound).toBeNull();
    expect(result.context?.threadEmails.map((email) => email.id)).toEqual([
      'many-campaigns-reply',
    ]);
  });

  it('preserves a mapped historical provider campaign and its thread for a late reply', async () => {
    const providerCampaignId = 'same-owner-historical-provider';
    const currentCampaignId = 'same-owner-current-campaign';
    const mailbox = 'late-replies@single-project.example';
    const inbound = replyEmail({
      id: 'late-provider-reply',
      campaign_id: providerCampaignId,
      eaccount: mailbox,
      to_address_email_list: mailbox,
      thread_id: 'late-provider-thread',
    });
    const parent = replyEmail({
      id: 'late-provider-parent',
      campaign_id: providerCampaignId,
      eaccount: mailbox,
      to_address_email_list: inbound.from_address_email,
      thread_id: inbound.thread_id,
      ue_type: 1,
      timestamp_email: '2026-05-12T10:00:00.000Z',
    });
    const providerContext = {
      replyEmail: inbound,
      threadEmails: [parent, inbound],
      lastOutbound: parent,
      campaignOutboundMailboxes: [mailbox],
    };
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'single-owner-project', campaign_id: providerCampaignId },
          { project_id: 'single-owner-project', campaign_id: currentCampaignId },
        ],
      },
    });
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: currentCampaignId, status: 1 },
      { campaign_id: providerCampaignId, status: 3 },
    ]);
    fetchThreadContext.mockResolvedValue(providerContext);

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail: inbound.from_address_email ?? '',
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'resolved',
      effectiveCampaignId: providerCampaignId,
      effectiveProjectId: 'single-owner-project',
      corrected: false,
    }));
    if (result.status !== 'resolved') throw new Error('expected resolved ownership');
    expect(result.context).toBe(providerContext);
    expect(listEmails).not.toHaveBeenCalled();
  });

  it('recovers a sibling-campaign parent when the mapped provider thread is reply-only', async () => {
    const providerCampaignId = 'same-owner-provider-without-parent';
    const siblingCampaignId = 'same-owner-sibling-with-parent';
    const mailbox = 'shared-project@single-project.example';
    const inbound = replyEmail({
      id: 'mapped-provider-reply-only',
      campaign_id: providerCampaignId,
      eaccount: mailbox,
      to_address_email_list: mailbox,
      thread_id: 'shared-project-thread',
    });
    const siblingParent = replyEmail({
      id: 'sibling-real-parent',
      campaign_id: siblingCampaignId,
      eaccount: mailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: `05-${inbound.thread_id}`,
      ue_type: 1,
      timestamp_email: '2026-05-12T10:00:00.000Z',
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'single-owner-project', campaign_id: providerCampaignId },
          { project_id: 'single-owner-project', campaign_id: siblingCampaignId },
        ],
      },
    });
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: providerCampaignId, status: 1 },
      { campaign_id: siblingCampaignId, status: 1 },
    ]);
    fetchThreadContext.mockResolvedValue({
      replyEmail: inbound,
      threadEmails: [inbound],
      lastOutbound: null,
      campaignOutboundMailboxes: [mailbox],
    });
    listEmails.mockImplementation(async (params: {
      search?: string;
      email_type?: string;
    }) => {
      if (params.search) {
        return { items: [siblingParent], next_starting_after: null };
      }
      if (params.email_type === 'sent') {
        return { items: [], next_starting_after: 'more-workspace-sent' };
      }
      return { items: [], next_starting_after: null };
    });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail: inbound.from_address_email ?? '',
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'resolved',
      effectiveCampaignId: siblingCampaignId,
      effectiveProjectId: 'single-owner-project',
      corrected: true,
    }));
    if (result.status !== 'resolved') throw new Error('expected resolved ownership');
    expect(result.context?.lastOutbound?.id).toBe('sibling-real-parent');
    expect(listEmails).toHaveBeenCalledTimes(2);
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

  it('defers mailbox ownership resolution to durable retry when exact mapping lookup fails', async () => {
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
      qualificationRows: 1,
      aiCalls: 0,
      telegramCalls: 0,
      notificationRecipients: [],
    });
  });

  it('keeps repeated ownership defers retryable and qualifies once after recovery', async () => {
    const { providerCampaignId, ownerMailbox, inbound } = installMailboxOwnershipConflictFixture({
      mappingError: new Error('Instantly API 503: Service Unavailable'),
    });
    getEmail.mockResolvedValue(inbound);

    const {
      pollAndQualifyReplies,
      reprocessOwnershipReviewRows,
      TRANSIENT_RETRY_REASON_PREFIX,
    } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(0);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: inbound.id,
        status: 'needs_review',
        ai_reason: expect.stringContaining(TRANSIENT_RETRY_REASON_PREFIX),
      }),
    ]);

    const retryStart = Date.now() + 60_000;
    for (let attempt = 1; attempt <= 8; attempt++) {
      expect(await reprocessOwnershipReviewRows({
        now: new Date(retryStart + attempt * 1_000),
        minRetryAgeMs: 0,
        maxAgeMs: 24 * 60 * 60 * 1000,
      })).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          instantly_email_id: inbound.id,
          status: 'needs_review',
        }),
      ]);
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    }

    getAccountCampaignMappings.mockResolvedValue([
      {
        campaign_id: providerCampaignId,
        status: 1,
        timestamp_created: '2026-07-01T00:00:00.000Z',
        email: ownerMailbox,
      },
    ]);

    expect(await reprocessOwnershipReviewRows({
      now: new Date(retryStart + 10_000),
      minRetryAgeMs: 0,
      maxAgeMs: 24 * 60 * 60 * 1000,
    })).toBe(1);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        campaign_id: providerCampaignId,
        instantly_email_id: 'mapping-error-reply',
        status: 'lead',
      }),
    ]);
    expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);

    expect(await reprocessOwnershipReviewRows({
      now: new Date(retryStart + 11_000),
      minRetryAgeMs: 0,
      maxAgeMs: 24 * 60 * 60 * 1000,
    })).toBe(0);
    expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
  });

  it('retries every explicit ownership defer even when the provider error has no transient keyword', async () => {
    const { inbound } = installMailboxOwnershipConflictFixture({
      mappingError: new Error('Unexpected end of JSON input'),
    });
    getEmail.mockResolvedValue(inbound);

    const { pollAndQualifyReplies, reprocessOwnershipReviewRows } = await import(
      '@/lib/instantly/leadQualificationWorker'
    );
    expect(await pollAndQualifyReplies()).toBe(0);

    const retryStart = Date.now() + 60_000;
    for (let attempt = 1; attempt <= 6; attempt++) {
      expect(await reprocessOwnershipReviewRows({
        now: new Date(retryStart + attempt * 1_000),
        minRetryAgeMs: 0,
        maxAgeMs: 24 * 60 * 60 * 1000,
      })).toBe(1);
    }
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'mapping-error-reply',
        status: 'needs_review',
        error_message: expect.stringContaining('Unexpected end of JSON input'),
      }),
    ]);
  });

  it('persists a deferred webhook reply and qualifies it once after recovery', async () => {
    const { providerCampaignId, ownerMailbox, inbound } = installMailboxOwnershipConflictFixture({
      mappingError: new Error('Instantly API 503: Service Unavailable'),
    });
    getEmail.mockResolvedValue(inbound);
    await mockInstantlyDb!.from('instantly_webhook_events').insert({
      id: 'ownership-defer-event',
      event_type: 'reply_received',
      campaign_id: providerCampaignId,
      lead_email: inbound.from_address_email,
      thread_id: inbound.thread_id,
      created_at: '2026-08-21T00:00:00.000Z',
      processed: false,
    });

    await withWebhookDrainEnabled(async () => {
      const {
        drainWebhookQueue,
        reprocessOwnershipReviewRows,
      } = await import('@/lib/instantly/leadQualificationWorker');
      expect(await drainWebhookQueue()).toBe(0);
      expect(mockInstantlyDb!.getRows('instantly_webhook_events')).toEqual([
        expect.objectContaining({
          id: 'ownership-defer-event',
          processed: true,
        }),
      ]);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          instantly_email_id: inbound.id,
          status: 'needs_review',
          webhook_event_id: 'ownership-defer-event',
        }),
      ]);

      const retryStart = Date.now() + 60_000;
      for (let attempt = 1; attempt <= 6; attempt++) {
        expect(await reprocessOwnershipReviewRows({
          now: new Date(retryStart + attempt * 1_000),
          minRetryAgeMs: 0,
          maxAgeMs: 24 * 60 * 60 * 1000,
        })).toBe(1);
        expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
          expect.objectContaining({ status: 'needs_review' }),
        ]);
      }

      getAccountCampaignMappings.mockResolvedValue([
        {
          campaign_id: providerCampaignId,
          status: 1,
          timestamp_created: '2026-07-01T00:00:00.000Z',
          email: ownerMailbox,
        },
      ]);
      expect(await reprocessOwnershipReviewRows({
        now: new Date(retryStart + 8_000),
        minRetryAgeMs: 0,
        maxAgeMs: 24 * 60 * 60 * 1000,
      })).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          campaign_id: providerCampaignId,
          instantly_email_id: inbound.id,
          status: 'lead',
          webhook_event_id: 'ownership-defer-event',
        }),
      ]);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(await reprocessOwnershipReviewRows({
        now: new Date(retryStart + 9_000),
        minRetryAgeMs: 0,
        maxAgeMs: 24 * 60 * 60 * 1000,
      })).toBe(0);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
    });
  });

  it('reopens an old webhook event when provider context is still unavailable', async () => {
    await mockInstantlyDb!.from('instantly_webhook_events').insert({
      id: 'old-empty-context-event',
      event_type: 'reply_received',
      campaign_id: 'linked-campaign',
      lead_email: 'lead@example.com',
      thread_id: 'thread-not-indexed',
      created_at: '2026-08-21T00:00:00.000Z',
      processed: false,
    });
    fetchThreadContext.mockResolvedValue(null);

    await withWebhookDrainEnabled(async () => {
      const { drainWebhookQueue } = await import('@/lib/instantly/leadQualificationWorker');
      expect(await drainWebhookQueue()).toBe(0);
    });

    expect(mockInstantlyDb!.getRows('instantly_webhook_events')).toEqual([
      expect.objectContaining({ id: 'old-empty-context-event', processed: false }),
    ]);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toHaveLength(0);
  });

  it('persists a webhook retry when cold lead-criteria storage is unavailable', async () => {
    const inbound = replyEmail({ id: 'criteria-defer-reply' });
    const context = {
      replyEmail: inbound,
      threadEmails: [inbound],
      lastOutbound: null,
      campaignOutboundMailboxes: [],
    };
    fetchThreadContext.mockResolvedValue(context);
    mockMainDb = createMockSupabase({
      tables: {
        projects: [
          { id: 'project-1', client: 'Acme', specialist_user_id: 'specialist-1' },
        ],
        profiles: [],
        telegram_links: [],
        notifications: [],
        deadline_notification_log: [],
      },
      errorSelects: {
        projects: {
          columnsInclude: 'lead_criteria',
          message: 'lead criteria storage unavailable',
        },
      },
    });
    await mockInstantlyDb!.from('instantly_webhook_events').insert({
      id: 'criteria-defer-event',
      event_type: 'reply_received',
      campaign_id: 'linked-campaign',
      lead_email: 'lead@example.com',
      thread_id: 'thread-1',
      created_at: '2026-08-21T00:00:00.000Z',
      processed: false,
    });

    await withWebhookDrainEnabled(async () => {
      const { drainWebhookQueue } = await import('@/lib/instantly/leadQualificationWorker');
      expect(await drainWebhookQueue()).toBe(0);
    });

    expect(mockInstantlyDb!.getRows('instantly_webhook_events')).toEqual([
      expect.objectContaining({ id: 'criteria-defer-event', processed: true }),
    ]);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'criteria-defer-reply',
        status: 'needs_review',
        webhook_event_id: 'criteria-defer-event',
      }),
    ]);
    expect(qualifyReply).not.toHaveBeenCalled();
  });

  it.each([
    'project_instantly_campaigns',
    'project_period_instantly_campaigns',
    'client_instantly_access',
  ])('does not claim webhook events when campaign-surface read %s is partial', async (errorTable) => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        project_period_instantly_campaigns: [
          { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
        ],
        client_instantly_access: [],
        instantly_webhook_events: [{
          id: `partial-surface-${errorTable}`,
          event_type: 'reply_received',
          campaign_id: 'linked-campaign',
          lead_email: 'lead@example.com',
          thread_id: 'thread-1',
          created_at: '2026-08-21T00:00:00.000Z',
          processed: false,
        }],
        instantly_lead_qualifications: [],
      },
      errorTables: { [errorTable]: 'campaign surface unavailable' },
    });
    mockMainDb = createMockSupabase({
      tables: {
        projects: [{ id: 'project-1', client: 'Acme' }],
      },
    });
    fetchThreadContext.mockResolvedValue(null);

    await withWebhookDrainEnabled(async () => {
      const { drainWebhookQueue } = await import('@/lib/instantly/leadQualificationWorker');
      expect(await drainWebhookQueue()).toBe(0);
    });

    expect(mockInstantlyDb!.getRows('instantly_webhook_events')).toEqual([
      expect.objectContaining({
        id: `partial-surface-${errorTable}`,
        processed: false,
      }),
    ]);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toHaveLength(0);
  });

  it('fails closed when cross-owner workspace evidence still has another page after the call budget', async () => {
    const { candidateCampaignIds, ownerMailbox, inbound } =
      installMailboxOwnershipConflictFixture();
    const candidateParent = replyEmail({
      id: 'first-page-parent',
      campaign_id: candidateCampaignIds[0],
      eaccount: ownerMailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: `05-${inbound.thread_id}`,
      ue_type: 1,
      timestamp_email: '2026-05-12T10:00:00.000Z',
    });
    listEmails.mockImplementation(async (params: {
      search?: string;
      starting_after?: string;
    }) => {
      if (!params.search) return { items: [inbound], next_starting_after: null };
      if (!params.starting_after) {
        return { items: [candidateParent], next_starting_after: 'ownership-page-2' };
      }
      return { items: [], next_starting_after: 'ownership-page-3' };
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({ status: 'needs_review' }),
    ]);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    const ownershipCalls = listEmails.mock.calls.filter(
      ([params]) => Boolean((params as { search?: string }).search),
    );
    expect(ownershipCalls).toHaveLength(2);
  });

  it('trusts the current provider campaign when its exact-mailbox thread has a strong parent despite stale cross-owner mailbox history', async () => {
    const {
      providerCampaignId,
      providerContext,
      inbound,
      leadEmail,
    } = installCurrentProviderWithStaleMailboxOwnersFixture({
      strongProviderParent: true,
      incompleteWorkspaceSearch: true,
    });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail,
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'resolved',
      effectiveCampaignId: providerCampaignId,
      effectiveProjectId: 'project-enagency',
      corrected: false,
      mailboxVerified: true,
    }));
    if (result.status !== 'resolved') throw new Error('expected resolved ownership');
    expect(result.context).toBe(providerContext);
    expect(listEmails).not.toHaveBeenCalled();
  });

  it('refreshes cached mailbox mappings when a provider reply arrives from a newly assigned campaign', async () => {
    const mailbox = 'moved-mailbox@example.com';
    const firstReply = replyEmail({
      id: 'mailbox-before-move',
      campaign_id: 'campaign-a',
      eaccount: mailbox,
      to_address_email_list: mailbox,
    });
    const secondReply = replyEmail({
      id: 'mailbox-after-move',
      campaign_id: 'campaign-b',
      eaccount: mailbox,
      to_address_email_list: mailbox,
    });
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [
          { campaign_id: 'campaign-a', project_id: 'project-a' },
          { campaign_id: 'campaign-b', project_id: 'project-b' },
        ],
        project_period_instantly_campaigns: [],
        client_instantly_access: [],
      },
    });
    getAccountCampaignMappings
      .mockResolvedValueOnce([
        { campaign_id: 'campaign-a', status: 1, timestamp_created: '2026-08-20T00:00:00Z' },
      ])
      .mockResolvedValueOnce([
        { campaign_id: 'campaign-b', status: 1, timestamp_created: '2026-08-24T00:00:00Z' },
      ]);
    fetchThreadContext.mockImplementation(async (campaignId: string) => {
      const reply = campaignId === 'campaign-a' ? firstReply : secondReply;
      return {
        replyEmail: reply,
        threadEmails: [reply],
        lastOutbound: null,
        campaignOutboundMailboxes: [mailbox],
      };
    });
    listEmails.mockResolvedValue({ items: [], next_starting_after: null });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const resolve = (reply: Email) => resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply,
      providerCampaignId: reply.campaign_id!,
      leadEmail: reply.from_address_email ?? '',
      accountId: 'main',
    });

    await expect(resolve(firstReply)).resolves.toEqual(expect.objectContaining({
      status: 'resolved',
      effectiveCampaignId: 'campaign-a',
      effectiveProjectId: 'project-a',
    }));
    await expect(resolve(secondReply)).resolves.toEqual(expect.objectContaining({
      status: 'resolved',
      effectiveCampaignId: 'campaign-b',
      effectiveProjectId: 'project-b',
    }));
    expect(getAccountCampaignMappings).toHaveBeenCalledTimes(2);
  });

  it('trusts the unique current provider when a current sibling retains duplicate provider and stale-owner links', async () => {
    const {
      providerCampaignId,
      providerContext,
      inbound,
      leadEmail,
    } = installCurrentProviderWithStaleMailboxOwnersFixture({
      strongProviderParent: true,
      incompleteWorkspaceSearch: true,
      currentSiblingWithDuplicateProviderOwner: true,
    });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail,
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'resolved',
      effectiveCampaignId: providerCampaignId,
      effectiveProjectId: 'project-enagency',
      corrected: false,
      mailboxVerified: true,
    }));
    if (result.status !== 'resolved') throw new Error('expected resolved ownership');
    expect(result.context).toBe(providerContext);
    expect(listEmails).not.toHaveBeenCalled();
  });

  it('keeps cross-owner mailbox history ambiguous when the current provider thread has no strong exact-mailbox parent', async () => {
    const { providerCampaignId, inbound, leadEmail } =
      installCurrentProviderWithStaleMailboxOwnersFixture();

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail,
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous' }));
    expect(listEmails.mock.calls.filter(
      ([params]) => Boolean((params as { search?: string }).search) ||
        (params as { email_type?: string }).email_type === 'sent',
    )).toHaveLength(2);
  });

  it('keeps a multi-project provider campaign ambiguous even with a strong exact-mailbox parent', async () => {
    const { providerCampaignId, inbound, leadEmail } =
      installCurrentProviderWithStaleMailboxOwnersFixture({
        strongProviderParent: true,
        providerProjectIds: ['project-enagency-a', 'project-enagency-b'],
        incompleteWorkspaceSearch: true,
      });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail,
      accountId: 'main',
    });

    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous' }));
    expect(listEmails).not.toHaveBeenCalled();
  });

  describe('ownership-review reconciliation', () => {
    const retryNow = new Date('2026-08-24T18:00:00.000Z');

    it('recovers a legacy Requesty 402 row with a PostgREST-12-safe claim and alerts exactly once', async () => {
      installOwnershipReviewRetryFixture({
        enforceQueryWindows: true,
        row: {
          status: 'error',
          ai_reason: null,
          ai_confidence: null,
          error_message:
            'AI API 402: {"error":{"origin":"router","message":"Your organization\'s balance is too low to run this request. Top up or enable auto-top-up"}}',
          created_at: '2026-08-24T17:00:00.000Z',
          updated_at: '2026-08-24T17:00:00.000Z',
        },
      });

      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );
      expect(await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      })).toBe(1);

      expect(mockInstantlyDb!.selects).toContainEqual({
        table: 'instantly_lead_qualifications',
        // PostgREST 12 re-applies an `or(ai_reason...)` filter to the returned
        // PATCH representation. Omitting ai_reason here produces the real prod
        // 42703 even though the physical table column exists.
        columns: 'id, ai_reason',
      });
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          id: 'ownership-review-qualification',
          instantly_email_id: 'ownership-email',
          status: 'lead',
          error_message: null,
        }),
      ]);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);

      expect(await reprocessOwnershipReviewRows({
        now: new Date('2026-08-24T18:01:00.000Z'),
        minRetryAgeMs: 0,
      })).toBe(0);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
    });

    it('reopens a recent legacy terminal transient row and alerts exactly once', async () => {
      installOwnershipReviewRetryFixture({
        enforceQueryWindows: true,
        row: {
          status: 'error',
          ai_reason: null,
          ai_confidence: null,
          error_message:
            'Reply ownership deferred for ownership-email: lead criteria storage unavailable',
          created_at: '2026-08-24T17:00:00.000Z',
          updated_at: '2026-08-24T17:00:00.000Z',
        },
      });
      await mockInstantlyDb!.from('instantly_lead_qualifications').insert(
        Array.from({ length: 130 }, (_, index) => ({
          id: `newer-permanent-${index}`,
          campaign_id: 'linked-campaign',
          lead_email: `permanent-${index}@example.com`,
          instantly_email_id: `permanent-email-${index}`,
          status: 'error',
          error_message: 'Cannot find JSON object in AI response',
          created_at: `2026-08-24T17:30:00.${String(index).padStart(3, '0')}Z`,
          updated_at: `2026-08-24T17:30:00.${String(index).padStart(3, '0')}Z`,
        })),
      );

      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );
      expect(await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      })).toBe(1);
      const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
      expect(rows).toHaveLength(131);
      expect(rows.find((row) => row.id === 'ownership-review-qualification')).toEqual(
        expect.objectContaining({
          instantly_email_id: 'ownership-email',
          status: 'lead',
          error_message: null,
        }),
      );
      expect(rows.filter((row) => row.status === 'error')).toHaveLength(130);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);

      expect(await reprocessOwnershipReviewRows({
        now: new Date('2026-08-24T18:01:00.000Z'),
        minRetryAgeMs: 0,
      })).toBe(0);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
    });

    it('does not reopen a permanent legacy error row', async () => {
      installOwnershipReviewRetryFixture({
        row: {
          status: 'error',
          ai_reason: null,
          ai_confidence: null,
          error_message: 'Cannot find JSON object in AI response',
        },
      });

      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );
      expect(await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      })).toBe(0);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({ status: 'error' }),
      ]);
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    });

    it('preserves Others context and DM policy while retrying a deferred row', async () => {
      const { inbound } = installOwnershipReviewRetryFixture({
        verdict: 'not_lead',
        row: {
          ai_reason:
            'Автоматическая повторная квалификация: [others] Instantly API 503',
          ai_confidence: 0,
          error_message: 'Instantly API 503',
          reply_out_of_campaign: true,
          eaccount: 'julia@enagency.example',
          last_outbound_preview: 'Our proposal can reduce acquisition costs.',
        },
      });
      getEmail.mockResolvedValue({ ...inbound, campaign_id: null, eaccount: null });

      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );
      expect(await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      })).toBe(1);

      const qualifierOptions = qualifyReply.mock.calls[0]?.[3] as {
        prefetchedContext?: {
          lastOutbound?: Email | null;
          campaignOutboundMailboxes?: string[];
        };
      };
      expect(
        (qualifierOptions.prefetchedContext?.lastOutbound?.body as { text?: string } | undefined)
          ?.text,
      ).toBe('Our proposal can reduce acquisition costs.');
      expect(qualifierOptions.prefetchedContext?.campaignOutboundMailboxes).toEqual([
        'julia@enagency.example',
      ]);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          id: 'ownership-review-qualification',
          status: 'not_lead',
          reply_out_of_campaign: true,
          eaccount: 'julia@enagency.example',
        }),
      ]);
      expect(sendClientReplyTelegram).not.toHaveBeenCalled();
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    });

    it('does not trust a reconstructed Others preview as ownership proof', async () => {
      const { inbound } = installOwnershipReviewRetryFixture({
        ambiguous: true,
        row: {
          ai_reason:
            'Автоматическая повторная квалификация: [others] Instantly API 503',
          ai_confidence: 0,
          error_message: 'Instantly API 503',
          reply_out_of_campaign: true,
          eaccount: 'julia@enagency.example',
          last_outbound_preview: 'Our proposal can reduce acquisition costs.',
        },
      });
      getEmail.mockResolvedValue({ ...inbound, campaign_id: null, eaccount: null });
      listEmails.mockResolvedValue({ items: [], next_starting_after: null });

      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );
      expect(await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      })).toBe(1);

      expect(listEmails).toHaveBeenCalledTimes(2);
      expect(qualifyReply).not.toHaveBeenCalled();
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          id: 'ownership-review-qualification',
          status: 'needs_review',
          ai_reason: expect.stringContaining('Не удалось однозначно определить'),
          reply_out_of_campaign: true,
          eaccount: 'julia@enagency.example',
        }),
      ]);
      expect(sendClientReplyTelegram).not.toHaveBeenCalled();
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    });

    it('requalifies the existing row in place and sends exactly one lead alert', async () => {
      installOwnershipReviewRetryFixture({ verdict: 'lead' });
      const {
        reprocessOwnershipReviewRows,
        OWNERSHIP_REVIEW_REASON_PREFIX,
      } = await import('@/lib/instantly/leadQualificationWorker');

      expect(OWNERSHIP_REVIEW_REASON.startsWith(OWNERSHIP_REVIEW_REASON_PREFIX)).toBe(true);
      const processed = await reprocessOwnershipReviewRows({
        now: retryNow,
        limit: 2,
        minRetryAgeMs: 15 * 60_000,
      });

      expect(processed).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          id: 'ownership-review-qualification',
          instantly_email_id: 'ownership-email',
          status: 'lead',
          ai_reason: 'Просит предложение после подтверждённого интереса.',
        }),
      ]);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(mockMainDb!.getRows('notifications')).toHaveLength(1);
      expect(mockMainDb!.getRows('deadline_notification_log')).toEqual([
        expect.objectContaining({
          entity_type: 'lead_qualification',
          entity_id: 'ownership-review-qualification',
          level: 'specialist',
          tg_sent: true,
        }),
      ]);
    });

    it('does not reprocess or alert the same row twice after it reached lead', async () => {
      installOwnershipReviewRetryFixture({ verdict: 'lead' });
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      await reprocessOwnershipReviewRows({ now: retryNow, minRetryAgeMs: 0 });
      const second = await reprocessOwnershipReviewRows({
        now: new Date(retryNow.getTime() + 60 * 60_000),
        minRetryAgeMs: 0,
      });

      expect(second).toBe(0);
      expect(qualifyReply).toHaveBeenCalledTimes(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(mockMainDb!.getRows('notifications')).toHaveLength(1);
      expect(mockMainDb!.getRows('deadline_notification_log')).toHaveLength(1);
    });

    it('uses the provider-refreshed campaign id during ownership retry', async () => {
      const { inbound } = installOwnershipReviewRetryFixture({ verdict: 'lead' });
      await mockInstantlyDb!.from('project_instantly_campaigns').insert({
        project_id: 'project-1',
        campaign_id: 'provider-corrected-campaign',
        match_source: 'auto',
      });
      const refreshed = {
        ...inbound,
        campaign_id: 'provider-corrected-campaign',
      } as Email;
      getEmail.mockResolvedValue(refreshed);
      getAccountCampaignMappings.mockResolvedValue([
        {
          campaign_id: 'provider-corrected-campaign',
          status: 1,
          timestamp_created: '2026-08-24T13:00:00Z',
        },
      ]);
      fetchThreadContext.mockResolvedValue({
        replyEmail: refreshed,
        threadEmails: [refreshed],
        lastOutbound: null,
        campaignOutboundMailboxes: ['julia@enagency.example'],
      });
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const processed = await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      });

      expect(processed).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({
          id: 'ownership-review-qualification',
          campaign_id: 'provider-corrected-campaign',
          status: 'lead',
        }),
      );
      expect(fetchBriefByCampaign).toHaveBeenCalledWith(
        'provider-corrected-campaign',
        expect.objectContaining({ projectId: 'project-1', ownershipProven: true }),
      );
      expect(fetchThreadContext).toHaveBeenCalledWith(
        'provider-corrected-campaign',
        'lead@example.com',
        refreshed.thread_id,
        'main',
      );
    });

    it('skips in-app and Telegram delivery when another worker already claimed the qualification', async () => {
      installOwnershipReviewRetryFixture({ verdict: 'lead' });
      mockMainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
          ],
          profiles: [
            { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
          ],
          telegram_links: [
            { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
          ],
          notifications: [],
          deadline_notification_log: [{
            id: 'existing-delivery-claim',
            entity_type: 'lead_qualification',
            entity_id: 'ownership-review-qualification',
            level: 'specialist',
            tg_sent: true,
          }],
        },
        errorInserts: {
          deadline_notification_log: {
            code: '23505',
            message: 'duplicate key value violates unique constraint',
          },
        },
      });
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      await reprocessOwnershipReviewRows({ now: retryNow, minRetryAgeMs: 0 });

      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({ status: 'lead' }),
      );
      expect(mockMainDb!.getRows('deadline_notification_log')).toHaveLength(1);
      expect(mockMainDb!.getRows('notifications')).toHaveLength(0);
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    });

    it('ignores ordinary needs_review rows that were not created by ownership ambiguity', async () => {
      installOwnershipReviewRetryFixture({
        row: {
          ai_reason: 'Ответ «расскажите подробнее» требует ручной проверки.',
          ai_confidence: 0,
        },
      });
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const processed = await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      });

      expect(processed).toBe(0);
      expect(getEmail).not.toHaveBeenCalled();
      expect(qualifyReply).not.toHaveBeenCalled();
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({ status: 'needs_review' }),
      );
    });

    it('returns unresolved ownership to needs_review with backoff and no alert', async () => {
      installOwnershipReviewRetryFixture({ ambiguous: true });
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const first = await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 15 * 60_000,
      });
      const rowAfterFirst = mockInstantlyDb!
        .getRows('instantly_lead_qualifications')[0];
      const beforeBackoff = await reprocessOwnershipReviewRows({
        now: new Date(retryNow.getTime() + 14 * 60_000),
        minRetryAgeMs: 15 * 60_000,
      });

      expect(first).toBe(1);
      expect(beforeBackoff).toBe(0);
      expect(rowAfterFirst).toEqual(expect.objectContaining({
        id: 'ownership-review-qualification',
        status: 'needs_review',
        updated_at: retryNow.toISOString(),
      }));
      expect(String(rowAfterFirst.ai_reason).startsWith(
        'Не удалось однозначно определить проект-владельца ответа:',
      )).toBe(true);
      expect(getEmail).toHaveBeenCalledTimes(1);
      expect(qualifyReply).not.toHaveBeenCalled();
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    });

    it('retries after the backoff and resolves once the stale second owner disappears', async () => {
      installOwnershipReviewRetryFixture({ ambiguous: true });
      let worker = await import('@/lib/instantly/leadQualificationWorker');

      await worker.reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 15 * 60_000,
      });
      const deferredRow = mockInstantlyDb!
        .getRows('instantly_lead_qualifications')[0];

      // Simulate the next hourly catalog sync: the stale campaign owner is
      // gone, while the original qualification row/id remains intact.
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          client_instantly_access: [],
          client_forwarded_leads: [],
          instantly_lead_qualifications: [deferredRow],
        },
      });
      getAccountCampaignMappings.mockResolvedValue([
        { campaign_id: 'linked-campaign', status: 1, timestamp_created: '2026-08-20T00:00:00Z' },
      ]);
      const inbound = await getEmail.mock.results[0]?.value;
      const parent = replyEmail({
        id: 'ownership-parent-after-sync',
        campaign_id: 'linked-campaign',
        from_address_email: 'julia@enagency.example',
        to_address_email_list: 'lead@example.com',
        eaccount: 'julia@enagency.example',
        lead: 'lead@example.com',
        thread_id: '05-ownership-thread',
        ue_type: 1,
        timestamp_email: '2026-08-23T10:00:00.000Z',
        body: { text: 'Our proposal can reduce your acquisition costs. Shall we discuss it?' },
      });
      const resolvedContext = {
        replyEmail: inbound,
        threadEmails: [parent, inbound],
        lastOutbound: parent,
        campaignOutboundMailboxes: ['julia@enagency.example'],
      };
      fetchThreadContext.mockResolvedValue(resolvedContext);
      qualifyReply.mockResolvedValue({
        isLead: true,
        customCriteriaMatched: false,
        proposalSeen: true,
        interestSignals: ['requested_proposal'],
        reason: 'Просит предложение после подтверждённого интереса.',
        confidence: 0.95,
        needsReview: false,
        objectionHandleable: false,
        objectionDraft: null,
        threadContext: resolvedContext,
      });
      jest.resetModules();
      worker = await import('@/lib/instantly/leadQualificationWorker');

      const retried = await worker.reprocessOwnershipReviewRows({
        now: new Date(retryNow.getTime() + 15 * 60_000),
        minRetryAgeMs: 15 * 60_000,
      });

      expect(retried).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({
          id: 'ownership-review-qualification',
          status: 'lead',
          error_message: null,
        }),
      );
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
    });

    it('releases a transient provider failure back to needs_review with the same backoff', async () => {
      installOwnershipReviewRetryFixture({ verdict: 'lead' });
      getEmail.mockRejectedValueOnce(new Error('Instantly API 503: overloaded'));
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const first = await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 15 * 60_000,
      });
      const beforeBackoff = await reprocessOwnershipReviewRows({
        now: new Date(retryNow.getTime() + 14 * 60_000),
        minRetryAgeMs: 15 * 60_000,
      });

      expect(first).toBe(1);
      expect(beforeBackoff).toBe(0);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({
          status: 'needs_review',
          updated_at: retryNow.toISOString(),
          error_message: expect.stringContaining('Instantly API 503'),
        }),
      );
      expect(qualifyReply).not.toHaveBeenCalled();
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    });

    it('recovers an ownership retry whose processing lease expired', async () => {
      installOwnershipReviewRetryFixture({
        verdict: 'not_lead',
        row: {
          status: 'processing',
          updated_at: '2026-08-24T17:29:59.000Z',
        },
      });
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const processed = await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 15 * 60_000,
        processingLeaseMs: 30 * 60_000,
      });

      expect(processed).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({
          id: 'ownership-review-qualification',
          status: 'not_lead',
        }),
      );
    });

    it('updates the same row to not_lead without creating an alert', async () => {
      installOwnershipReviewRetryFixture({ verdict: 'not_lead' });
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const processed = await reprocessOwnershipReviewRows({
        now: retryNow,
        minRetryAgeMs: 0,
      });

      expect(processed).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
        expect.objectContaining({
          id: 'ownership-review-qualification',
          status: 'not_lead',
          ai_reason: 'Нет коммерческого интереса.',
        }),
      ]);
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
      expect(mockMainDb!.getRows('notifications')).toHaveLength(0);
      expect(mockMainDb!.getRows('deadline_notification_log')).toHaveLength(0);
    });

    it('fences a stale worker after the processing lease is reclaimed (ABA)', async () => {
      const { inbound } = installOwnershipReviewRetryFixture({ verdict: 'lead' });
      let releaseFirstGetEmail!: (email: Email) => void;
      let releaseSecondGetEmail!: (email: Email) => void;
      getEmail
        .mockReset()
        .mockImplementationOnce(() => new Promise<Email>((resolve) => {
          releaseFirstGetEmail = resolve;
        }))
        .mockImplementationOnce(() => new Promise<Email>((resolve) => {
          releaseSecondGetEmail = resolve;
        }));
      const leadResult = {
        isLead: true,
        customCriteriaMatched: false,
        proposalSeen: true,
        interestSignals: ['requested_proposal'],
        reason: 'Первый, уже просроченный воркер решил, что это лид.',
        confidence: 0.95,
        needsReview: false,
        objectionHandleable: false,
        objectionDraft: null,
        threadContext: (await fetchThreadContext('linked-campaign')),
      };
      qualifyReply
        .mockReset()
        .mockResolvedValueOnce(leadResult)
        .mockResolvedValueOnce({
          ...leadResult,
          isLead: false,
          interestSignals: [],
          reason: 'Новый владелец lease классифицировал ответ как не лид.',
        });
      const worker = await import('@/lib/instantly/leadQualificationWorker');
      const firstAttemptAt = retryNow;
      const secondAttemptAt = new Date(retryNow.getTime() + 31 * 60_000);

      const staleRun = worker.reprocessOwnershipReviewRows({
        now: firstAttemptAt,
        minRetryAgeMs: 0,
        processingLeaseMs: 30 * 60_000,
      });
      while (getEmail.mock.calls.length < 1) await Promise.resolve();

      const currentRun = worker.reprocessOwnershipReviewRows({
        now: secondAttemptAt,
        minRetryAgeMs: 0,
        processingLeaseMs: 30 * 60_000,
      });
      while (getEmail.mock.calls.length < 2) await Promise.resolve();

      releaseFirstGetEmail(inbound);
      await staleRun;
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({
          status: 'processing',
          updated_at: secondAttemptAt.toISOString(),
        }),
      );

      releaseSecondGetEmail(inbound);
      await currentRun;
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')[0]).toEqual(
        expect.objectContaining({
          status: 'not_lead',
          ai_reason: 'Новый владелец lease классифицировал ответ как не лид.',
        }),
      );
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    });

    it('rotates an account-ambiguous candidate and still processes the next row', async () => {
      const { inbound } = installOwnershipReviewRetryFixture({ verdict: 'lead' });
      const blockedUpdatedAt = '2026-08-24T11:00:00.000Z';
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'project-blocked', campaign_id: 'blocked-campaign', match_source: 'auto' },
            { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          client_instantly_access: [
            {
              client_user_id: 'client-blocked',
              resource_type: 'campaign',
              resource_id: 'blocked-campaign',
              instantly_account_id: 'secondary',
            },
          ],
          client_forwarded_leads: [],
          instantly_lead_qualifications: [
            ownershipReviewRow({
              id: 'blocked-ownership-row',
              campaign_id: 'blocked-campaign',
              instantly_email_id: 'blocked-email',
              updated_at: blockedUpdatedAt,
            }),
            ownershipReviewRow(),
          ],
        },
      });
      await mockMainDb!.from('projects').insert({
        id: 'project-blocked',
        client: 'Blocked owner',
        specialist_user_id: 'specialist-1',
      });
      getEmail.mockResolvedValue(inbound);
      jest.resetModules();
      const { reprocessOwnershipReviewRows } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const processed = await reprocessOwnershipReviewRows({
        now: retryNow,
        limit: 1,
        minRetryAgeMs: 0,
      });

      expect(processed).toBe(1);
      expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'blocked-ownership-row',
            status: 'needs_review',
            updated_at: retryNow.toISOString(),
          }),
          expect.objectContaining({
            id: 'ownership-review-qualification',
            status: 'lead',
          }),
        ]),
      );
      const rotation = mockInstantlyDb!.updates.find((call) =>
        call.table === 'instantly_lead_qualifications' &&
        call.patch.updated_at === retryNow.toISOString() &&
        call.filters.some((filter) =>
          filter.column === 'id' && filter.value === 'blocked-ownership-row'
        ),
      );
      expect(rotation?.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ column: 'status', op: 'eq', value: 'needs_review' }),
        expect.objectContaining({ column: 'updated_at', op: 'eq', value: blockedUpdatedAt }),
      ]));
    });
  });

  describe('lead notification delivery reconciliation', () => {
    const deliveryNow = new Date('2026-08-24T18:00:00.000Z');

    it('recovers a recent lead with no delivery log and stays idempotent', async () => {
      installLeadNotificationRecoveryFixture();
      const { reconcileLeadNotificationDeliveries } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const first = await reconcileLeadNotificationDeliveries({
        now: deliveryNow,
        limit: 2,
      });
      const second = await reconcileLeadNotificationDeliveries({
        now: new Date(deliveryNow.getTime() + 60 * 60_000),
        limit: 2,
      });

      expect(first).toBe(1);
      expect(second).toBe(0);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(mockMainDb!.getRows('notifications')).toHaveLength(1);
      expect(mockMainDb!.getRows('deadline_notification_log')).toEqual([
        expect.objectContaining({
          entity_type: 'lead_qualification',
          entity_id: 'recoverable-lead-qualification',
          level: 'specialist',
          tg_sent: true,
        }),
      ]);
    });

    it('pages past more completed leads than one scan page to reach a missing alert', async () => {
      const completedLeads = Array.from({ length: 7 }, (_, index) => ownershipReviewRow({
        id: `completed-lead-${index + 1}`,
        status: 'lead',
        ai_reason: 'Уже доставлен.',
        ai_confidence: 0.95,
        created_at: `2026-08-24T17:0${index}:00.000Z`,
        updated_at: `2026-08-24T17:0${index}:00.000Z`,
      }));
      const missingLead = ownershipReviewRow({
        id: 'lead-behind-completed-pages',
        status: 'lead',
        ai_reason: 'Нужно восстановить оповещение.',
        ai_confidence: 0.95,
        created_at: '2026-08-24T17:10:00.000Z',
        updated_at: '2026-08-24T17:10:00.000Z',
      });
      const pagedDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          instantly_lead_qualifications: [...completedLeads, missingLead],
        },
      });
      // The shared lightweight mock intentionally treats range() as a no-op;
      // wrap only this table so the regression exercises real page boundaries.
      const unpagedFrom = pagedDb.from.bind(pagedDb);
      pagedDb.from = ((table: string) => {
        const builder = unpagedFrom(table);
        if (table !== 'instantly_lead_qualifications') return builder;
        const unpagedRange = builder.range.bind(builder);
        builder.range = async (...args: unknown[]) => {
          const [start, end] = args as [number, number];
          const result = await unpagedRange();
          const data = result.data.slice(start, end + 1);
          return { ...result, data, count: data.length };
        };
        return builder;
      }) as MockSupabaseClient['from'];
      mockInstantlyDb = pagedDb;
      mockMainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
          ],
          profiles: [
            { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
          ],
          telegram_links: [
            { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
          ],
          notifications: [],
          deadline_notification_log: completedLeads.map((lead, index) => ({
            id: `completed-log-${index + 1}`,
            entity_type: 'lead_qualification',
            entity_id: lead.id,
            level: 'specialist',
            created_at: lead.created_at,
            tg_sent: true,
            tg_message_id: index + 1,
            tg_error: null,
            tg_sent_at: lead.updated_at,
          })),
        },
      });
      const { reconcileLeadNotificationDeliveries } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const recovered = await reconcileLeadNotificationDeliveries({
        now: deliveryNow,
        limit: 1,
        scanLimit: 3,
      });

      expect(recovered).toBe(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledWith(expect.objectContaining({
        qualificationId: 'lead-behind-completed-pages',
      }));
      expect(mockMainDb!.getRows('deadline_notification_log')).toHaveLength(8);
    });

    it('prioritizes a missing alert over an older recurring failed delivery', async () => {
      const oldFailedLead = ownershipReviewRow({
        id: 'old-recurring-failure',
        status: 'lead',
        created_at: '2026-08-24T16:00:00.000Z',
        updated_at: '2026-08-24T16:00:00.000Z',
      });
      const newerMissingLead = ownershipReviewRow({
        id: 'newer-missing-alert',
        status: 'lead',
        created_at: '2026-08-24T17:00:00.000Z',
        updated_at: '2026-08-24T17:00:00.000Z',
      });
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          instantly_lead_qualifications: [oldFailedLead, newerMissingLead],
        },
      });
      mockMainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
          ],
          profiles: [
            { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
          ],
          telegram_links: [
            { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
          ],
          notifications: [],
          deadline_notification_log: [{
            id: 'old-failed-log',
            entity_type: 'lead_qualification',
            entity_id: 'old-recurring-failure',
            level: 'specialist',
            created_at: '2026-08-24T16:00:00.000Z',
            tg_sent: false,
            tg_message_id: null,
            tg_error: 'Telegram 503',
            tg_sent_at: '2026-08-24T16:30:00.000Z',
          }],
        },
      });
      const { reconcileLeadNotificationDeliveries } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const recovered = await reconcileLeadNotificationDeliveries({
        now: deliveryNow,
        limit: 1,
        failedBackoffMs: 15 * 60_000,
      });

      expect(recovered).toBe(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledWith(expect.objectContaining({
        qualificationId: 'newer-missing-alert',
      }));
      expect(mockMainDb!.getRows('deadline_notification_log')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'old-failed-log', tg_sent: false }),
          expect.objectContaining({ entity_id: 'newer-missing-alert', tg_sent: true }),
        ]),
      );
    });

    it('does not let a self-serve lead with no project consume managed recovery capacity', async () => {
      const selfServeLead = ownershipReviewRow({
        id: 'self-serve-without-specialist-alert',
        campaign_id: 'self-serve-campaign',
        status: 'lead',
        created_at: '2026-08-24T16:00:00.000Z',
        updated_at: '2026-08-24T16:00:00.000Z',
      });
      const managedLead = ownershipReviewRow({
        id: 'managed-missing-alert',
        status: 'lead',
        created_at: '2026-08-24T17:00:00.000Z',
        updated_at: '2026-08-24T17:00:00.000Z',
      });
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          instantly_lead_qualifications: [selfServeLead, managedLead],
        },
      });
      mockMainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
          ],
          profiles: [
            { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
          ],
          telegram_links: [
            { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
          ],
          notifications: [],
          deadline_notification_log: [],
        },
      });
      const { reconcileLeadNotificationDeliveries } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const recovered = await reconcileLeadNotificationDeliveries({
        now: deliveryNow,
        limit: 1,
      });

      expect(recovered).toBe(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledWith(expect.objectContaining({
        qualificationId: 'managed-missing-alert',
      }));
      expect(mockMainDb!.getRows('deadline_notification_log')).toEqual([
        expect.objectContaining({ entity_id: 'managed-missing-alert', tg_sent: true }),
      ]);
    });

    it('reclaims a stale pending delivery and does not duplicate an existing in-app notification', async () => {
      installLeadNotificationRecoveryFixture({
        logRow: {
          id: 'pending-delivery-log',
          entity_type: 'lead_qualification',
          entity_id: 'recoverable-lead-qualification',
          level: 'specialist',
          created_at: '2026-08-24T16:00:00.000Z',
          tg_sent: null,
          tg_message_id: null,
          tg_error: null,
          tg_sent_at: null,
        },
        notificationRows: [{
          id: 'existing-in-app-notification',
          user_id: 'specialist-1',
          type: 'lead_new',
          entity_type: 'lead_qualification',
          entity_id: 'recoverable-lead-qualification',
          created_at: '2026-08-24T16:00:01.000Z',
        }],
      });
      const { reconcileLeadNotificationDeliveries } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const processed = await reconcileLeadNotificationDeliveries({
        now: deliveryNow,
        limit: 2,
        pendingLeaseMs: 30 * 60_000,
      });

      expect(processed).toBe(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(mockMainDb!.getRows('notifications')).toHaveLength(1);
      expect(mockMainDb!.getRows('deadline_notification_log')).toEqual([
        expect.objectContaining({
          id: 'pending-delivery-log',
          tg_sent: true,
          tg_message_id: 42,
          tg_error: null,
        }),
      ]);
      const pendingClaim = mockMainDb!.updates.find((call) =>
        call.table === 'deadline_notification_log' &&
        call.patch.tg_error === 'Lead notification retry in progress'
      );
      expect(pendingClaim?.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ column: 'id', op: 'eq', value: 'pending-delivery-log' }),
        expect.objectContaining({ column: 'tg_sent', op: 'is', value: null }),
        expect.objectContaining({ column: 'tg_sent_at', op: 'is', value: null }),
      ]));
    });

    it('retries a failed delivery after backoff and skips a completed delivery', async () => {
      installLeadNotificationRecoveryFixture({
        logRow: {
          id: 'failed-delivery-log',
          entity_type: 'lead_qualification',
          entity_id: 'recoverable-lead-qualification',
          level: 'specialist',
          created_at: '2026-08-24T16:00:00.000Z',
          tg_sent: false,
          tg_message_id: null,
          tg_error: 'Telegram 503',
          tg_sent_at: '2026-08-24T17:30:00.000Z',
        },
      });
      const { reconcileLeadNotificationDeliveries } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const beforeBackoff = await reconcileLeadNotificationDeliveries({
        now: new Date('2026-08-24T17:40:00.000Z'),
        limit: 2,
        failedBackoffMs: 15 * 60_000,
      });
      const retried = await reconcileLeadNotificationDeliveries({
        now: deliveryNow,
        limit: 2,
        failedBackoffMs: 15 * 60_000,
      });
      const completed = await reconcileLeadNotificationDeliveries({
        now: new Date(deliveryNow.getTime() + 60 * 60_000),
        limit: 2,
        failedBackoffMs: 15 * 60_000,
      });

      expect(beforeBackoff).toBe(0);
      expect(retried).toBe(1);
      expect(completed).toBe(0);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(mockMainDb!.getRows('deadline_notification_log')).toEqual([
        expect.objectContaining({
          id: 'failed-delivery-log',
          tg_sent: true,
          tg_error: null,
        }),
      ]);
      const failedClaim = mockMainDb!.updates.find((call) =>
        call.table === 'deadline_notification_log' &&
        call.patch.tg_error === 'Lead notification retry in progress'
      );
      expect(failedClaim?.filters).toEqual(expect.arrayContaining([
        expect.objectContaining({ column: 'id', op: 'eq', value: 'failed-delivery-log' }),
        expect.objectContaining({ column: 'tg_sent', op: 'eq', value: false }),
        expect.objectContaining({
          column: 'tg_sent_at',
          op: 'eq',
          value: '2026-08-24T17:30:00.000Z',
        }),
      ]));
    });

    it('fails closed on cross-project ownership and retries only the correct specialist after cleanup', async () => {
      installLeadNotificationRecoveryFixture();
      const leadRow = mockInstantlyDb!.getRows('instantly_lead_qualifications')[0];
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
            { project_id: 'stale-project', campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          instantly_lead_qualifications: [leadRow],
        },
      });
      mockMainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
            { id: 'stale-project', client: 'Foreign', specialist_user_id: 'foreign-specialist' },
          ],
          profiles: [
            { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
            { id: 'foreign-specialist', full_name: 'Чужой специалист', email: 'foreign@example.com' },
          ],
          telegram_links: [
            { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
            { user_id: 'foreign-specialist', telegram_id: '111', telegram_username: null },
          ],
          notifications: [],
          deadline_notification_log: [],
        },
      });
      const { reconcileLeadNotificationDeliveries } = await import(
        '@/lib/instantly/leadQualificationWorker'
      );

      const blocked = await reconcileLeadNotificationDeliveries({
        now: deliveryNow,
        limit: 2,
      });

      expect(blocked).toBe(1);
      expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
      expect(mockMainDb!.getRows('notifications')).toHaveLength(0);
      const failedLog = mockMainDb!.getRows('deadline_notification_log')[0];
      expect(failedLog).toEqual(expect.objectContaining({
        tg_sent: false,
        tg_error: expect.stringContaining('multiple project owners'),
        tg_sent_at: deliveryNow.toISOString(),
      }));

      // Hourly catalog cleanup removes the stale owner; the same failed log is
      // then retried in place and only the proven specialist receives it.
      mockInstantlyDb = createMockSupabase({
        tables: {
          project_instantly_campaigns: [
            { project_id: 'project-1', campaign_id: 'linked-campaign', match_source: 'auto' },
          ],
          project_period_instantly_campaigns: [],
          instantly_lead_qualifications: [leadRow],
        },
      });
      mockMainDb = createMockSupabase({
        tables: {
          projects: [
            { id: 'project-1', client: 'ENagency', specialist_user_id: 'specialist-1' },
            { id: 'stale-project', client: 'Foreign', specialist_user_id: 'foreign-specialist' },
          ],
          profiles: [
            { id: 'specialist-1', full_name: 'Глеб', email: 'gleb@example.com' },
            { id: 'foreign-specialist', full_name: 'Чужой специалист', email: 'foreign@example.com' },
          ],
          telegram_links: [
            { user_id: 'specialist-1', telegram_id: '428599712', telegram_username: null },
            { user_id: 'foreign-specialist', telegram_id: '111', telegram_username: null },
          ],
          notifications: [],
          deadline_notification_log: [failedLog],
        },
      });

      const recovered = await reconcileLeadNotificationDeliveries({
        now: new Date(deliveryNow.getTime() + 15 * 60_000),
        limit: 2,
        failedBackoffMs: 15 * 60_000,
      });

      expect(recovered).toBe(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledTimes(1);
      expect(sendLeadTelegramAlert).toHaveBeenCalledWith(expect.objectContaining({
        specialistMentions: [expect.objectContaining({ userId: 'specialist-1' })],
      }));
      expect(mockMainDb!.getRows('notifications')).toEqual([
        expect.objectContaining({ user_id: 'specialist-1' }),
      ]);
      expect(mockMainDb!.getRows('deadline_notification_log')).toEqual([
        expect.objectContaining({ id: failedLog.id, tg_sent: true }),
      ]);
    });
  });

  it('persists a durable webhook retry without touching the unavailable requeue path', async () => {
    const { providerCampaignId, inbound } = installMailboxOwnershipConflictFixture({
      mappingError: new Error('Instantly API 503: Service Unavailable'),
      webhookRequeueError: 'database connection closed during requeue',
    });
    await mockInstantlyDb!.from('instantly_webhook_events').insert({
      id: 'ownership-requeue-failed-event',
      event_type: 'reply_received',
      campaign_id: providerCampaignId,
      lead_email: inbound.from_address_email,
      thread_id: inbound.thread_id,
      created_at: '2026-08-21T00:00:00.000Z',
      processed: false,
    });

    await withWebhookDrainEnabled(async () => {
      const { drainWebhookQueue } = await import('@/lib/instantly/leadQualificationWorker');
      expect(await drainWebhookQueue()).toBe(0);
    });

    expect(mockInstantlyDb!.getRows('instantly_webhook_events')).toEqual([
      expect.objectContaining({ processed: true }),
    ]);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: inbound.id,
        status: 'needs_review',
        webhook_event_id: 'ownership-requeue-failed-event',
        error_message: expect.stringContaining('503'),
      }),
    ]);
  });

  it('writes a visible error when a young empty webhook context cannot be requeued', async () => {
    const { providerCampaignId, inbound } = installMailboxOwnershipConflictFixture({
      webhookRequeueError: 'database connection closed during empty-context requeue',
    });
    fetchThreadContext.mockResolvedValue(null);
    await mockInstantlyDb!.from('instantly_webhook_events').insert({
      id: 'empty-context-requeue-failed-event',
      event_type: 'reply_received',
      campaign_id: providerCampaignId,
      lead_email: inbound.from_address_email,
      thread_id: inbound.thread_id,
      created_at: new Date(Date.now() - 10_000).toISOString(),
      processed: false,
    });

    await withWebhookDrainEnabled(async () => {
      const { drainWebhookQueue } = await import('@/lib/instantly/leadQualificationWorker');
      expect(await drainWebhookQueue()).toBe(0);
    });

    expect(mockInstantlyDb!.getRows('instantly_webhook_events')).toEqual([
      expect.objectContaining({ processed: true }),
    ]);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        instantly_email_id: 'webhook:empty-context-requeue-failed-event',
        status: 'error',
        webhook_event_id: 'empty-context-requeue-failed-event',
        error_message: expect.stringContaining('empty-context requeue'),
      }),
    ]);
  });

  it('reopens the webhook event if the durable retry row cannot be upserted', async () => {
    const { providerCampaignId, inbound } = installMailboxOwnershipConflictFixture({
      mappingError: new Error('Instantly API 503: Service Unavailable'),
      qualificationUpsertError: { code: '08006', message: 'database unavailable' },
    });
    await mockInstantlyDb!.from('instantly_webhook_events').insert({
      id: 'ownership-error-insert-failed-event',
      event_type: 'reply_received',
      campaign_id: providerCampaignId,
      lead_email: inbound.from_address_email,
      thread_id: inbound.thread_id,
      created_at: '2026-08-21T00:00:00.000Z',
      processed: false,
    });

    await withWebhookDrainEnabled(async () => {
      const { drainWebhookQueue } = await import('@/lib/instantly/leadQualificationWorker');
      expect(await drainWebhookQueue()).toBe(0);
    });

    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toHaveLength(0);
    expect(mockInstantlyDb!.getRows('instantly_webhook_events')).toEqual([
      expect.objectContaining({ processed: false }),
    ]);
  });

  it('routes a late reply when one completed exact-mailbox mapping proves one owner', async () => {
    const { candidateCampaignIds } = installMailboxOwnershipConflictFixture();
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: candidateCampaignIds[0], status: 3 },
    ]);

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);
    expect(qualifyReply.mock.calls[0]?.[0]).toBe(candidateCampaignIds[0]);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({ status: 'lead', campaign_id: candidateCampaignIds[0] }),
    ]);
  });

  it('does not auto-route conflicting historical-only mappings without a strong outbound parent', async () => {
    const { candidateCampaignIds } = installMailboxOwnershipConflictFixture();
    getAccountCampaignMappings.mockResolvedValue(
      candidateCampaignIds.map((campaign_id) => ({ campaign_id, status: 3 })),
    );

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);

    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        status: 'needs_review',
        ai_reason: expect.stringContaining('historical'),
      }),
    ]);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
  });

  it.each([2, 4])('treats mailbox mapping status %s as current rather than historical', async (status) => {
    const { providerCampaignId } = installMailboxOwnershipConflictFixture();
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: providerCampaignId, status },
    ]);

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);
    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({ status: 'lead', campaign_id: providerCampaignId }),
    ]);
  });

  it('recovers a strong inactive parent even when the provider campaign is currently active', async () => {
    const { providerCampaignId, candidateCampaignIds, ownerMailbox, inbound } =
      installMailboxOwnershipConflictFixture();
    const historicalCampaignId = candidateCampaignIds[0];
    const historicalOutbound = replyEmail({
      id: 'historical-parent',
      campaign_id: historicalCampaignId,
      from_address_email: ownerMailbox,
      to_address_email_list: inbound.from_address_email,
      eaccount: ownerMailbox,
      lead: inbound.from_address_email,
      thread_id: `05-${inbound.thread_id}`,
      ue_type: 1,
      timestamp_email: '2026-05-12T12:00:00.000Z',
      body: { text: 'Подробное предложение старой кампании.' },
    });
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: providerCampaignId, status: 1 },
      { campaign_id: historicalCampaignId, status: 3 },
    ]);
    listEmails.mockImplementation(async (params: { search?: string; email_type?: string }) =>
      params.search
        ? { items: [inbound, historicalOutbound], next_starting_after: null }
        : { items: [inbound], next_starting_after: null },
    );

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);
    expect(qualifyReply.mock.calls[0]?.[0]).toBe(historicalCampaignId);
    expect(qualifyReply.mock.calls[0]?.[3]?.prefetchedContext?.lastOutbound?.id)
      .toBe('historical-parent');
  });

  it('uses the bounded sent fallback when workspace search has only an unrelated outbound', async () => {
    const { providerCampaignId, candidateCampaignIds, ownerMailbox, inbound } =
      installMailboxOwnershipConflictFixture();
    const historicalCampaignId = candidateCampaignIds[0];
    const unrelatedCurrentOutbound = replyEmail({
      id: 'unrelated-current-outbound',
      campaign_id: providerCampaignId,
      eaccount: ownerMailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: 'different-current-thread',
      ue_type: 1,
      timestamp_email: '2026-05-12T11:00:00.000Z',
      body: { text: 'Другая переписка текущей кампании.' },
    });
    const historicalParent = replyEmail({
      id: 'fallback-historical-parent',
      campaign_id: historicalCampaignId,
      eaccount: ownerMailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: `05-${inbound.thread_id}`,
      ue_type: 1,
      timestamp_email: '2026-05-12T10:00:00.000Z',
      body: { text: 'Настоящее исходное предложение.' },
    });
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: providerCampaignId, status: 1 },
      { campaign_id: historicalCampaignId, status: 3 },
    ]);
    listEmails.mockImplementation(async (params: { search?: string; email_type?: string }) => {
      if (params.email_type === 'sent') {
        return { items: [historicalParent], next_starting_after: null };
      }
      if (params.search) {
        return { items: [inbound, unrelatedCurrentOutbound], next_starting_after: null };
      }
      return { items: [inbound], next_starting_after: null };
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);
    expect(qualifyReply.mock.calls[0]?.[0]).toBe(historicalCampaignId);
    expect(qualifyReply.mock.calls[0]?.[3]?.prefetchedContext?.lastOutbound?.id)
      .toBe('fallback-historical-parent');
  });

  it('does not let a provider-polluted copy suppress the same email id in another campaign', async () => {
    const { providerCampaignId, candidateCampaignIds, ownerMailbox, inbound } =
      installMailboxOwnershipConflictFixture();
    const realCampaignId = candidateCampaignIds[0];
    const pollutedCopy = replyEmail({
      id: 'provider-polluted-parent-id',
      campaign_id: providerCampaignId,
      eaccount: ownerMailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: `9c-${inbound.thread_id}`,
      ue_type: 1,
      timestamp_email: '2026-05-12T10:00:00.000Z',
    });
    const realCopy = {
      ...pollutedCopy,
      campaign_id: realCampaignId,
      thread_id: `05-${inbound.thread_id}`,
    } as Email;
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: providerCampaignId, status: 1 },
      { campaign_id: realCampaignId, status: 1 },
    ]);
    listEmails.mockResolvedValue({ items: [realCopy], next_starting_after: null });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail: inbound.from_address_email ?? '',
      accountId: 'main',
      prefetchedContext: {
        replyEmail: inbound,
        threadEmails: [pollutedCopy, inbound],
        lastOutbound: pollutedCopy,
        campaignOutboundMailboxes: [ownerMailbox],
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous' }));
  });

  it('checks sent evidence before trusting one strong cross-owner search result', async () => {
    const { candidateCampaignIds, ownerMailbox, inbound } =
      installMailboxOwnershipConflictFixture();
    const searchedCopy = replyEmail({
      id: 'cross-owner-shared-parent-id',
      campaign_id: candidateCampaignIds[0],
      eaccount: ownerMailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: `05-${inbound.thread_id}`,
      ue_type: 1,
      timestamp_email: '2026-05-12T10:00:00.000Z',
    });
    const sentCopy = {
      ...searchedCopy,
      campaign_id: candidateCampaignIds[1],
      thread_id: `06-${inbound.thread_id}`,
    } as Email;
    listEmails.mockImplementation(async (params: {
      search?: string;
      email_type?: string;
    }) => {
      if (params.search) {
        return { items: [searchedCopy], next_starting_after: null };
      }
      if (params.email_type === 'sent') {
        return { items: [sentCopy], next_starting_after: null };
      }
      return { items: [inbound], next_starting_after: null };
    });

    const { pollAndQualifyReplies } = await import('@/lib/instantly/leadQualificationWorker');
    expect(await pollAndQualifyReplies()).toBe(1);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({ status: 'needs_review' }),
    ]);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendLeadTelegramAlert).not.toHaveBeenCalled();
    expect(listEmails.mock.calls.filter(
      ([params]) => (params as { email_type?: string }).email_type === 'sent',
    )).toHaveLength(1);
  });

  it.each([
    {
      label: 'reply timestamp is missing',
      replyTimestamp: undefined,
      outboundTimestamp: '2026-05-14T10:00:00.000Z',
    },
    {
      label: 'outbound timestamp is missing',
      replyTimestamp: '2026-05-13T12:00:00.000Z',
      outboundTimestamp: undefined,
    },
  ])('does not correct ownership from an unprovable temporal order when $label', async ({
    replyTimestamp,
    outboundTimestamp,
  }) => {
    const { providerCampaignId, candidateCampaignIds, ownerMailbox, inbound } =
      installMailboxOwnershipConflictFixture();
    const realCampaignId = candidateCampaignIds[0];
    inbound.timestamp_email = replyTimestamp;
    inbound.timestamp_created = undefined;
    const undatedOrFutureOutbound = replyEmail({
      id: 'temporally-unproven-parent',
      campaign_id: realCampaignId,
      eaccount: ownerMailbox,
      lead: inbound.from_address_email,
      to_address_email_list: inbound.from_address_email,
      thread_id: `05-${inbound.thread_id}`,
      ue_type: 1,
      timestamp_email: outboundTimestamp,
      timestamp_created: undefined,
    });
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: providerCampaignId, status: 1 },
      { campaign_id: realCampaignId, status: 1 },
    ]);
    listEmails.mockResolvedValue({
      items: [undatedOrFutureOutbound],
      next_starting_after: null,
    });

    const { resolveEffectiveReplyOwner } = await import(
      '@/lib/instantly/replyOwnershipResolver'
    );
    const result = await resolveEffectiveReplyOwner({
      db: mockInstantlyDb! as unknown as Parameters<typeof resolveEffectiveReplyOwner>[0]['db'],
      reply: inbound,
      providerCampaignId,
      leadEmail: inbound.from_address_email ?? '',
      accountId: 'main',
      prefetchedContext: {
        replyEmail: inbound,
        threadEmails: [inbound],
        lastOutbound: null,
        campaignOutboundMailboxes: [ownerMailbox],
      },
    });

    expect(result).toEqual(expect.objectContaining({ status: 'ambiguous' }));
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
    listEmails.mockReset().mockResolvedValue({ items: [], next_starting_after: null });
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
        qualified_project_id: null,
        qualified_project_owner_proven: true,
        reply_out_of_campaign: true,
        eaccount: 'sales@clientmail.ru',
      }),
    );
  });

  it('доверяет уже найденному Others-вотчдогом исходящему письму при нескольких владельцах ящика', async () => {
    const mailbox = 'sales@clientmail.ru';
    const inbound = replyEmail({
      id: 'others-multi-owner-reply',
      campaign_id: 'self-serve-campaign',
      eaccount: mailbox,
      to_address_email_list: mailbox,
      thread_id: 'others-orphan-thread',
      subject: 'Re: Тема аутрича',
      body: { text: 'Давайте созвонимся' },
    });
    const matchedOutbound = replyEmail({
      id: 'others-watchdog-parent',
      campaign_id: 'self-serve-campaign',
      from_address_email: mailbox,
      to_address_email_list: 'original.lead@company.example',
      eaccount: mailbox,
      lead: 'original.lead@company.example',
      thread_id: 'different-provider-thread',
      subject: 'Тема аутрича',
      ue_type: 1,
      body: { text: 'Короткое исходящее без цитаты в ответе.' },
      timestamp_email: '2026-05-12T12:00:00Z',
    });
    getAccountCampaignMappings.mockResolvedValue([
      { campaign_id: 'self-serve-campaign', status: 1 },
      { campaign_id: 'competing-campaign', status: 1 },
    ]);
    listEmails.mockRejectedValue(new Error('Instantly API 503: should not be called'));
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
          {
            client_user_id: 'client-8',
            resource_type: 'campaign',
            resource_id: 'competing-campaign',
            instantly_account_id: 'main',
          },
        ],
        client_reply_telegram_links: [
          { client_user_id: 'client-7', chat_id: 111, enabled: true },
        ],
      },
    });

    const { qualifyOneReply } = await import('@/lib/instantly/leadQualificationWorker');
    await qualifyOneReply(
      mockInstantlyDb! as unknown as Parameters<typeof qualifyOneReply>[0],
      inbound,
      'test-ai-key',
      'main',
      {
        replyEmail: inbound,
        threadEmails: [matchedOutbound, inbound],
        lastOutbound: matchedOutbound,
        campaignOutboundMailboxes: [mailbox],
      },
      {
        clientDmOnlyOnLead: true,
        outOfCampaign: false,
        prefetchedParentMatched: true,
      } as Parameters<typeof qualifyOneReply>[5],
    );

    expect(qualifyReply).toHaveBeenCalledTimes(1);
    expect(mockInstantlyDb!.getRows('instantly_lead_qualifications')).toEqual([
      expect.objectContaining({
        campaign_id: 'self-serve-campaign',
        instantly_email_id: 'others-multi-owner-reply',
        status: 'lead',
      }),
    ]);
    expect(sendClientReplyTelegram).toHaveBeenCalledTimes(1);
    expect(listEmails).not.toHaveBeenCalled();
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

  it('окно «код без owner-snapshot миграции»: self-serve ответ откладывается без AI и побочных эффектов', async () => {
    mockInstantlyDb = createMockSupabase({
      tables: {
        project_instantly_campaigns: [],
        project_period_instantly_campaigns: [],
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
          columnsInclude: 'qualified_project_id',
          message: 'column instantly_lead_qualifications.qualified_project_id does not exist',
        },
      },
    });

    const { qualifyOneReply } = await import('@/lib/instantly/leadQualificationWorker');
    await expect(
      qualifyOneReply(
        mockInstantlyDb! as unknown as Parameters<typeof qualifyOneReply>[0],
        replyEmail({
          id: 'snapshot-pre-migration-self-serve',
          campaign_id: 'self-serve-campaign',
          eaccount: 'team@outreach-contact.ru',
          body: { text: 'Давайте созвонимся' },
        }),
        'test-ai-key',
        'main',
        null,
        { clientDmOnlyOnLead: true },
      ),
    ).rejects.toThrow(/Reply ownership deferred.*migration is not available/);

    const rows = mockInstantlyDb!.getRows('instantly_lead_qualifications');
    expect(rows).toHaveLength(0);
    expect(qualifyReply).not.toHaveBeenCalled();
    expect(sendClientReplyTelegram).not.toHaveBeenCalled();
  });
});
