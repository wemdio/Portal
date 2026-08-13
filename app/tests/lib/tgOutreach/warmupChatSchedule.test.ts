/** @jest-environment node */

/**
 * Арифметика этапа публичных чатов.
 *
 * Кривая нагрузки живёт в `settings.ts` и проверяется в
 * `warmupSettings.test.ts` — сюда нормы приходят готовым числом. Здесь
 * остаётся то, из-за чего этап опасен: раскладка аккаунтов по разным чатам и
 * отсев сообщений, отвечать на которые нельзя. Telegram в тестах не участвует.
 */

import {
  assignChats,
  parseChatLink,
  pickReactionTarget,
  pickReplyTarget,
  planChatActivities,
  type ChatMessage,
} from '@/lib/tgOutreach/warmup/chatSchedule';

const WINDOW = {
  start: new Date('2026-08-07T05:00:00.000Z'),
  end: new Date('2026-08-07T21:00:00.000Z'),
};

describe('раскладка аккаунтов по чатам', () => {
  const accounts = ['a1', 'a2', 'a3', 'a4'];
  const chats = ['c1', 'c2', 'c3', 'c4', 'c5'];

  it('каждому аккаунту достаётся ровно норма чатов', () => {
    const out = assignChats(accounts, chats, 3);
    for (const id of accounts) {
      expect(out.filter((x) => x.accountId === id)).toHaveLength(3);
    }
  });

  it('составы у разных аккаунтов не совпадают', () => {
    const out = assignChats(accounts, chats, 3);
    const setOf = (id: string) =>
      out.filter((x) => x.accountId === id).map((x) => x.chatId).sort().join(',');
    expect(setOf('a1')).not.toBe(setOf('a2'));
  });

  it('чатов меньше нормы — все идут во все, но без дублей', () => {
    const out = assignChats(accounts, ['c1', 'c2'], 3);
    for (const id of accounts) {
      const mine = out.filter((x) => x.accountId === id).map((x) => x.chatId);
      expect(mine).toHaveLength(2);
      expect(new Set(mine).size).toBe(2);
    }
  });

  it('пустые входные данные не ломают раскладку', () => {
    expect(assignChats([], chats)).toEqual([]);
    expect(assignChats(accounts, [])).toEqual([]);
  });
});

describe('план активностей на день', () => {
  const assignments = [
    { accountId: 'a1', chatId: 'c1' },
    { accountId: 'a1', chatId: 'c2' },
    { accountId: 'a2', chatId: 'c2' },
  ];

  it('норма считается на аккаунт, а не на чат', () => {
    const plan = planChatActivities({
      assignments, window: WINDOW, random: () => 0.5,
      replies: 2, reactions: 3,
    });
    // У a1 два чата, у a2 один — но нагрузка одинаковая.
    for (const id of ['a1', 'a2']) {
      const mine = plan.filter((p) => p.accountId === id);
      expect(mine.filter((p) => p.kind === 'reply')).toHaveLength(2);
      expect(mine.filter((p) => p.kind === 'reaction')).toHaveLength(3);
    }
  });

  it('активности разложены внутри активного окна и упорядочены по времени', () => {
    const plan = planChatActivities({
      assignments, window: WINDOW, random: Math.random,
      replies: 2, reactions: 6,
    });
    const times = plan.map((p) => new Date(p.plannedAt).getTime());
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    for (const t of times) {
      expect(t).toBeGreaterThanOrEqual(WINDOW.start.getTime());
      expect(t).toBeLessThanOrEqual(WINDOW.end.getTime());
    }
  });

  it('аккаунт пишет только в назначенные ему чаты', () => {
    const plan = planChatActivities({
      assignments, window: WINDOW, random: Math.random,
      replies: 1, reactions: 5,
    });
    for (const p of plan.filter((x) => x.accountId === 'a2')) {
      expect(p.chatId).toBe('c2');
    }
  });

  it('без назначенных чатов плана нет', () => {
    expect(planChatActivities({
      assignments: [], window: WINDOW, random: () => 0.5,
      replies: 1, reactions: 3,
    })).toEqual([]);
  });
});

describe('выбор сообщения для ответа', () => {
  const now = new Date('2026-08-07T12:00:00.000Z');
  const base: ChatMessage = {
    id: 1,
    text: 'Кто-нибудь пробовал этот новый сервис доставки?',
    date: new Date('2026-08-07T11:50:00.000Z'),
    senderId: 500,
    fromBot: false,
    isService: false,
  };
  const pick = (messages: ChatMessage[], ownUserIds = new Set<number>()) =>
    pickReplyTarget({ messages, now, ownUserIds, random: () => 0 });

  it('обычное свежее сообщение подходит', () => {
    expect(pick([base])?.id).toBe(1);
  });

  it('свои же аккаунты кампании отсеиваются', () => {
    expect(pick([base], new Set([500]))).toBeNull();
  });

  it('боты, служебные записи и анонимные админы отсеиваются', () => {
    expect(pick([{ ...base, fromBot: true }])).toBeNull();
    expect(pick([{ ...base, isService: true }])).toBeNull();
    expect(pick([{ ...base, senderId: null }])).toBeNull();
  });

  it('слишком короткое и слишком длинное не годятся', () => {
    expect(pick([{ ...base, text: 'ок' }])).toBeNull();
    expect(pick([{ ...base, text: 'а'.repeat(401) }])).toBeNull();
  });

  it('несвежее не годится: ответ на вчерашнее выглядит машинным', () => {
    expect(pick([{ ...base, date: new Date('2026-08-07T08:00:00.000Z') }])).toBeNull();
  });

  it('нечего ответить — null, это нормальный исход, а не ошибка', () => {
    expect(pick([])).toBeNull();
  });
});

describe('выбор сообщения для реакции', () => {
  const now = new Date('2026-08-07T12:00:00.000Z');
  const short: ChatMessage = {
    id: 7,
    text: 'ок',
    date: new Date('2026-08-07T11:55:00.000Z'),
    senderId: 500,
    fromBot: false,
    isService: false,
  };

  it('короткое сообщение годится: понимать его не нужно', () => {
    const target = pickReactionTarget({
      messages: [short], now, ownUserIds: new Set(), random: () => 0,
    });
    expect(target?.id).toBe(7);
  });

  it('но своим аккаунтам реакции всё равно не ставим', () => {
    const target = pickReactionTarget({
      messages: [short], now, ownUserIds: new Set([500]), random: () => 0,
    });
    expect(target).toBeNull();
  });
});

describe('разбор ссылки на чат', () => {
  it('принимает формы, которые реально копируют из Telegram', () => {
    expect(parseChatLink('https://t.me/durov_chat')).toBe('durov_chat');
    expect(parseChatLink('t.me/durov_chat')).toBe('durov_chat');
    expect(parseChatLink('@durov_chat')).toBe('durov_chat');
    expect(parseChatLink('  durov_chat  ')).toBe('durov_chat');
  });

  it('ссылка на сообщение внутри чата сводится к самому чату', () => {
    expect(parseChatLink('https://t.me/durov_chat/12345')).toBe('durov_chat');
  });

  it('приглашения в закрытые чаты не принимаем', () => {
    expect(parseChatLink('https://t.me/+AbCdEf123')).toBeNull();
    expect(parseChatLink('t.me/joinchat/AbCdEf')).toBeNull();
  });

  it('мусор и слишком короткие имена отсекаются', () => {
    expect(parseChatLink('')).toBeNull();
    expect(parseChatLink('ab')).toBeNull();
    expect(parseChatLink('9lives_chat')).toBeNull();
  });
});

describe('нулевые нормы', () => {
  it('ноль ответов и ноль реакций дают пустой план, а не исключение', () => {
    expect(planChatActivities({
      assignments: [{ accountId: 'a1', chatId: 'c1' }],
      replies: 0, reactions: 0,
      window: WINDOW, random: () => 0.5,
    })).toEqual([]);
  });

  it('только реакции без ответов — допустимый день', () => {
    const plan = planChatActivities({
      assignments: [{ accountId: 'a1', chatId: 'c1' }],
      replies: 0, reactions: 3,
      window: WINDOW, random: () => 0.5,
    });
    expect(plan).toHaveLength(3);
    expect(plan.every((p) => p.kind === 'reaction')).toBe(true);
  });
});
