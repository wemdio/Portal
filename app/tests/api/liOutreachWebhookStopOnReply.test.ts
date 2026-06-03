/** @jest-environment node */

/**
 * Regression: `stop_on_reply=true` must stop the LinkedIn automation after a
 * real incoming reply. The webhook should mark the lead as replied, but it must
 * not generate/send an AI auto-reply. Operators expect replies to be handed to a
 * human once stop_on_reply is enabled.
 */

interface UpdateCall {
  table: string;
  data: Record<string, unknown>;
  filters: Record<string, unknown>;
}

const supaCalls = {
  updates: [] as UpdateCall[],
};

const seededRows: Record<string, Record<string, unknown>[]> = {
  li_leads: [
    {
      id: 'lead-sandeep',
      user_id: 'user-1',
      chat_id: 'chat-sandeep',
      linkedin_id: 'provider-sandeep',
      name: 'Sandeep Dinodiya',
      first_name: 'Sandeep',
      company: 'SimplAI',
      status: 'messaged',
      conversation_history: [{ role: 'assistant', content: 'Worth a quick demo?', ts: '2026-05-27T00:41:12.000Z' }],
    },
  ],
  li_campaign_leads: [
    {
      id: 'cl-sandeep',
      campaign_id: 'camp-saas',
      lead_id: 'lead-sandeep',
      user_replied: false,
    },
  ],
  li_campaigns: [
    {
      id: 'camp-saas',
      use_ai: true,
      stop_on_reply: true,
      ai_prompt_chat: 'Reply politely and try to book a call.',
      ai_model: 'openai/gpt-4o-mini',
    },
  ],
  li_settings: [
    {
      id: 'settings-1',
      user_id: 'user-1',
      unipile_dsn: 'api.example.com:443',
      unipile_api_key: 'k',
    },
  ],
};

function resetState(): void {
  supaCalls.updates = [];
  seededRows.li_leads![0] = {
    id: 'lead-sandeep',
    user_id: 'user-1',
    chat_id: 'chat-sandeep',
    linkedin_id: 'provider-sandeep',
    name: 'Sandeep Dinodiya',
    first_name: 'Sandeep',
    company: 'SimplAI',
    status: 'messaged',
    conversation_history: [{ role: 'assistant', content: 'Worth a quick demo?', ts: '2026-05-27T00:41:12.000Z' }],
  };
  seededRows.li_campaign_leads![0] = {
    id: 'cl-sandeep',
    campaign_id: 'camp-saas',
    lead_id: 'lead-sandeep',
    user_replied: false,
  };
  seededRows.li_campaigns![0] = {
    id: 'camp-saas',
    use_ai: true,
    stop_on_reply: true,
    ai_prompt_chat: 'Reply politely and try to book a call.',
    ai_model: 'openai/gpt-4o-mini',
  };
}

function makeBuilder(table: string): Record<string, unknown> {
  const filters: Record<string, unknown> = {};
  const inFilters: Record<string, unknown[]> = {};
  let mode: 'select' | 'insert' | 'update' = 'select';
  let payload: unknown = null;

  const finalize = (): Record<string, unknown>[] => {
    let rows = (seededRows[table] ?? []).slice();
    for (const [col, val] of Object.entries(filters)) {
      rows = rows.filter((r) => r[col] === val);
    }
    for (const [col, vals] of Object.entries(inFilters)) {
      rows = rows.filter((r) => vals.includes(r[col]));
    }
    return rows;
  };

  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: (col: string, val: unknown) => {
      filters[col] = val;
      return builder;
    },
    in: (col: string, vals: unknown[]) => {
      inFilters[col] = vals;
      return builder;
    },
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
      if (mode === 'insert') return { data: { id: 42 }, error: null };
      const rows = finalize();
      return { data: rows[0] ?? null, error: rows[0] ? null : { message: 'not found' } };
    },
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'update') {
        supaCalls.updates.push({ table, data: payload as Record<string, unknown>, filters: { ...filters } });
        const rows = finalize();
        for (const row of rows) Object.assign(row, payload as Record<string, unknown>);
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

const sendMessageArgs: Array<{ chatId: string; text: string }> = [];

jest.mock('@/lib/liOutreach/unipileClient', () => ({
  UnipileClient: class {
    constructor(_dsn: string, _key: string, _accountId?: string | null) {}
    sendMessage(chatId: string, text: string): Promise<Record<string, unknown>> {
      sendMessageArgs.push({ chatId, text });
      return Promise.resolve({ id: 'msg-ok' });
    }
  },
}));

const generateAutoReplyArgs: Array<{ text: string; prompt: string }> = [];

jest.mock('@/lib/liOutreach/aiService', () => ({
  generateAutoReply: async (
    text: string,
    _history: Array<{ role: string; content: string }>,
    _aiConfig: { apiKey: string; model?: string },
    prompt: string,
  ): Promise<string | null> => {
    generateAutoReplyArgs.push({ text, prompt });
    return 'AI reply';
  },
  leadToInfo: (lead: { name?: string; first_name?: string | null; company?: string | null }) => ({
    name: lead.name,
    first_name: lead.first_name,
    company: lead.company,
  }),
  parseMessageTemplate: (text: string): string => text,
}));

import { POST } from '@/app/api/tools/li-outreach/webhook/route';

const oldAiKey = process.env.OPENROUTER_LI_OUTREACH_API_KEY;

function makeReq(body: Record<string, unknown>): import('next/server').NextRequest {
  return new Request('http://x/api/tools/li-outreach/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(() => {
  resetState();
  sendMessageArgs.length = 0;
  generateAutoReplyArgs.length = 0;
  process.env.OPENROUTER_LI_OUTREACH_API_KEY = 'test-ai-key';
});

afterAll(() => {
  process.env.OPENROUTER_LI_OUTREACH_API_KEY = oldAiKey;
});

describe('webhook message_received — stop_on_reply blocks AI auto-reply', () => {
  const incomingReply = {
    event: 'message_received',
    chat_id: 'chat-sandeep',
    message: "Let's have demo",
    is_sender: false,
    account_id: 'acc-nick',
    sender: { attendee_provider_id: 'provider-sandeep' },
  };

  it('marks the lead replied but does not generate or send an auto-reply when stop_on_reply=true', async () => {
    const res = await POST(makeReq(incomingReply));
    expect(res.status).toBe(200);

    expect(supaCalls.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'li_campaign_leads',
          data: expect.objectContaining({ user_replied: true }),
          filters: expect.objectContaining({ lead_id: 'lead-sandeep' }),
        }),
        expect.objectContaining({
          table: 'li_leads',
          data: expect.objectContaining({ status: 'replied' }),
          filters: expect.objectContaining({ id: 'lead-sandeep' }),
        }),
      ]),
    );
    expect(generateAutoReplyArgs).toHaveLength(0);
    expect(sendMessageArgs).toHaveLength(0);
  });

  it('preserves existing auto-reply behavior when stop_on_reply=false', async () => {
    seededRows.li_campaigns![0]!.stop_on_reply = false;

    const res = await POST(makeReq(incomingReply));
    expect(res.status).toBe(200);

    expect(generateAutoReplyArgs).toHaveLength(1);
    expect(generateAutoReplyArgs[0]).toMatchObject({
      text: "Let's have demo",
      prompt: 'Reply politely and try to book a call.',
    });
    expect(sendMessageArgs).toEqual([{ chatId: 'chat-sandeep', text: 'AI reply' }]);
  });
});
