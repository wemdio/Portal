/** @jest-environment node */

/**
 * Regression: `connection.accepted` / `new_relation` webhook must deliver the
 * welcome message even when Unipile's payload contains no `chat_id`.
 *
 * Background (prod 2026-05): Unipile's `new_relation` event signals that an
 * invite was accepted but doesn't carry a chat_id — the LinkedIn conversation
 * doesn't exist yet, it's opened by the FIRST outbound message. The old
 * handler bailed on `if (!campaignId || !chatId) return;`, so welcome was
 * silently dropped for every accepted invite (81 leads in 14 days).
 *
 * The cascading effect: because `welcome_sent_at` was never recorded, the
 * runner's first message-step ran two days later and fell into the startChat
 * branch with raw step.message — leads got a duplicated, un-personalized
 * follow-up instead of the intended welcome. See
 * liOutreachStartChatParsesMessage.test.ts for the runner half of the story.
 *
 * Desired behaviour:
 *   1. Handler opens the chat itself via client.startChat(providerId, welcomeText).
 *   2. The welcome passed to startChat has template placeholders rendered.
 *   3. li_leads.chat_id is persisted from the startChat response.
 *   4. li_campaign_leads.welcome_sent_at is recorded.
 *   5. li_webhook_logs.processed is flipped to true.
 */

interface InsertCall {
  table: string;
  payload: Record<string, unknown>;
}
interface UpdateCall {
  table: string;
  data: Record<string, unknown>;
  filters: Record<string, unknown>;
}

const supaCalls = {
  inserts: [] as InsertCall[],
  updates: [] as UpdateCall[],
};

const seededRows: Record<string, Record<string, unknown>[]> = {
  li_leads: [
    {
      id: 'lead-emma',
      user_id: 'user-1',
      linkedin_id: 'provider-emma',
      name: 'Emma Seymour',
      first_name: 'Emma',
      last_name: 'Seymour',
      company: 'Gratiya Advisory',
      position: 'Senior Partner',
      chat_id: null,
      status: 'invited',
      conversation_history: [],
    },
  ],
  li_campaign_leads: [
    {
      id: 'cl-emma',
      campaign_id: 'camp-1',
      lead_id: 'lead-emma',
    },
  ],
  li_campaigns: [
    {
      id: 'camp-1',
      status: 'running',
      created_at: '2026-05-01T00:00:00.000Z',
      welcome_message: 'Hi {{first_name}}, thanks for accepting! Glad to connect with {{company}}.',
    },
  ],
  li_settings: [
    {
      id: 'set-1',
      user_id: 'user-1',
      unipile_dsn: 'api.example.com:443',
      unipile_api_key: 'k',
      openai_api_key: '',
      openai_model: 'gpt-4o-mini',
    },
  ],
};

function resetState(): void {
  supaCalls.inserts = [];
  supaCalls.updates = [];
}

function makeBuilder(table: string): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  let mode: 'select' | 'insert' | 'update' = 'select';
  let payload: unknown = null;

  const finalize = (): Record<string, unknown>[] => {
    let rows = (seededRows[table] ?? []).slice();
    for (const [col, val] of Object.entries(filters)) {
      rows = rows.filter((r) => r[col] === val);
    }
    return rows;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: (data: unknown) => {
      mode = 'insert';
      payload = data;
      return builder;
    },
    update: (data: unknown) => {
      mode = 'update';
      payload = data;
      return builder;
    },
    maybeSingle: async () => {
      const rows = finalize();
      return { data: rows[0] ?? null, error: null };
    },
    single: async () => {
      if (mode === 'insert') {
        // Simulate Postgres returning the generated id after insert.
        supaCalls.inserts.push({ table, payload: payload as Record<string, unknown> });
        return { data: { id: 9001 }, error: null };
      }
      const rows = finalize();
      return { data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } };
    },
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'insert') {
        supaCalls.inserts.push({ table, payload: payload as Record<string, unknown> });
        resolve({ data: payload, error: null });
        return;
      }
      if (mode === 'update') {
        supaCalls.updates.push({
          table,
          data: payload as Record<string, unknown>,
          filters: { ...filters },
        });
        // Mutate seededRows so subsequent selects see the write
        const rows = finalize();
        for (const row of rows) {
          Object.assign(row, payload as Record<string, unknown>);
        }
        resolve({ data: null, error: null });
        return;
      }
      resolve({ data: finalize(), error: null });
    },
  };
  return builder;
}

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}));

const startChatArgs: Array<{ providerId: string; message: string | null | undefined }> = [];
const sendMessageArgs: Array<{ chatId: string; text: string }> = [];

jest.mock('@/lib/liOutreach/unipileClient', () => ({
  UnipileClient: class {
    constructor(_dsn: string, _key: string, _accountId?: string | null) {}
    startChat(providerId: string, message?: string | null): Promise<Record<string, unknown>> {
      startChatArgs.push({ providerId, message });
      return Promise.resolve({ id: 'chat-newly-opened' });
    }
    sendMessage(chatId: string, text: string): Promise<Record<string, unknown>> {
      sendMessageArgs.push({ chatId, text });
      return Promise.resolve({ id: 'msg-ok' });
    }
  },
}));

// Real parseMessageTemplate so we can assert the substituted output.
jest.mock('@/lib/liOutreach/aiService', () => {
  const actual = jest.requireActual('@/lib/liOutreach/aiService');
  return {
    generateAutoReply: async (): Promise<string | null> => null,
    parseMessageTemplate: actual.parseMessageTemplate,
    leadToInfo: (lead: { name?: string; first_name?: string | null; last_name?: string | null; company?: string | null; position?: string | null }) => ({
      name: lead.name,
      first_name: lead.first_name,
      last_name: lead.last_name,
      company: lead.company,
      position: lead.position,
    }),
  };
});

import { POST } from '@/app/api/tools/li-outreach/webhook/route';

function makeReq(body: Record<string, unknown>): import('next/server').NextRequest {
  return new Request('http://x/api/tools/li-outreach/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  resetState();
  startChatArgs.length = 0;
  sendMessageArgs.length = 0;
  // Restore seeded chat_id to null between tests (a previous test may have written it).
  seededRows.li_leads![0]!.chat_id = null;
  // Same for welcome_sent_at: the handler now refuses to greet a lead whose
  // row already carries a stamp (Unipile redelivers `new_relation`), and the
  // mock persists writes into the seed, so without this every test after the
  // first would exercise the idempotency guard instead of the welcome path.
  seededRows.li_campaign_leads![0]!.welcome_sent_at = null;
});

describe('webhook handleConnectionAccepted — opens chat with welcome when payload has no chat_id', () => {
  const newRelationPayload = {
    event: 'new_relation',
    timestamp: 1779191428000,
    account_id: 'acc-unipile-1',
    account_type: 'LINKEDIN',
    webhook_name: 'polza-rel',
    user_full_name: 'Emma Seymour',
    user_profile_url: 'https://www.linkedin.com/in/emma-seymour-fcipd/',
    user_provider_id: 'provider-emma',
    user_public_identifier: 'emma-seymour-fcipd',
    // intentionally NO chat_id — matches real Unipile new_relation payload
  };

  it('calls client.startChat with the rendered welcome (no leftover placeholders)', async () => {
    const res = await POST(makeReq(newRelationPayload));
    expect(res.status).toBe(200);

    expect(startChatArgs).toHaveLength(1);
    expect(startChatArgs[0]!.providerId).toBe('provider-emma');
    const sent = startChatArgs[0]!.message ?? '';
    expect(sent).toContain('Hi Emma');
    expect(sent).toContain('Gratiya Advisory');
    expect(sent).not.toMatch(/\{\{[^}]*\}\}/);
  });

  it('does NOT call sendMessage on the no-chat path (startChat already delivered)', async () => {
    await POST(makeReq(newRelationPayload));
    expect(sendMessageArgs).toHaveLength(0);
  });

  it('persists the new chat_id returned from startChat into li_leads', async () => {
    await POST(makeReq(newRelationPayload));

    const leadChatIdWrites = supaCalls.updates.filter(
      (u) => u.table === 'li_leads' && u.data.chat_id === 'chat-newly-opened',
    );
    expect(leadChatIdWrites.length).toBeGreaterThanOrEqual(1);
  });

  it('records welcome_sent_at on EVERY campaign_lead row of the lead, not one', async () => {
    await POST(makeReq(newRelationPayload));

    const welcomeWrites = supaCalls.updates.filter(
      (u) => u.table === 'li_campaign_leads' && typeof u.data.welcome_sent_at === 'string',
    );
    expect(welcomeWrites.length).toBeGreaterThanOrEqual(1);
    // Scoped by lead, not by the single row that happened to be picked — a
    // lead in two campaigns used to keep a NULL stamp on the other row and the
    // health digest reported the delivered welcome as missing forever.
    expect(welcomeWrites[0]!.filters.lead_id).toBe('lead-emma');
    expect(welcomeWrites[0]!.filters.id).toBeUndefined();
  });

  it('does not greet twice when the row already carries welcome_sent_at (webhook redelivery)', async () => {
    seededRows.li_campaign_leads![0]!.welcome_sent_at = '2026-08-17T14:00:18.955Z';

    await POST(makeReq(newRelationPayload));

    expect(startChatArgs).toHaveLength(0);
    expect(sendMessageArgs).toHaveLength(0);
  });

  it('stays silent when no running campaign carries a welcome', async () => {
    seededRows.li_campaigns![0]!.status = 'stopped';
    try {
      await POST(makeReq(newRelationPayload));
      expect(startChatArgs).toHaveLength(0);
      expect(sendMessageArgs).toHaveLength(0);
    } finally {
      seededRows.li_campaigns![0]!.status = 'running';
    }
  });

  it('marks li_webhook_logs.processed = true after successful handling', async () => {
    await POST(makeReq(newRelationPayload));

    const processedFlips = supaCalls.updates.filter(
      (u) => u.table === 'li_webhook_logs' && u.data.processed === true,
    );
    expect(processedFlips.length).toBe(1);
    expect(processedFlips[0]!.filters.id).toBe(9001);
  });

  // Всё выше гоняется на фикстуре с ОДНИМ рядом campaign_lead, поэтому сама
  // предпосылка фикса — лид, живущий в двух кампаниях, — там не проверяется:
  // при одном ряде «первый ряд» и «все ряды лида» неразличимы. Прод 18.08.2026:
  // один lead_list был запущен двумя кампаниями, 163 из 163 общих лида.
  describe('лид сразу в двух running-кампаниях', () => {
    beforeEach(() => {
      seededRows.li_campaign_leads!.push({
        id: 'cl-emma-2',
        campaign_id: 'camp-2',
        lead_id: 'lead-emma',
        welcome_sent_at: null,
      });
      seededRows.li_campaigns!.push({
        id: 'camp-2',
        status: 'running',
        created_at: '2026-06-01T00:00:00.000Z',
        welcome_message: 'Второе приветствие из второй кампании, {{first_name}}.',
      });
    });

    afterEach(() => {
      seededRows.li_campaign_leads!.pop();
      seededRows.li_campaigns!.pop();
    });

    it('приветствует ровно один раз, а не по разу от каждой кампании', async () => {
      await POST(makeReq(newRelationPayload));

      expect(startChatArgs).toHaveLength(1);
      expect(sendMessageArgs).toHaveLength(0);
    });

    it('выбирает кампанию детерминированно — старшую по created_at', async () => {
      await POST(makeReq(newRelationPayload));

      // camp-1 создана 01.05, camp-2 — 01.06. Раньше ряд брался из .limit(1)
      // без ORDER BY, то есть произвольный.
      expect(startChatArgs[0]!.message).toContain('thanks for accepting');
    });

    it('штампует welcome_sent_at на ОБОИХ рядах лида', async () => {
      await POST(makeReq(newRelationPayload));

      const stamped = seededRows.li_campaign_leads!.filter((r) => r.welcome_sent_at);
      // Если штамп уходит на один ряд, второй остаётся с NULL — и дайджест
      // вечно репортит «connected без welcome» по доставленному приветствию.
      expect(stamped).toHaveLength(2);
    });
  });

  it('still uses sendMessage (not startChat) when payload DOES carry chat_id', async () => {
    seededRows.li_leads![0]!.chat_id = null; // verify path doesn't need pre-existing chat_id either
    await POST(
      makeReq({ ...newRelationPayload, chat_id: 'existing-chat-from-payload' }),
    );
    expect(sendMessageArgs).toHaveLength(1);
    expect(sendMessageArgs[0]!.chatId).toBe('existing-chat-from-payload');
    expect(startChatArgs).toHaveLength(0);
  });
});
