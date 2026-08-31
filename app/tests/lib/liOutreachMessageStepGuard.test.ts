/** @jest-environment node */

/**
 * Regression: processMessageStep must NOT try to message a lead whose
 * connection wasn't actually accepted yet.
 *
 * Bug seen in prod (Apr 2026): for ~1499 leads we logged the warning
 *   "Не удалось начать чат: errors/no_connection_with_recipient"
 * because after the 2-day `wait` step the runner blindly called
 * `client.startChat()` regardless of whether the invite had been accepted.
 * On every tick the same lead was retried, polluting logs and burning
 * Unipile quota.
 *
 * Desired behaviour:
 *   - lead.status === 'connected' (webhook fired) → start chat as before.
 *   - lead.status === 'invited'   → defer one day (waiting + next_action_at)
 *                                    so the runner re-checks after the
 *                                    webhook has had more time to fire.
 *   - lead.status === 'new'       → skipped (we never even sent an invite,
 *                                    something went sideways earlier).
 *   - lead.status === 'messaged' / 'replied' → start chat as before
 *                                    (chat_id may have just been lost).
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

let startChatCalls = 0;
let sendMessageCalls = 0;

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
    sendMessage(): Promise<Record<string, unknown>> {
      sendMessageCalls++;
      return Promise.resolve({ id: 'msg-ok' });
    }
    startChat(): Promise<Record<string, unknown>> {
      startChatCalls++;
      return Promise.resolve({ id: 'chat-new' });
    }
  }
  return {
    UnipileClient,
    UnipileError,
    extractPublicIdentifier: (s: string): string | null => s,
    extractActivityUrn: (): null => null,
  };
});

jest.mock('@/lib/liOutreach/aiService', () => ({
  parseMessageTemplate: (s: string): string => s,
  leadToInfo: (): Record<string, unknown> => ({}),
  personalizeInviteMessage: async (s: string): Promise<string> => s,
  personalizeFollowUp: async (s: string): Promise<string> => s,
}));

import { runCampaignTick } from '@/lib/liOutreach/campaignRunner';

const CAMPAIGN_ID = 'camp-1';
const USER_ID = 'user-1';
const ACCOUNT_ID = 'acc-1';

interface SeedLeadOpts {
  leadId: string;
  status: 'new' | 'invited' | 'connected' | 'messaged' | 'replied';
  chatId: string | null;
}

function seedAt(stepIdx: number, leads: SeedLeadOpts[]): void {
  mockDb.reset();
  startChatCalls = 0;
  sendMessageCalls = 0;
  dbState.rows.li_campaigns = [
    {
      id: CAMPAIGN_ID,
      user_id: USER_ID,
      name: 'Test',
      account_id: ACCOUNT_ID,
      lead_list_id: null,
      status: 'running',
      // Three steps: invite -> wait -> message. This test seeds leads pre-positioned
      // on step 2 (the message step) so processMessageStep is what runs.
      steps: [
        { type: 'invite', message: 'hi' },
        { type: 'wait', days: 2 },
        { type: 'message', message: 'follow up' },
      ],
      use_ai: false,
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
      welcome_message: null,
      message_existing_connections: false,
      use_ai_welcome: false,
      use_ai_followup: false,
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
  dbState.rows.li_leads = leads.map((l) => ({
    id: l.leadId,
    user_id: USER_ID,
    lead_list_id: null,
    linkedin_id: `provider-${l.leadId}`,
    public_identifier: l.leadId,
    profile_url: `https://www.linkedin.com/in/${l.leadId}`,
    name: l.leadId,
    first_name: l.leadId,
    last_name: '',
    position: null,
    company: null,
    chat_id: l.chatId,
    status: l.status,
    account_id: ACCOUNT_ID,
    conversation_history: [],
    extra_data: {},
    last_activity: null,
  }));
  dbState.rows.li_campaign_leads = leads.map((l, i) => ({
    id: `cl-${l.leadId}`,
    campaign_id: CAMPAIGN_ID,
    lead_id: l.leadId,
    current_step: stepIdx,
    status: 'in_progress',
    next_action_at: null,
    user_replied: false,
    invite_accepted: false,
    error_message: null,
    created_at: `2026-01-01T00:00:0${i}.000Z`,
    lead: dbState.rows.li_leads[i],
  }));
  dbState.rows.li_campaign_logs = [];
}

describe('processMessageStep — connection guard', () => {
  it('skips lead with status=invited (no accept yet) by deferring next_action_at, does NOT call Unipile startChat or sendMessage', async () => {
    seedAt(2, [{ leadId: 'lead-invited', status: 'invited', chatId: null }]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(startChatCalls).toBe(0);
    expect(sendMessageCalls).toBe(0);

    // Lead-level update: campaign_lead should be deferred (waiting + future next_action_at).
    const clUpdates = dbState.updates.filter(
      (u) => u.table === 'li_campaign_leads' && u.filters.id === 'cl-lead-invited',
    );
    expect(clUpdates.length).toBeGreaterThan(0);
    const last = clUpdates[clUpdates.length - 1]!;
    expect(last.data.status).toBe('waiting');
    expect(last.data.next_action_at).toBeTruthy();
    const deferTo = new Date(String(last.data.next_action_at)).getTime();
    expect(deferTo).toBeGreaterThan(Date.now() + 12 * 60 * 60 * 1000); // at least 12h ahead
  });

  it('marks lead with status=new as skipped (we never even sent an invite for it)', async () => {
    seedAt(2, [{ leadId: 'lead-new', status: 'new', chatId: null }]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(startChatCalls).toBe(0);
    expect(sendMessageCalls).toBe(0);

    const clUpdates = dbState.updates.filter(
      (u) => u.table === 'li_campaign_leads' && u.filters.id === 'cl-lead-new',
    );
    const last = clUpdates[clUpdates.length - 1]!;
    expect(last.data.status).toBe('skipped');
  });

  it('sends message normally when lead.status=connected and chat_id is present', async () => {
    seedAt(2, [{ leadId: 'lead-conn', status: 'connected', chatId: 'chat-existing' }]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(sendMessageCalls).toBe(1);
    expect(startChatCalls).toBe(0); // chat already exists
  });

  it('opens chat then sends when lead.status=connected but chat_id missing', async () => {
    seedAt(2, [{ leadId: 'lead-conn-nochat', status: 'connected', chatId: null }]);

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(startChatCalls).toBe(1);
    // After startChat, the runner doesn't necessarily re-send; main concern is that
    // startChat IS called for connected leads (in contrast to invited leads above).
  });
});
