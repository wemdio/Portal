/** @jest-environment node */

/**
 * Ветка PEER_FLOOD в очереди передач (09.09.2026, ATOL-1).
 *
 * До правки ограничение аккаунта считалось окончательным отказом: задача
 * помечалась «не отправлена», хотя подменный аккаунт из `getFallbackClient`
 * существовал и мог везти карточку. 29 аккаунтов кампании ушли под PEER_FLOOD
 * в один день — и передача лида @golden_imperator застряла «НЕ отправлена»
 * при живых соседях.
 *
 * Проверяем именно маршрутизацию по исходу: 'restricted' уводит задачу на
 * подменного сразу, без пяти пятиминутных ретраев, которые лечат сеть, но не
 * ограничение Telegram.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { TelegramClient } from 'telegram';
import { processLeadForwards, type PendingForward } from '@/lib/tgOutreach/leadForward';

interface UpdateCall {
  table: string;
  patch: Record<string, unknown>;
  filters: Record<string, unknown>;
}

const PEER_FLOOD_MSG = '400: PEER_FLOOD (caused by messages.SendMessage)';

function makeTask(): PendingForward {
  return {
    id: 'fwd-1',
    kind: 'lead',
    account_id: 'acc-owner',
    target_chat: '@managers',
    message_text: 'Карточка лида: @lead_guy, кампания ATOL',
    dialog_id: 'dlg-1',
    requested_by_name: 'Егор',
    requested_at: '2026-09-09T14:25:00Z',
  };
}

/**
 * Подставная база: очередь отдаёт одну задачу, диалог — одного собеседника,
 * апдейты записываются в массив, чтобы тест видел, чем закончилась задача.
 */
function fakeDb() {
  const updates: UpdateCall[] = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          return chain;
        },
        order: () => chain,
        limit: async () =>
          table === 'tg_outreach_lead_forwards'
            ? { data: [makeTask()], error: null }
            : { data: [], error: null },
        maybeSingle: async () =>
          table === 'tg_outreach_dialogs'
            ? { data: { tg_user_id: 4242, tg_username: 'lead_guy' }, error: null }
            : { data: null, error: null },
        update: (patch: Record<string, unknown>) => {
          updates.push({ table, patch, filters });
          return chain;
        },
      };
      return chain;
    },
  };
  return { db: db as unknown as SupabaseClient, updates };
}

function fakeClient(sendMessage: (...args: unknown[]) => Promise<unknown>) {
  return {
    sendMessage,
    getEntity: jest.fn(),
    getMessages: jest.fn().mockResolvedValue([]),
    forwardMessages: jest.fn().mockResolvedValue([]),
  } as unknown as TelegramClient;
}

function makeLog() {
  const lines: string[] = [];
  const log = (_level: 'info' | 'warning' | 'error', msg: string) => lines.push(msg);
  return { log, lines };
}

test('PEER_FLOOD у владельца — карточку сразу отправляет подменный аккаунт', async () => {
  const { db, updates } = fakeDb();
  const owner = fakeClient(jest.fn().mockRejectedValue(new Error(PEER_FLOOD_MSG)));
  const spareSend = jest.fn().mockResolvedValue({});
  const spare = fakeClient(spareSend);
  const { log } = makeLog();

  const result = await processLeadForwards({
    db,
    campaignId: 'camp-1',
    getClient: () => ({ client: owner, accountName: 'owner-session' }),
    getFallbackClient: () => ({ client: spare, accountName: 'spare-session' }),
    log,
  });

  expect(result).toEqual({ sent: 1, failed: 0, retried: 0 });
  expect(spareSend).toHaveBeenCalledWith('managers', { message: 'Карточка лида: @lead_guy, кампания ATOL' });
  const final = updates.filter((u) => u.table === 'tg_outreach_lead_forwards').pop();
  expect(final?.patch.status).toBe('sent');
});

test('PEER_FLOOD у владельца, а свободного аккаунта нет — задача закрыта с понятной причиной', async () => {
  const { db, updates } = fakeDb();
  const owner = fakeClient(jest.fn().mockRejectedValue(new Error(PEER_FLOOD_MSG)));
  const { log } = makeLog();

  const result = await processLeadForwards({
    db,
    campaignId: 'camp-1',
    getClient: () => ({ client: owner, accountName: 'owner-session' }),
    getFallbackClient: () => null,
    log,
  });

  expect(result).toEqual({ sent: 0, failed: 1, retried: 0 });
  const final = updates.filter((u) => u.table === 'tg_outreach_lead_forwards').pop();
  expect(final?.patch.status).toBe('failed');
  expect(String(final?.patch.error_message)).toContain('PEER_FLOOD');
  expect(String(final?.patch.error_message)).toContain('свободного аккаунта');
});

test('чужая ошибка (не флуд) — сразу «не отправлена», подменный не зовётся', async () => {
  const { db, updates } = fakeDb();
  const owner = fakeClient(
    jest.fn().mockRejectedValue(new Error('400: CHAT_WRITE_FORBIDDEN (caused by messages.SendMessage)')),
  );
  const spare = fakeClient(jest.fn().mockResolvedValue({}));
  const getFallbackClient = jest.fn(() => ({ client: spare, accountName: 'spare-session' }));
  const { log } = makeLog();

  const result = await processLeadForwards({
    db,
    campaignId: 'camp-1',
    getClient: () => ({ client: owner, accountName: 'owner-session' }),
    getFallbackClient,
    log,
  });

  expect(result).toEqual({ sent: 0, failed: 1, retried: 0 });
  expect(getFallbackClient).not.toHaveBeenCalled();
  expect(spare.sendMessage).not.toHaveBeenCalled();
  const final = updates.filter((u) => u.table === 'tg_outreach_lead_forwards').pop();
  expect(final?.patch.status).toBe('failed');
  expect(String(final?.patch.error_message)).toContain('CHAT_WRITE_FORBIDDEN');
});
