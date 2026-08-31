/** @jest-environment node */

/**
 * Regression: when welcome was delivered (welcome_sent_at IS NOT NULL), the
 * runner MUST still process the first message-step. The earlier "dedup"
 * logic short-circuited the step on the assumption that welcome and the
 * first follow-up were duplicates of the same intent — which silently broke
 * the SaaS Никита campaign in prod 2026-05, where welcome and the first
 * message step have different content (welcome = "thanks for connecting,
 * here's who we are"; message = real follow-up with examples 2 days later).
 *
 * Desired behaviour:
 *   - welcome_sent_at SET on the campaign-lead row → message-step still runs.
 *   - sendMessage is called with the rendered text (placeholders substituted).
 *   - Lead is advanced to current_step+1 and marked completed (or in_progress
 *     if more steps remain).
 */

import { createLiOutreachMockDb } from '../helpers/liOutreachDb';

const mockDb = createLiOutreachMockDb();
const dbState = mockDb.state;

mockDb.registerRpc('li_campaign_increment_invite', async () => ({ data: 1, error: null }));

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb.client;
  },
}));

const sendMessageArgs: Array<{ chatId: string; text: string }> = [];
const startChatArgs: Array<{ providerId: string; message: string | null | undefined }> = [];

jest.mock('@/lib/liOutreach/unipileClient', () => {
  class UnipileError extends Error {
    status: number;
    body: string;
    constructor(message: string, status: number, body: string) {
      super(message);
      this.name = 'UnipileError';
      this.status = status;
      this.body = body;
    }
  }
  class UnipileClient {
    constructor(_dsn: string, _key: string, _accountId?: string | null) {}
    sendInvite(): Promise<Record<string, unknown>> {
      return Promise.resolve({ id: 'invite-ok' });
    }
    getProviderId(): Promise<string> {
      return Promise.resolve('provider-already-set');
    }
    sendMessage(chatId: string, text: string): Promise<Record<string, unknown>> {
      sendMessageArgs.push({ chatId, text });
      return Promise.resolve({ id: 'msg-ok' });
    }
    startChat(providerId: string, message?: string | null): Promise<Record<string, unknown>> {
      startChatArgs.push({ providerId, message });
      return Promise.resolve({ id: 'chat-new-uuid' });
    }
  }
  return {
    UnipileClient,
    UnipileError,
    extractPublicIdentifier: (s: string): string | null => s,
    extractActivityUrn: (): null => null,
  };
});

jest.mock('@/lib/liOutreach/aiService', () => {
  const actual = jest.requireActual('@/lib/liOutreach/aiService');
  return {
    parseMessageTemplate: actual.parseMessageTemplate,
    leadToInfo: (lead: { name?: string; first_name?: string | null; last_name?: string | null; company?: string | null; position?: string | null }) => ({
      name: lead.name,
      first_name: lead.first_name,
      last_name: lead.last_name,
      company: lead.company,
      position: lead.position,
    }),
    personalizeInviteMessage: async (s: string): Promise<string> => s,
    personalizeFollowUp: async (s: string): Promise<string> => s,
  };
});

import { runCampaignTick } from '@/lib/liOutreach/campaignRunner';

const CAMPAIGN_ID = 'camp-after-welcome';
const USER_ID = 'user-1';
const ACCOUNT_ID = 'acc-1';
const LEAD_ID = 'lead-kim';
const CHAT_ID = 'chat-already-opened-by-welcome';

function seed(): void {
  mockDb.reset();
  sendMessageArgs.length = 0;
  startChatArgs.length = 0;

  dbState.rows.li_campaigns = [
    {
      id: CAMPAIGN_ID,
      user_id: USER_ID,
      name: 'SaaS Никита',
      account_id: ACCOUNT_ID,
      lead_list_id: null,
      status: 'running',
      steps: [
        { type: 'invite', message: 'Hi {{first_name}}, want to connect?' },
        { type: 'wait', days: 2 },
        {
          type: 'message',
          message:
            'Hi {{first_name}}, following up with real examples for {{company}}.',
        },
      ],
      use_ai: false,
      use_ai_followup: false,
      ai_prompt_invite: null,
      ai_prompt_chat: null,
      stop_on_reply: true,
      // Пауза между лидами — 0: runCampaignTick честно спит min_delay секунд
      // на каждом лиде, и с единицей этот файл пережидал их по-настоящему.
      // Человекоподобный интервал проверяется не здесь.
      min_delay: 0,
      max_delay: 0,
      daily_invite_limit: 25,
      invites_sent_today: 0,
      last_invite_date: new Date().toISOString().slice(0, 10),
      welcome_message: 'Thanks for connecting, {{first_name}}!',
      message_existing_connections: false,
      use_ai_welcome: false,
    },
  ];
  dbState.rows.li_settings = [
    {
      id: 's-1',
      user_id: USER_ID,
      unipile_dsn: 'api.example.com:443',
      unipile_api_key: 'k',
      webhook_secret: '',
      proxy_url: '',
    },
  ];
  dbState.rows.li_accounts = [
    {
      id: ACCOUNT_ID,
      user_id: USER_ID,
      unipile_account_id: 'unipile-acc-1',
      name: 'Test acc',
      is_active: true,
      cooldown_until: null,
      cooldown_reason: null,
    },
  ];
  dbState.rows.li_leads = [
    {
      id: LEAD_ID,
      user_id: USER_ID,
      lead_list_id: null,
      linkedin_id: 'provider-kim',
      public_identifier: 'kim-medina',
      profile_url: 'https://www.linkedin.com/in/kim-medina',
      name: 'Kim Medina',
      first_name: 'Kim',
      last_name: 'Medina',
      position: 'CEO',
      company: 'Polza Agency',
      // chat_id IS present because the welcome handler opened the chat already.
      chat_id: CHAT_ID,
      // status 'connected' so we don't fall into the "not accepted yet" guard.
      status: 'connected',
      account_id: ACCOUNT_ID,
      conversation_history: [],
      extra_data: {},
      last_activity: null,
    },
  ];
  dbState.rows.li_campaign_leads = [
    {
      id: 'cl-kim',
      campaign_id: CAMPAIGN_ID,
      lead_id: LEAD_ID,
      current_step: 2, // message step (after wait)
      status: 'in_progress',
      next_action_at: null,
      user_replied: false,
      invite_accepted: true,
      // THE point of this test: welcome WAS delivered. Previously this
      // suppressed the message step. After removing the dedup, the message
      // step must still fire.
      welcome_sent_at: '2026-05-26T04:28:30.000Z',
      error_message: null,
      created_at: '2026-01-01T00:00:00.000Z',
      lead: dbState.rows.li_leads[0],
    },
  ];
  dbState.rows.li_campaign_logs = [];
}

describe('processMessageStep — welcome_sent_at no longer suppresses the message step', () => {
  beforeEach(() => seed());

  it('still calls sendMessage when welcome was already delivered', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(sendMessageArgs).toHaveLength(1);
    expect(startChatArgs).toHaveLength(0); // chat_id was set by welcome → use sendMessage
    expect(sendMessageArgs[0]!.chatId).toBe(CHAT_ID);
  });

  it('renders the message template with the lead\'s data', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const sent = sendMessageArgs[0]?.text ?? '';
    expect(sent).toContain('Hi Kim,');
    expect(sent).toContain('Polza Agency');
    // No raw placeholders.
    expect(sent).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it('advances current_step + marks the campaign-lead completed', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const cl = dbState.rows.li_campaign_leads.find((r) => r.id === 'cl-kim') as
      | { current_step: number; status: string }
      | undefined;
    expect(cl).toBeDefined();
    expect(cl!.current_step).toBe(3); // moved past the last (message) step
    expect(cl!.status).toBe('completed');
  });

  it('does NOT log "Шаг message пропущен" (the old dedup branch)', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const skipLogs = (dbState.rows.li_campaign_logs as Array<{ message: string }>).filter((l) =>
      l.message?.includes('Шаг message пропущен'),
    );
    expect(skipLogs).toHaveLength(0);
  });
});
