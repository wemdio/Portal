/** @jest-environment node */

/**
 * Integration tests for runCampaignTick — LinkedIn account cooldown behaviour.
 *
 * These tests exercise the *campaign-runner* side of cooldown handling:
 *   1) Tick is skipped entirely when the underlying li_account is in cooldown.
 *   2) On Unipile invitation_limit error → account is parked for 60 min,
 *      lead returns to pending (current_step does not advance), tick aborts.
 *   3) On Unipile already_invited error → lead is marked invited and step
 *      advances, account gets a short 15-min cooldown, tick aborts.
 *   4) Generic UnipileErrors (5xx / validation) do NOT set cooldown; the
 *      offending lead is marked error and the tick continues with the next
 *      lead — preserving today's behaviour.
 *
 * We mock supabaseAdmin with a small chainable builder that records writes
 * into a plain JS object so assertions can check exact payloads.
 */

// ---------------------------------------------------------------------------
// Mocks must be declared BEFORE any import that pulls them in transitively.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

interface DbState {
  rows: Record<string, Row[]>;
  updates: Array<{ table: string; data: Row; filters: Record<string, unknown> }>;
}

const dbState: DbState = { rows: {}, updates: [] };

function resetDb(): void {
  dbState.rows = {};
  dbState.updates = [];
}

function makeBuilder(table: string): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  let inserted: Row | Row[] | null = null;
  let updated: Row | null = null;
  let mode: 'select' | 'update' | 'insert' | 'delete' = 'select';

  const finalize = (): { data: Row[]; error: null } => {
    let rows = (dbState.rows[table] ?? []).slice();
    for (const [col, val] of Object.entries(filters)) {
      if (col === '__or' || col === '__in_status') continue;
      rows = rows.filter((r) => r[col] === val);
    }
    if (filters.__in_status) {
      const allowed = filters.__in_status as string[];
      rows = rows.filter((r) => allowed.includes(String(r.status ?? '')));
    }
    return { data: rows, error: null };
  };

  const builder: Record<string, unknown> = {
    select: () => {
      mode = 'select';
      return builder;
    },
    insert: (data: Row | Row[]) => {
      mode = 'insert';
      inserted = data;
      return builder;
    },
    update: (data: Row) => {
      mode = 'update';
      updated = data;
      return builder;
    },
    delete: () => {
      mode = 'delete';
      return builder;
    },
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    in: (col: string, values: unknown[]) => {
      if (col === 'status') filters.__in_status = values as string[];
      else filters[col] = values;
      return builder;
    },
    or: () => builder,
    order: () => builder,
    limit: () => builder,
    single: async () => {
      const r = finalize();
      return { data: r.data[0] ?? null, error: r.data[0] ? null : { message: 'not found' } };
    },
    maybeSingle: async () => {
      const r = finalize();
      return { data: r.data[0] ?? null, error: null };
    },
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'update') {
        dbState.updates.push({ table, data: updated ?? {}, filters: { ...filters } });
        // Apply update to in-memory rows so subsequent reads see it.
        const r = finalize();
        for (const row of r.data) {
          Object.assign(row, updated ?? {});
        }
        resolve({ data: null, error: null });
        return;
      }
      if (mode === 'insert') {
        const arr = Array.isArray(inserted) ? inserted : [inserted as Row];
        dbState.rows[table] = (dbState.rows[table] ?? []).concat(arr);
        resolve({ data: arr, error: null });
        return;
      }
      resolve(finalize());
    },
  };

  return builder;
}

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: {
    from: (table: string) => makeBuilder(table),
  },
}));

// Mock UnipileClient: each test will tweak `sendInviteImpl` to return a value
// or throw a specific UnipileError.
type SendInviteImpl = (
  providerId: string,
  message?: string | null,
) => Promise<Record<string, unknown>>;

let sendInviteImpl: SendInviteImpl = async () => ({ id: 'invite-ok' });

jest.mock('@/lib/liOutreach/unipileClient', () => {
  // Real UnipileError so `instanceof` checks in the runner work as expected.
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
    getProviderId(_publicId: string): Promise<string> {
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

// AI-service mocks: keep them no-op / passthrough so we don't hit OpenAI.
jest.mock('@/lib/liOutreach/aiService', () => ({
  parseMessageTemplate: (s: string): string => s,
  leadToInfo: (): Record<string, unknown> => ({}),
  personalizeInviteMessage: async (s: string): Promise<string> => s,
  personalizeFollowUp: async (s: string): Promise<string> => s,
}));

// ---------------------------------------------------------------------------
// Now we can import the runner.
// ---------------------------------------------------------------------------

import { runCampaignTick } from '@/lib/liOutreach/campaignRunner';
import { UnipileError } from '@/lib/liOutreach/unipileClient';

const CAMPAIGN_ID = 'camp-1';
const USER_ID = 'user-1';
const ACCOUNT_ID = 'acc-1';

function seedBase(opts: { cooldownUntil?: string | null } = {}): void {
  resetDb();
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
      min_delay: 1,
      max_delay: 1,
      daily_invite_limit: 25,
      invites_sent_today: 0,
      last_invite_date: new Date().toISOString().slice(0, 10),
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
  dbState.rows.li_leads = [
    {
      id: 'lead-1',
      user_id: USER_ID,
      lead_list_id: null,
      linkedin_id: 'provider-1',
      public_identifier: 'john-doe',
      profile_url: 'https://www.linkedin.com/in/john-doe',
      name: 'John Doe',
      first_name: 'John',
      last_name: 'Doe',
      position: null,
      company: null,
      chat_id: null,
      status: 'new',
      account_id: ACCOUNT_ID,
      conversation_history: [],
      extra_data: {},
      last_activity: null,
    },
    {
      id: 'lead-2',
      user_id: USER_ID,
      lead_list_id: null,
      linkedin_id: 'provider-2',
      public_identifier: 'jane-doe',
      profile_url: 'https://www.linkedin.com/in/jane-doe',
      name: 'Jane Doe',
      first_name: 'Jane',
      last_name: 'Doe',
      position: null,
      company: null,
      chat_id: null,
      status: 'new',
      account_id: ACCOUNT_ID,
      conversation_history: [],
      extra_data: {},
      last_activity: null,
    },
  ];
  dbState.rows.li_campaign_leads = [
    {
      id: 'cl-1',
      campaign_id: CAMPAIGN_ID,
      lead_id: 'lead-1',
      current_step: 0,
      status: 'pending',
      next_action_at: null,
      user_replied: false,
      invite_accepted: false,
      error_message: null,
      created_at: '2026-01-01T00:00:00.000Z',
      lead: dbState.rows.li_leads[0],
    },
    {
      id: 'cl-2',
      campaign_id: CAMPAIGN_ID,
      lead_id: 'lead-2',
      current_step: 0,
      status: 'pending',
      next_action_at: null,
      user_replied: false,
      invite_accepted: false,
      error_message: null,
      created_at: '2026-01-01T00:00:01.000Z',
      lead: dbState.rows.li_leads[1],
    },
  ];
  dbState.rows.li_campaign_logs = [];
}

// Helper: pull the cooldown_until value the runner wrote on li_accounts.
function findAccountCooldownUpdate(): { data: Row; filters: Record<string, unknown> } | null {
  const updates = dbState.updates.filter(
    (u) => u.table === 'li_accounts' && 'cooldown_until' in u.data,
  );
  return updates.length ? updates[updates.length - 1] : null;
}

function findCampaignLeadUpdates(): Array<{ data: Row; filters: Record<string, unknown> }> {
  return dbState.updates.filter((u) => u.table === 'li_campaign_leads');
}

function findLeadUpdates(): Array<{ data: Row; filters: Record<string, unknown> }> {
  return dbState.updates.filter((u) => u.table === 'li_leads');
}

beforeEach(() => {
  sendInviteImpl = async () => ({ id: 'invite-ok' });
});

describe('runCampaignTick — account cooldown', () => {
  it('skips the tick entirely if account.cooldown_until is in the future', async () => {
    const cdUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    seedBase({ cooldownUntil: cdUntil });

    let inviteCalled = false;
    sendInviteImpl = async () => {
      inviteCalled = true;
      return { id: 'should-not-be-called' };
    };

    const result = await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(result).toEqual({ processed: 0, errors: 0 });
    expect(inviteCalled).toBe(false);
    // No leads should have been touched.
    expect(findCampaignLeadUpdates()).toHaveLength(0);
  });

  it('proceeds normally if cooldown_until is in the past', async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    seedBase({ cooldownUntil: past });

    const result = await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(result.processed).toBeGreaterThan(0);
  });

  it('on invitation_limit error: parks account ~60min, lead stays pending, tick aborts', async () => {
    seedBase();

    let inviteCalls = 0;
    sendInviteImpl = async () => {
      inviteCalls++;
      throw new UnipileError('Unipile 429: Too many requests', 429, 'Too many requests');
    };

    const before = Date.now();
    const result = await runCampaignTick(CAMPAIGN_ID, USER_ID);

    expect(inviteCalls).toBe(1);
    expect(result.errors).toBeGreaterThanOrEqual(1);

    const cdUpdate = findAccountCooldownUpdate();
    expect(cdUpdate).not.toBeNull();
    expect(cdUpdate!.filters.id).toBe(ACCOUNT_ID);
    expect(cdUpdate!.data.cooldown_reason).toBe('invitation_limit');

    const cdMs = new Date(String(cdUpdate!.data.cooldown_until)).getTime() - before;
    expect(cdMs).toBeGreaterThanOrEqual(55 * 60 * 1000);
    expect(cdMs).toBeLessThanOrEqual(65 * 60 * 1000);

    // The current campaign_lead should NOT have been advanced past step 0.
    const clUpdates = findCampaignLeadUpdates().filter((u) => u.filters.id === 'cl-1');
    for (const u of clUpdates) {
      expect(u.data.current_step ?? 0).toBe(0);
      expect(u.data.status).not.toBe('completed');
    }
  });

  it('on already_invited error: marks lead invited, advances step, sets short cooldown ~15min', async () => {
    seedBase();

    sendInviteImpl = async () => {
      throw new UnipileError('Unipile 400', 400, 'cannot_resend_yet: wait 3 weeks');
    };

    const before = Date.now();
    await runCampaignTick(CAMPAIGN_ID, USER_ID);

    const cdUpdate = findAccountCooldownUpdate();
    expect(cdUpdate).not.toBeNull();
    expect(cdUpdate!.data.cooldown_reason).toBe('already_invited');

    const cdMs = new Date(String(cdUpdate!.data.cooldown_until)).getTime() - before;
    expect(cdMs).toBeGreaterThanOrEqual(10 * 60 * 1000);
    expect(cdMs).toBeLessThanOrEqual(20 * 60 * 1000);

    // Lead should be marked invited and the campaign-lead step advanced.
    const leadUpdates = findLeadUpdates().filter((u) => u.filters.id === 'lead-1');
    expect(leadUpdates.some((u) => u.data.status === 'invited')).toBe(true);

    const clUpdates = findCampaignLeadUpdates().filter((u) => u.filters.id === 'cl-1');
    expect(clUpdates.some((u) => u.data.current_step === 1)).toBe(true);
  });

  it('on a regular UnipileError (e.g. 500): does NOT set cooldown, marks lead error, tick continues to next lead', async () => {
    seedBase();

    let calls = 0;
    sendInviteImpl = async () => {
      calls++;
      if (calls === 1) {
        throw new UnipileError('Unipile 500', 500, 'Internal Server Error');
      }
      return { id: 'invite-ok' };
    };

    const result = await runCampaignTick(CAMPAIGN_ID, USER_ID);

    // Both leads should have been attempted.
    expect(calls).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.processed).toBeGreaterThanOrEqual(1);

    // No cooldown should have been written.
    expect(findAccountCooldownUpdate()).toBeNull();
  });
});
