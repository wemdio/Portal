/** @jest-environment node */

/**
 * Regression: when a follow-up message-step opens a chat via `client.startChat`
 * (because the welcome webhook didn't preset chat_id), the message passed to
 * startChat MUST be the rendered text (template + AI), not raw `step.message`.
 *
 * The old runner ran startChat BEFORE parseMessageTemplate + AI, so the first
 * line in every freshly-opened chat went out literally as e.g.
 *   "Hi {{first_name}}! Just following up..."
 * and was then immediately followed by a properly-rendered duplicate sent via
 * sendMessage — leads received the same paragraph twice, once garbled, once
 * clean (см. prod 2026-05 reports на Emma Seymour / Barrie Hadfield).
 *
 * Desired behaviour after the fix:
 *   1. The argument passed to client.startChat has placeholders substituted.
 *   2. sendMessage is NOT additionally called after a successful startChat
 *      (otherwise we send the same text twice).
 *   3. The lead's chat_id is recorded so the next tick uses sendMessage.
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

const startChatArgs: Array<{ providerId: string; message: string | null | undefined }> = [];
const sendMessageArgs: Array<{ chatId: string; text: string }> = [];

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

// Use the real parseMessageTemplate so the test asserts on actual rendering
// behaviour, not on identity-mock output. leadToInfo is identity-shaped here.
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

const CAMPAIGN_ID = 'camp-1';
const USER_ID = 'user-1';
const ACCOUNT_ID = 'acc-1';
const LEAD_ID = 'lead-emma';

function seed(): void {
  mockDb.reset();
  startChatArgs.length = 0;
  sendMessageArgs.length = 0;

  dbState.rows.li_campaigns = [
    {
      id: CAMPAIGN_ID,
      user_id: USER_ID,
      name: 'Loya мягкий',
      account_id: ACCOUNT_ID,
      lead_list_id: null,
      status: 'running',
      steps: [
        { type: 'invite', message: 'Hi {{first_name}}!' },
        { type: 'wait', days: 2 },
        {
          type: 'message',
          message:
            'Hi {{first_name}}! Just following up. If relevant for {{company}}, let me know.',
        },
      ],
      use_ai: true,
      use_ai_followup: false, // GPT off — pure template substitution is enough to prove the bug.
      ai_prompt_invite: null,
      ai_prompt_chat: null,
      stop_on_reply: true,
      min_delay: 1,
      max_delay: 1,
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
      openai_api_key: '',
      openai_model: 'gpt-4o-mini',
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
      linkedin_id: 'provider-emma',
      public_identifier: 'emma-seymour-fcipd',
      profile_url: 'https://www.linkedin.com/in/emma-seymour-fcipd',
      name: 'Emma Seymour',
      first_name: 'Emma',
      last_name: 'Seymour',
      position: 'Senior Partner',
      company: 'Gratiya Advisory',
      // Crucial: chat_id NULL because the welcome webhook never opened a chat
      // (this is the exact prod-state for the regression we're guarding against).
      chat_id: null,
      // status 'connected' so the message-step actually runs (the 'invited' branch
      // would defer with next_action_at — that's the OTHER regression covered by
      // liOutreachMessageStepGuard.test.ts).
      status: 'connected',
      account_id: ACCOUNT_ID,
      conversation_history: [],
      extra_data: {},
      last_activity: null,
    },
  ];
  dbState.rows.li_campaign_leads = [
    {
      id: 'cl-emma',
      campaign_id: CAMPAIGN_ID,
      lead_id: LEAD_ID,
      current_step: 2, // message step
      status: 'in_progress',
      next_action_at: null,
      user_replied: false,
      invite_accepted: true,
      welcome_sent_at: null, // welcome NEVER got delivered → no dedup → message step runs
      error_message: null,
      created_at: '2026-01-01T00:00:00.000Z',
      lead: dbState.rows.li_leads[0],
    },
  ];
  dbState.rows.li_campaign_logs = [];
}

describe('processMessageStep — startChat receives rendered message (no raw {{placeholders}})', () => {
  beforeEach(() => seed());

  it('passes parseMessageTemplate-rendered text to startChat, not raw step.message', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(startChatArgs).toHaveLength(1);
    const sent = startChatArgs[0]!.message ?? '';
    // The lead's first_name ("Emma") and company ("Gratiya Advisory") must be substituted.
    expect(sent).toContain('Hi Emma!');
    expect(sent).toContain('Gratiya Advisory');
    // And no leftover placeholders.
    expect(sent).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it('does NOT also call sendMessage after a successful startChat (would double-send)', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(startChatArgs).toHaveLength(1);
    expect(sendMessageArgs).toHaveLength(0);
  });

  it('persists the new chat_id to li_leads so the next tick uses sendMessage path', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const leadUpdates = dbState.updates.filter(
      (u) => u.table === 'li_leads' && u.filters.id === LEAD_ID,
    );
    const chatIdWrite = leadUpdates.find((u) => u.data.chat_id === 'chat-new-uuid');
    expect(chatIdWrite).toBeTruthy();
  });

  it('advances the campaign-lead step (treats startChat as the message send)', async () => {
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const clUpdates = dbState.updates.filter(
      (u) => u.table === 'li_campaign_leads' && u.filters.id === 'cl-emma',
    );
    // Final update should move current_step from 2 to 3 (and the campaign has
    // 3 steps total → status becomes 'completed').
    const advance = clUpdates.find((u) => u.data.current_step === 3);
    expect(advance).toBeTruthy();
    expect(advance!.data.status).toBe('completed');
  });
});
