/** @jest-environment node */

/**
 * Regression: the LinkedIn webhook handler must IGNORE message_received
 * events where `is_sender === true`.
 *
 * Background: Unipile fires `message_received` for BOTH directions of a
 * conversation — incoming and outgoing. Without filtering by `is_sender`
 * the handler falsely marks `li_campaign_leads.user_replied=true` for
 * messages WE just sent. Combined with `stop_on_reply=true` (the default),
 * this short-circuits campaigns silently — every outbound message ends
 * the lead's pipeline.
 *
 * Sample real payload from prod (Apr 2026, li_webhook_logs id=1379):
 *   { event: 'message_received', is_sender: true, chat_id: '...', message: '...' }
 */

const supaCalls = {
  webhookLogInserts: [] as Array<Record<string, unknown>>,
  campaignLeadUpdates: [] as Array<{ filters: Record<string, unknown>; data: Record<string, unknown> }>,
  leadUpdates: [] as Array<{ filters: Record<string, unknown>; data: Record<string, unknown> }>,
};

function resetState() {
  supaCalls.webhookLogInserts = [];
  supaCalls.campaignLeadUpdates = [];
  supaCalls.leadUpdates = [];
}

function makeBuilder(table: string) {
  const filters: Record<string, unknown> = {};
  let mode: 'select' | 'insert' | 'update' = 'select';
  let payload: unknown = null;

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
      // Return a fake lead row when looking up by chat_id, so the handler
      // would try to update li_campaign_leads if the bug were still present.
      if (table === 'li_leads' && filters.chat_id) {
        return {
          data: {
            id: 'lead-X',
            user_id: 'user-X',
            chat_id: String(filters.chat_id),
            conversation_history: [],
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
    single: async () => ({ data: null, error: { message: 'not found' } }),
    then: (resolve: (v: unknown) => void) => {
      if (mode === 'insert') {
        if (table === 'li_webhook_logs') {
          supaCalls.webhookLogInserts.push(payload as Record<string, unknown>);
        }
        resolve({ data: payload, error: null });
        return;
      }
      if (mode === 'update') {
        if (table === 'li_campaign_leads') {
          supaCalls.campaignLeadUpdates.push({
            filters: { ...filters },
            data: payload as Record<string, unknown>,
          });
        }
        if (table === 'li_leads') {
          supaCalls.leadUpdates.push({
            filters: { ...filters },
            data: payload as Record<string, unknown>,
          });
        }
        resolve({ data: null, error: null });
        return;
      }
      resolve({ data: [], error: null });
    },
  };
  return builder;
}

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (table: string) => makeBuilder(table) },
}));

jest.mock('@/lib/liOutreach/unipileClient', () => ({
  UnipileClient: class {
    constructor() {}
    sendMessage(): Promise<Record<string, unknown>> {
      return Promise.resolve({});
    }
  },
}));

jest.mock('@/lib/liOutreach/aiService', () => ({
  generateAutoReply: async (): Promise<string | null> => null,
  leadToInfo: (): Record<string, unknown> => ({}),
}));

import { POST } from '@/app/api/tools/li-outreach/webhook/route';

function makeReq(body: Record<string, unknown>) {
  return new Request('http://x/api/tools/li-outreach/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as import('next/server').NextRequest;
}

beforeEach(resetState);

describe('webhook /li-outreach/webhook — is_sender filter on message_received', () => {
  it('does NOT mark li_campaign_leads.user_replied=true when is_sender=true (we sent the message ourselves)', async () => {
    const res = await POST(
      makeReq({
        event: 'message_received',
        chat_id: 'chat-123',
        message: 'hi from us',
        is_sender: true,
        account_id: 'acc-1',
        sender: { attendee_provider_id: 'us-provider-id' },
      }),
    );

    expect(res.status).toBe(200);
    // Audit row still goes in (good — useful for debugging).
    expect(supaCalls.webhookLogInserts).toHaveLength(1);
    // But NO `user_replied=true` mutation should have happened.
    const userRepliedWrites = supaCalls.campaignLeadUpdates.filter(
      (u) => u.data.user_replied === true,
    );
    expect(userRepliedWrites).toEqual([]);
    // And the lead should NOT have been marked status='replied'.
    const repliedStatusWrites = supaCalls.leadUpdates.filter((u) => u.data.status === 'replied');
    expect(repliedStatusWrites).toEqual([]);
  });

  it('DOES mark user_replied=true when is_sender=false (real incoming reply)', async () => {
    const res = await POST(
      makeReq({
        event: 'message_received',
        chat_id: 'chat-123',
        message: 'hello back',
        is_sender: false,
        account_id: 'acc-1',
        sender: { attendee_provider_id: 'lead-provider-id' },
      }),
    );

    expect(res.status).toBe(200);
    const userRepliedWrites = supaCalls.campaignLeadUpdates.filter(
      (u) => u.data.user_replied === true,
    );
    expect(userRepliedWrites.length).toBeGreaterThanOrEqual(1);
  });
});
