/**
 * @jest-environment node
 */
import { Api } from 'telegram';
import bigInt from 'big-integer';

jest.mock('@/lib/tgOutreach/openaiChat', () => ({
  openaiGenerate: jest.fn(),
  detectTrigger: jest.fn(),
}));

import { handleChat as _handleChat } from '@/lib/tgOutreach/campaignLoop';
import type { OutreachCampaign, OutreachAccount, DialogMessage } from '@/lib/tgOutreach/types';
import { DEFAULT_TELEGRAM_SETTINGS, DEFAULT_OPENAI_SETTINGS } from '@/lib/tgOutreach/types';
import { openaiGenerate } from '@/lib/tgOutreach/openaiChat';

type HandleChat = typeof _handleChat;
const handleChat: HandleChat = _handleChat;

function makeUser(opts: { id: number; username?: string; bot?: boolean }) {
  return new Api.User({
    id: bigInt(opts.id),
    firstName: 'Test',
    username: opts.username,
    bot: opts.bot ?? false,
    accessHash: bigInt(0),
  });
}

function makeMockClient(messages: { out: boolean; message: string; date: number }[] = []) {
  const tgMessages = messages.map((m, i) => ({
    id: i + 1,
    out: m.out,
    message: m.message,
    date: m.date,
  }));
  return {
    invoke: jest.fn().mockResolvedValue(undefined),
    getMessages: jest.fn().mockResolvedValue(tgMessages),
    sendMessage: jest.fn().mockResolvedValue({ id: 999 }),
    getEntity: jest.fn(),
  };
}

interface UpsertCall {
  table: string;
  op: string;
  payload?: Record<string, unknown>;
  filter?: Record<string, unknown>;
}

function makeMockDb(opts?: { dialogExists?: boolean; isProcessed?: boolean; canSend?: boolean }) {
  const calls: UpsertCall[] = [];
  const dialogExists = opts?.dialogExists ?? false;
  const isProcessed = opts?.isProcessed ?? false;
  const canSend = opts?.canSend ?? true;

  const chain = (table: string) => {
    const ctx: UpsertCall = { table, op: 'select', filter: {} };
    const builder: Record<string, unknown> = {
      select: (..._args: unknown[]) => { ctx.op = 'select'; return builder; },
      insert: (data: Record<string, unknown>) => { ctx.op = 'insert'; ctx.payload = data; calls.push({ ...ctx }); return builder; },
      update: (data: Record<string, unknown>) => { ctx.op = 'update'; ctx.payload = data; calls.push({ ...ctx }); return builder; },
      upsert: (data: Record<string, unknown>) => { ctx.op = 'upsert'; ctx.payload = data; calls.push({ ...ctx }); return builder; },
      delete: () => { ctx.op = 'delete'; calls.push({ ...ctx }); return builder; },
      eq: (col: string, val: unknown) => { ctx.filter = { ...ctx.filter, [col]: val }; return builder; },
      maybeSingle: jest.fn().mockImplementation(() => {
        if (table === 'tg_outreach_dialogs' && ctx.op === 'select') {
          if (dialogExists) {
            return Promise.resolve({ data: { id: 'dlg-1', messages: [], status: 'none', can_send: canSend, tg_is_bot: false }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }),
      single: jest.fn().mockResolvedValue({ data: null, error: null }),
      then: (resolve: (val: unknown) => void) => {
        if (table === 'tg_outreach_processed' && ctx.op === 'select') {
          resolve({ count: isProcessed ? 1 : 0, error: null });
          return;
        }
        resolve({ data: [], error: null });
      },
    };
    return builder;
  };

  return { db: { from: (t: string) => chain(t) } as unknown, calls };
}

function makeCampaign(overrides?: Partial<OutreachCampaign>): OutreachCampaign {
  return {
    id: 'camp-1',
    user_id: 'user-1',
    name: 'TestCampaign',
    status: 'running',
    openai_settings: { ...DEFAULT_OPENAI_SETTINGS },
    telegram_settings: {
      ...DEFAULT_TELEGRAM_SETTINGS,
      pre_read_delay_range: [0, 0],
      read_reply_delay_range: [0, 0],
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const ACCOUNT: OutreachAccount = {
  id: 'acc-1',
  campaign_id: 'camp-1',
  session_name: 'test-session',
  api_id: 12345,
  api_hash: 'abc',
  phone: '+70001112233',
  proxy_id: null,
  session_data: '',
  is_active: true,
  cooldown_until: null,
  created_at: new Date().toISOString(),
};

const USER_MESSAGES = [
  { out: false, message: 'Привет, расскажите подробнее', date: Math.floor(Date.now() / 1000) },
];

describe('tgOutreach handleChat', () => {
  const log = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves messages to DB even when reply_only_if_previously_wrote blocks reply', async () => {
    const campaign = makeCampaign({
      telegram_settings: {
        ...DEFAULT_TELEGRAM_SETTINGS,
        reply_only_if_previously_wrote: true,
        pre_read_delay_range: [0, 0],
        read_reply_delay_range: [0, 0],
      },
    });

    const client = makeMockClient(USER_MESSAGES);
    const { db, calls } = makeMockDb({ dialogExists: true, canSend: true });

    const entity = makeUser({ id: 12345, username: 'testuser' });
    const dialog = { entity, unreadCount: 1 } as unknown as import('telegram/tl/custom/dialog').Dialog;

    const result = await handleChat(client as never, ACCOUNT, dialog, campaign, db as never, log);

    expect(result.replied).toBe(false);

    const messageSaves = calls.filter(
      (c) => c.table === 'tg_outreach_dialogs' && (c.op === 'update' || c.op === 'insert') && Array.isArray(c.payload?.messages) && (c.payload?.messages as unknown[]).length > 0,
    );
    expect(messageSaves.length).toBeGreaterThanOrEqual(1);

    const savedMessages = messageSaves[0].payload!.messages as DialogMessage[];
    expect(savedMessages.length).toBeGreaterThan(0);
    expect(savedMessages[0].content).toBe('Привет, расскажите подробнее');
  });

  it('saves messages to DB even when OpenAI fails', async () => {
    const campaign = makeCampaign({
      telegram_settings: {
        ...DEFAULT_TELEGRAM_SETTINGS,
        reply_only_if_previously_wrote: false,
        pre_read_delay_range: [0, 0],
        read_reply_delay_range: [0, 0],
      },
    });

    (openaiGenerate as jest.Mock).mockResolvedValue(null);

    const messagesWithOurs = [
      { out: true, message: 'Добрый день!', date: Math.floor(Date.now() / 1000) - 100 },
      { out: false, message: 'Здравствуйте, интересно', date: Math.floor(Date.now() / 1000) },
    ];
    const client = makeMockClient(messagesWithOurs);
    const { db, calls } = makeMockDb({ dialogExists: true, canSend: true });

    const entity = makeUser({ id: 12345, username: 'testuser' });
    const dialog = { entity, unreadCount: 1 } as unknown as import('telegram/tl/custom/dialog').Dialog;

    const result = await handleChat(client as never, ACCOUNT, dialog, campaign, db as never, log);

    expect(result.replied).toBe(false);

    const messageSaves = calls.filter(
      (c) => c.table === 'tg_outreach_dialogs' && (c.op === 'update' || c.op === 'insert') && Array.isArray(c.payload?.messages) && (c.payload?.messages as unknown[]).length > 0,
    );
    expect(messageSaves.length).toBeGreaterThanOrEqual(1);

    const savedMessages = messageSaves[0].payload!.messages as DialogMessage[];
    expect(savedMessages.length).toBe(2);
  });

  it('does not save empty messages when no chat history', async () => {
    const campaign = makeCampaign();
    const client = makeMockClient([]);
    const { db, calls } = makeMockDb({ dialogExists: true });

    const entity = makeUser({ id: 12345, username: 'testuser' });
    const dialog = { entity, unreadCount: 1 } as unknown as import('telegram/tl/custom/dialog').Dialog;

    const result = await handleChat(client as never, ACCOUNT, dialog, campaign, db as never, log);

    expect(result.replied).toBe(false);

    const messageSaves = calls.filter(
      (c) => c.table === 'tg_outreach_dialogs' && (c.op === 'update' || c.op === 'insert') && Array.isArray(c.payload?.messages) && (c.payload?.messages as unknown[]).length > 0,
    );
    expect(messageSaves.length).toBe(0);
  });

  describe('global blocked users', () => {
    it('skips chat completely when tg_user_id is in blockedUserIds (with username)', async () => {
      const campaign = makeCampaign();
      const client = makeMockClient(USER_MESSAGES);
      const { db, calls } = makeMockDb({ dialogExists: false });

      const entity = makeUser({ id: 12345, username: 'spammer' });
      const dialog = { entity, unreadCount: 1 } as unknown as import('telegram/tl/custom/dialog').Dialog;

      const result = await handleChat(
        client as never,
        ACCOUNT,
        dialog,
        campaign,
        db as never,
        log,
        undefined,
        { blockedUserIds: new Set([12345]) },
      );

      expect(result.replied).toBe(false);
      expect(client.sendMessage).not.toHaveBeenCalled();
      expect(openaiGenerate).not.toHaveBeenCalled();
      // Не создаём строку диалога — иначе она засоряет UI и засчитывается как catch-up.
      const dialogWrites = calls.filter(c => c.table === 'tg_outreach_dialogs' && (c.op === 'insert' || c.op === 'upsert' || c.op === 'update'));
      expect(dialogWrites.length).toBe(0);
    });

    it('blocks ID even without username when ignore_no_username=false', async () => {
      const campaign = makeCampaign({
        telegram_settings: {
          ...DEFAULT_TELEGRAM_SETTINGS,
          ignore_no_username: false,
          pre_read_delay_range: [0, 0],
          read_reply_delay_range: [0, 0],
        },
      });
      const client = makeMockClient(USER_MESSAGES);
      const { db } = makeMockDb({ dialogExists: false });

      const entity = makeUser({ id: 77700123 });
      const dialog = { entity, unreadCount: 1 } as unknown as import('telegram/tl/custom/dialog').Dialog;

      const result = await handleChat(
        client as never,
        ACCOUNT,
        dialog,
        campaign,
        db as never,
        log,
        undefined,
        { blockedUserIds: new Set([77700123]) },
      );

      expect(result.replied).toBe(false);
      expect(client.sendMessage).not.toHaveBeenCalled();
    });

    it('does not block when blockedUserIds set does not include this id', async () => {
      const campaign = makeCampaign();
      const client = makeMockClient(USER_MESSAGES);
      const { db } = makeMockDb({ dialogExists: true, canSend: true });

      const entity = makeUser({ id: 99999, username: 'normal' });
      const dialog = { entity, unreadCount: 1 } as unknown as import('telegram/tl/custom/dialog').Dialog;

      const result = await handleChat(
        client as never,
        ACCOUNT,
        dialog,
        campaign,
        db as never,
        log,
        undefined,
        { blockedUserIds: new Set([12345]) },
      );

      expect(result.replied).toBe(false);
      expect(client.invoke).toHaveBeenCalled();
    });
  });
});
