/** @jest-environment node */

/**
 * Regression: when the invite step can't resolve a lead's LinkedIn id because
 * the profile is unresolvable (Unipile 422 invalid_recipient — deleted /
 * private / bad public_identifier from import), the runner must mark that
 * campaign-lead 'skipped', NOT 'error'.
 *
 * Why: such leads never succeed on retry, and as 'error' they pile up red in
 * the campaign and get manually retried for nothing (prod 2026-05/06: 82 such
 * leads stuck in "Stape продажа в лоб"). 'skipped' keeps the funnel honest.
 * Genuinely transient resolve failures (timeout/5xx) still become 'error'.
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

// getProviderId throws the configured error; sendInvite should never be reached.
let getProviderIdError = 'Unipile 422: {"status":422,"type":"errors/invalid_recipient","title":"Recipient cannot be invited"}';
let sendInviteCalls = 0;

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
      sendInviteCalls++;
      return Promise.resolve({ id: 'invite-ok' });
    }
    getProviderId(): Promise<string> {
      return Promise.reject(new Error(getProviderIdError));
    }
    startChat(): Promise<Record<string, unknown>> {
      return Promise.resolve({ id: 'chat' });
    }
    sendMessage(): Promise<Record<string, unknown>> {
      return Promise.resolve({ id: 'msg' });
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
const LEAD_ID = 'lead-dead';

function seed(): void {
  mockDb.reset();
  sendInviteCalls = 0;

  dbState.rows.li_campaigns = [
    {
      id: CAMPAIGN_ID, user_id: USER_ID, name: 'Stape', account_id: ACCOUNT_ID, lead_list_id: null,
      status: 'running', steps: [{ type: 'invite', message: 'Hi' }],
      use_ai: false, ai_prompt_invite: null, ai_prompt_chat: null, stop_on_reply: true,
      min_delay: 1, max_delay: 1, daily_invite_limit: 25, invites_sent_today: 0,
      last_invite_date: new Date().toISOString().slice(0, 10),
      welcome_message: null, message_existing_connections: false, use_ai_welcome: false, use_ai_followup: false,
    },
  ];
  dbState.rows.li_settings = [
    { id: 's-1', user_id: USER_ID, unipile_dsn: 'api.example.com:443', unipile_api_key: 'k', webhook_secret: '', proxy_url: '' },
  ];
  dbState.rows.li_accounts = [
    { id: ACCOUNT_ID, user_id: USER_ID, unipile_account_id: 'unipile-acc-1', name: 'Acc', is_active: true, cooldown_until: null, cooldown_reason: null },
  ];
  dbState.rows.li_leads = [
    {
      id: LEAD_ID, user_id: USER_ID, lead_list_id: null,
      linkedin_id: null,            // <- forces a getProviderId resolve
      public_identifier: 'dead-profile',
      profile_url: 'https://www.linkedin.com/in/dead-profile',
      name: 'Dead Profile', first_name: 'Dead', last_name: 'Profile',
      position: null, company: null, chat_id: null, status: 'new',
      account_id: ACCOUNT_ID, conversation_history: [], extra_data: {}, last_activity: null,
    },
  ];
  dbState.rows.li_campaign_leads = [
    {
      id: 'cl-dead', campaign_id: CAMPAIGN_ID, lead_id: LEAD_ID, current_step: 0,
      status: 'pending', next_action_at: null, user_replied: false, invite_accepted: false,
      welcome_sent_at: null, error_message: null, created_at: '2026-01-01T00:00:00.000Z',
      lead: dbState.rows.li_leads[0],
    },
  ];
  dbState.rows.li_campaign_logs = [];
}

describe('processInviteStep — unresolvable profile (422) → skipped, not error', () => {
  beforeEach(() => seed());

  it('marks the campaign-lead skipped and never calls sendInvite on a 422 invalid_recipient', async () => {
    getProviderIdError = 'Unipile 422: {"status":422,"type":"errors/invalid_recipient","title":"Recipient cannot be invited"}';
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const cl = dbState.rows.li_campaign_leads.find((r) => r.id === 'cl-dead') as { status: string } | undefined;
    expect(cl?.status).toBe('skipped');
    expect(sendInviteCalls).toBe(0);
  });

  it('a transient resolve failure (500) still becomes error, not skipped', async () => {
    getProviderIdError = 'Unipile 500: Internal Server Error';
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const cl = dbState.rows.li_campaign_leads.find((r) => r.id === 'cl-dead') as { status: string } | undefined;
    expect(cl?.status).toBe('error');
  });
});
