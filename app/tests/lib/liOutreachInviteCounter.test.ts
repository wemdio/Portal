/** @jest-environment node */

/**
 * Integration tests for `runCampaignTick` — daily-invite-counter accuracy.
 *
 * Background: production users reported the dashboard showed `19/30` invites
 * sent today while the funnel "Приглашены" had ~225 leads. Worker logs showed
 * many leads inside one tick all logging the same `(N/30)` line — a clear
 * sign that the in-memory `campaign.invites_sent_today` was stale across
 * leads inside a single tick.
 *
 * These tests pin down the contract:
 *   1) On a successful invite → DB counter increments by exactly 1 and the
 *      log message echoes the *new* value.
 *   2) Several leads in a single tick → counter increments once per lead and
 *      each `Инвайт отправлен (i/N сегодня)` line uses the up-to-date value.
 *   3) On `already_invited` error → counter is NOT bumped (LinkedIn told us
 *      the invite was sent in a previous session; today's quota stays intact).
 *      The lead still gets marked `invited` and the campaign-lead step
 *      advances (regression with cooldown test).
 *   4) New day → counter resets to 1 atomically inside the RPC (no separate
 *      pre-update from JS that could race with another tick).
 *   5) Daily limit reached mid-tick → the runner stops calling `sendInvite`
 *      *based on the freshly returned counter*, not the stale one it loaded
 *      at tick start.
 *   6) Account in cooldown → RPC is never called (regression).
 *
 * The runner is expected to delegate the increment to a SQL RPC named
 * `li_campaign_increment_invite(p_campaign_id uuid, p_today date)` that
 * atomically resets-on-new-day-and-bumps in one statement and returns the
 * new `invites_sent_today` value. The mock here simulates that contract.
 */

import { createLiOutreachMockDb, type Row } from '../helpers/liOutreachDb';

const mockDb = createLiOutreachMockDb();
const dbState = mockDb.state;

mockDb.registerRpc('li_campaign_increment_invite', async (args) => {
  const campaignId = String(args.p_campaign_id);
  const today = String(args.p_today);
  const rows = dbState.rows.li_campaigns ?? [];
  const camp = rows.find((r) => r.id === campaignId);
  if (!camp) return { data: null, error: { message: 'campaign not found' } };
  const sameDay = camp.last_invite_date === today;
  const next = (sameDay ? Number(camp.invites_sent_today ?? 0) : 0) + 1;
  camp.invites_sent_today = next;
  camp.last_invite_date = today;
  return { data: next, error: null };
});

jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb.client;
  },
}));

type SendInviteImpl = (
  providerId: string,
  message?: string | null,
) => Promise<Record<string, unknown>>;

let sendInviteImpl: SendInviteImpl = async () => ({ id: 'invite-ok' });

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
    sendInvite(providerId: string, message?: string | null): Promise<Record<string, unknown>> {
      return sendInviteImpl(providerId, message ?? null);
    }
    getProviderId(): Promise<string> {
      return Promise.resolve('provider-already-set');
    }
    sendMessage(): Promise<Record<string, unknown>> {
      return Promise.resolve({});
    }
    startChat(): Promise<Record<string, unknown>> {
      return Promise.resolve({});
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
import { UnipileError } from '@/lib/liOutreach/unipileClient';

const CAMPAIGN_ID = 'camp-1';
const USER_ID = 'user-1';
const ACCOUNT_ID = 'acc-1';

interface SeedOpts {
  invitesSentToday?: number;
  dailyLimit?: number;
  lastInviteDate?: string | null;
  cooldownUntil?: string | null;
  /** Number of pending leads to seed (each as cl-{i+1} / lead-{i+1}). */
  leads?: number;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function seed(opts: SeedOpts = {}): void {
  mockDb.reset();
  const limit = opts.dailyLimit ?? 30;
  const sent = opts.invitesSentToday ?? 0;
  const lastDate = opts.lastInviteDate === undefined ? todayStr() : opts.lastInviteDate;
  const leadCount = opts.leads ?? 1;

  dbState.rows.li_campaigns = [
    {
      id: CAMPAIGN_ID,
      user_id: USER_ID,
      name: 'Test',
      account_id: ACCOUNT_ID,
      lead_list_id: null,
      status: 'running',
      steps: [{ type: 'invite', message: 'hi' }],
      use_ai: false,
      ai_prompt_invite: null,
      ai_prompt_chat: null,
      stop_on_reply: true,
      // Zero delay between leads so the test runs fast.
      min_delay: 0,
      max_delay: 0,
      daily_invite_limit: limit,
      invites_sent_today: sent,
      last_invite_date: lastDate,
      welcome_message: null,
      message_existing_connections: false,
      use_ai_welcome: false,
      use_ai_followup: true,
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
      cooldown_until: opts.cooldownUntil ?? null,
      cooldown_reason: null,
    },
  ];

  const leads: Row[] = [];
  const campaignLeads: Row[] = [];
  for (let i = 1; i <= leadCount; i++) {
    const leadId = `lead-${i}`;
    const lead: Row = {
      id: leadId,
      user_id: USER_ID,
      lead_list_id: null,
      linkedin_id: `provider-${i}`,
      public_identifier: `john-doe-${i}`,
      profile_url: `https://www.linkedin.com/in/john-doe-${i}`,
      name: `John Doe ${i}`,
      first_name: 'John',
      last_name: `Doe ${i}`,
      position: null,
      company: null,
      chat_id: null,
      status: 'new',
      account_id: ACCOUNT_ID,
      conversation_history: [],
      extra_data: {},
      last_activity: null,
    };
    leads.push(lead);
    campaignLeads.push({
      id: `cl-${i}`,
      campaign_id: CAMPAIGN_ID,
      lead_id: leadId,
      current_step: 0,
      status: 'pending',
      next_action_at: null,
      user_replied: false,
      invite_accepted: false,
      error_message: null,
      created_at: `2026-01-01T00:00:0${i}.000Z`,
      lead,
    });
  }

  dbState.rows.li_leads = leads;
  dbState.rows.li_campaign_leads = campaignLeads;
  dbState.rows.li_campaign_logs = [];
}

function logsContaining(substr: string): Row[] {
  return (dbState.rows.li_campaign_logs ?? []).filter((r) =>
    String(r.message ?? '').includes(substr),
  );
}

function counterInDb(): number {
  return Number(dbState.rows.li_campaigns?.[0]?.invites_sent_today ?? -1);
}

beforeEach(() => {
  sendInviteImpl = async () => ({ id: 'invite-ok' });
});

describe('runCampaignTick — daily-invite counter', () => {
  it('increments the DB counter by exactly 1 on a successful invite', async () => {
    seed({ invitesSentToday: 5, dailyLimit: 30, leads: 1 });

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(counterInDb()).toBe(6);
    expect(mockDb.rpcCallsFor('li_campaign_increment_invite')).toHaveLength(1);
  });

  it('inside ONE tick, multiple leads each get a fresh, monotonically growing counter', async () => {
    // This is the production bug: prod logs showed 4 leads in a row all
    // saying `(17/30)` because `campaign.invites_sent_today` was stale.
    seed({ invitesSentToday: 5, dailyLimit: 10, leads: 3 });

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(counterInDb()).toBe(8);
    expect(mockDb.rpcCallsFor('li_campaign_increment_invite')).toHaveLength(3);

    // Each "Инвайт отправлен" log line must echo the *new* counter value.
    const sentLogs = logsContaining('Инвайт отправлен');
    expect(sentLogs).toHaveLength(3);
    const echoed = sentLogs.map((r) => String(r.message));
    expect(echoed[0]).toContain('(6/10');
    expect(echoed[1]).toContain('(7/10');
    expect(echoed[2]).toContain('(8/10');
  });

  it('does NOT increment the counter when LinkedIn says already_invited', async () => {
    // LinkedIn reports the invite was sent earlier (different session / manual
    // outreach). The lead is moved to a dedicated `already_invited` status so
    // the Portal funnel doesn't double-count it as an invite we sent now —
    // the LinkedIn account dashboard wouldn't count it either. Today's quota
    // is preserved for actually-new invites, and the campaign-lead row is
    // marked `skipped` WITHOUT advancing current_step (we never invited them
    // in this campaign, so wait/message follow-up makes no sense).
    seed({ invitesSentToday: 5, dailyLimit: 30, leads: 1 });

    sendInviteImpl = async () => {
      throw new UnipileError('Unipile 400', 400, 'cannot_resend_yet: wait 3 weeks');
    };

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(counterInDb()).toBe(5);
    expect(mockDb.rpcCallsFor('li_campaign_increment_invite')).toHaveLength(0);

    const leadStatus = dbState.rows.li_leads?.[0]?.status;
    expect(leadStatus).toBe('already_invited');
    const cl = dbState.rows.li_campaign_leads?.[0];
    // current_step is advanced so the lead can still pick up the wait →
    // message follow-up if the existing LinkedIn invite is accepted.
    expect(cl?.current_step).toBe(1);
  });

  it('on a new day the RPC resets the counter to 1 (no JS-side pre-update)', async () => {
    seed({ invitesSentToday: 20, dailyLimit: 30, lastInviteDate: '2025-01-01', leads: 1 });

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(counterInDb()).toBe(1);
    expect(dbState.rows.li_campaigns?.[0]?.last_invite_date).toBe(todayStr());
    // The runner must NOT also issue a separate `update({invites_sent_today:0})`
    // — that pattern races with parallel ticks. The atomic reset belongs in
    // the RPC. Allow updates that touch other columns; reject ones that set
    // invites_sent_today via the .from(...).update(...) builder.
    const counterUpdates = mockDb
      .updatesFor('li_campaigns')
      .filter((u) => 'invites_sent_today' in u.data);
    expect(counterUpdates).toHaveLength(0);
  });

  it('stops sending mid-tick when the daily limit is reached', async () => {
    // 3 leads queued, but only 2 invites fit before the limit.
    seed({ invitesSentToday: 8, dailyLimit: 10, leads: 3 });

    let inviteCalls = 0;
    sendInviteImpl = async () => {
      inviteCalls++;
      return { id: 'ok' };
    };

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(inviteCalls).toBe(2);
    expect(counterInDb()).toBe(10);
    expect(mockDb.rpcCallsFor('li_campaign_increment_invite')).toHaveLength(2);

    // The 3rd lead must have hit the "Дневной лимит достигнут" branch.
    expect(logsContaining('Дневной лимит инвайтов достигнут')).not.toHaveLength(0);
  });

  it('does not touch the RPC when the account is in cooldown (regression)', async () => {
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    seed({ invitesSentToday: 5, dailyLimit: 30, leads: 1, cooldownUntil: future });

    let invited = false;
    sendInviteImpl = async () => {
      invited = true;
      return { id: 'should-not-be-called' };
    };

    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(invited).toBe(false);
    expect(mockDb.rpcCallsFor('li_campaign_increment_invite')).toHaveLength(0);
    expect(counterInDb()).toBe(5);
  });
});
