/** @jest-environment node */
/**
 * Отправка «Рассылки» ничего не ждёт: планировщик и входы в ящики идут фоном
 * (одна работа за раз), входящие читаются только у работающих ящиков, а
 * планировщик, потерявший аренду, заканчивает проход сам.
 */

jest.mock('server-only', () => ({}));

let mockDb: unknown = null;
jest.mock('@/lib/supabaseAdmin', () => ({
  get supabaseAdmin() {
    return mockDb;
  },
}));
const fetchNewReplies = jest.fn();
jest.mock('@/lib/byoMailbox/imap', () => ({
  fetchNewReplies: (...args: unknown[]) => fetchNewReplies(...args),
}));
jest.mock('@/lib/sender/mailboxAuth', () => ({
  authForMailbox: async () => ({ ok: true, smtp: {}, imap: { kind: 'password', password: 'x' } }),
}));

import { createMockSupabase } from '../helpers/mockSupabase';
import { BackgroundLane } from '@/lib/sender/backgroundLane';
import { planSenderMessages } from '@/lib/sender/planner';
import { processSenderReplies } from '@/lib/sender/repliesWorker';

const box = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  email: `${id}@x.ru`,
  status: 'verified',
  enabled: true,
  egress_ip: '1.1.1.1',
  imap_host: 'imap.x.ru',
  imap_checked_at: null,
  last_error: null,
  ...extra,
});

describe('фоновая дорожка', () => {
  it('один проход за раз и не чаще интервала, ошибка прохода не роняет воркер', async () => {
    const log = jest.fn();
    const lane = new BackgroundLane('Тест', 1000, log);
    let release!: () => void;
    const job = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));

    expect(lane.kick(job, 0)).toBe(true);
    expect(lane.kick(job, 5000)).toBe(false);
    release();
    await lane.drain(100);
    expect(lane.kick(job, 500)).toBe(false);
    expect(lane.kick(() => Promise.reject(new Error('сбой')), 1500)).toBe(true);
    await lane.drain(100);
    expect(log).toHaveBeenCalledWith('warn', 'Тест: сбой');
    expect(job).toHaveBeenCalledTimes(1);
  });

  it('остановка ждёт идущий проход, но не дольше срока', async () => {
    const lane = new BackgroundLane('Тест', 0, jest.fn());
    lane.kick(() => new Promise(() => {}));
    expect(await lane.drain(20)).toBe(false);
  });

  it('без срока ждёт до конца прохода (Infinity — не 1 мс таймера)', async () => {
    const lane = new BackgroundLane('Тест', 0, jest.fn());
    let finished = false;
    lane.kick(() => new Promise<void>((resolve) => setTimeout(() => { finished = true; resolve(); }, 30)));
    expect(await lane.drain(Number.POSITIVE_INFINITY)).toBe(true);
    expect(finished).toBe(true);
  });
});

describe('опрос входящих', () => {
  beforeEach(() => {
    fetchNewReplies.mockReset();
    fetchNewReplies.mockResolvedValue({ replies: [], newLastUid: 5, uidValidity: '1' });
  });

  it('опрашивает ящики, которые выбрала база (работающие), с паузой на ящик', async () => {
    const db = createMockSupabase({
      tables: { sender_mailboxes: [box('a'), box('b'), box('c')] },
      rpcHandlers: { sender_reply_poll_mailboxes: () => ({ data: [box('b')] }) },
    });
    mockDb = db;

    await processSenderReplies({ egressIp: '1.1.1.1', minGapSeconds: 300 });

    expect(db.rpcCalls[0]).toMatchObject({
      fn: 'sender_reply_poll_mailboxes',
      params: { p_egress_ip: '1.1.1.1', p_min_gap_seconds: 300 },
    });
    expect(fetchNewReplies.mock.calls.map(([row]) => (row as { id: string }).id)).toEqual(['b']);
  });

  it('без функции в базе (миграция ещё не применена) — как раньше, все ящики адреса', async () => {
    const db = createMockSupabase({
      tables: { sender_mailboxes: [box('a'), box('b'), box('other', { egress_ip: '2.2.2.2' })] },
    });
    mockDb = db;

    await processSenderReplies({ egressIp: '1.1.1.1' });

    expect(fetchNewReplies.mock.calls.map(([row]) => (row as { id: string }).id).sort()).toEqual(['a', 'b']);
  });

  it('останавливается между ящиками, когда воркер уходит', async () => {
    const db = createMockSupabase({
      tables: { sender_mailboxes: [box('a'), box('b')] },
      rpcHandlers: { sender_reply_poll_mailboxes: () => ({ data: [box('a'), box('b')] }) },
    });
    mockDb = db;
    let calls = 0;

    await processSenderReplies({ egressIp: '1.1.1.1', shouldContinue: () => calls++ < 1 });

    expect(fetchNewReplies).toHaveBeenCalledTimes(1);
  });

  it('ошибку упавшего тем временем ящика не стирает', async () => {
    const db = createMockSupabase({
      tables: { sender_mailboxes: [box('a', { status: 'failed', last_error: 'SMTP: 535' })] },
      rpcHandlers: { sender_reply_poll_mailboxes: () => ({ data: [box('a', { last_error: 'IMAP: старая заметка' })] }) },
    });
    mockDb = db;

    await processSenderReplies({ egressIp: '1.1.1.1' });

    expect(db.getRows('sender_mailboxes')[0]).toMatchObject({ status: 'failed', last_error: 'SMTP: 535', imap_last_uid: 5 });
  });
});

describe('планировщик', () => {
  it('потерял аренду — проход заканчивается до первой кампании', async () => {
    const db = createMockSupabase({
      tables: { sender_campaigns: [{ id: 'c1', name: 'К1', status: 'running', created_at: '2026-10-01' }] },
    });
    mockDb = db;
    const log = jest.fn();

    const planned = await planSenderMessages({ log, shouldContinue: () => false });

    expect(planned).toBe(0);
    expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('Проход планировщика остановлен'));
    expect(db.selects.filter((s) => s.table !== 'sender_campaigns')).toEqual([]);
  });
});
