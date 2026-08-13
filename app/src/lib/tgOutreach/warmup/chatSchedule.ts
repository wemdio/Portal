/**
 * Прогрев в публичных чатах: раскладка, план дня, выбор сообщения.
 *
 * Всё здесь — чистые функции. Работа с Telegram и БД остаётся снаружи, поэтому
 * вся арифметика этапа проверяется тестами и живёт в одном месте — ровно как
 * `schedule.ts` для переписок между своими.
 */
import {
  CHATS_PER_ACCOUNT,
  REPLY_TARGET_MAX_AGE_MIN,
  type WarmupActivityKind,
} from './types';

export interface ChatAssignment {
  accountId: string;
  chatId: string;
}

/**
 * Разложить аккаунты по чатам: каждому свои `CHATS_PER_ACCOUNT` из списка.
 *
 * Раздаём по кругу со сдвигом на индекс аккаунта. Это даёт две вещи разом:
 * покрытие чатов ровное (никто не простаивает, пока другой чат забит), а
 * составы участников у разных аккаунтов не совпадают — шестнадцать аккаунтов,
 * сидящих в одном наборе чатов, выдают друг друга по первому спалившемуся.
 *
 * Если чатов меньше нормы, каждый аккаунт попадает во все: это осознанный
 * компромисс, интерфейс предупреждает оператора о коротком списке.
 */
export function assignChats(
  accountIds: string[],
  chatIds: string[],
  perAccount = CHATS_PER_ACCOUNT,
): ChatAssignment[] {
  if (!accountIds.length || !chatIds.length) return [];

  const take = Math.min(Math.max(perAccount, 1), chatIds.length);
  const out: ChatAssignment[] = [];

  accountIds.forEach((accountId, accountIndex) => {
    for (let i = 0; i < take; i++) {
      const chatId = chatIds[(accountIndex + i) % chatIds.length];
      out.push({ accountId, chatId });
    }
  });

  return out;
}

export interface PlannedActivity {
  accountId: string;
  chatId: string;
  kind: WarmupActivityKind;
  plannedAt: string;
}

export interface PlanChatActivitiesParams {
  /** Уже отфильтрованные пары: без запрещённых чатов и отвалившихся аккаунтов. */
  assignments: ChatAssignment[];
  /** Сколько ответов должен дать один аккаунт за этот день. */
  replies: number;
  /** Сколько реакций должен поставить один аккаунт за этот день. */
  reactions: number;
  /** Активное окно суток: ночью аккаунты молчат. */
  window: { start: Date; end: Date };
  random: () => number;
}

/**
 * Составить план активностей на день.
 *
 * Норма считается на аккаунт, а не на чат: аккаунт, которому досталось три
 * чата, не должен писать втрое больше того, кому достался один. Чат под каждую
 * активность выбирается случайно из назначенных этому аккаунту — так следы
 * размазываются, а не выстраиваются в ровную очередь по чатам.
 */
export function planChatActivities(params: PlanChatActivitiesParams): PlannedActivity[] {
  const { assignments, window, random } = params;
  if (!assignments.length) return [];

  const replies = Math.max(params.replies, 0);
  const reactions = Math.max(params.reactions, 0);
  if (!replies && !reactions) return [];

  const chatsByAccount = new Map<string, string[]>();
  for (const { accountId, chatId } of assignments) {
    const list = chatsByAccount.get(accountId) ?? [];
    list.push(chatId);
    chatsByAccount.set(accountId, list);
  }

  const planned: Array<Omit<PlannedActivity, 'plannedAt'>> = [];
  for (const [accountId, chatIds] of chatsByAccount) {
    const pick = () => chatIds[Math.floor(random() * chatIds.length) % chatIds.length];
    for (let i = 0; i < replies; i++) {
      planned.push({ accountId, chatId: pick(), kind: 'reply' });
    }
    for (let i = 0; i < reactions; i++) {
      planned.push({ accountId, chatId: pick(), kind: 'reaction' });
    }
  }

  // Времена раскидываем по всему окну и сортируем: активности разных аккаунтов
  // перемешиваются, а не идут пачкой по аккаунту.
  const spanMs = Math.max(window.end.getTime() - window.start.getTime(), 1);
  const times = planned
    .map(() => window.start.getTime() + Math.floor(random() * spanMs))
    .sort((x, y) => x - y);

  return planned.map((a, i) => ({ ...a, plannedAt: new Date(times[i]).toISOString() }));
}

/**
 * Сообщение чата в том виде, в каком его отдаёт `chatOps.fetchRecentMessages`.
 * Абстракция намеренно тощая: фильтр не должен ничего знать про MTProto.
 */
export interface ChatMessage {
  id: number;
  text: string;
  date: Date;
  /** Автор. null — анонимный админ или пост от имени канала. */
  senderId: number | null;
  fromBot: boolean;
  isService: boolean;
}

export interface PickReplyTargetParams {
  messages: ChatMessage[];
  now: Date;
  /** tg_user_id всех аккаунтов кампании: своим на публике не отвечаем. */
  ownUserIds: Set<number>;
  random: () => number;
  maxAgeMin?: number;
}

/** Слишком короткое сообщение — не на что отвечать по существу. */
const MIN_TEXT_LENGTH = 15;

/** Слишком длинное требует вникания, и ответ на него виден как отписка. */
const MAX_TEXT_LENGTH = 400;

/**
 * Выбрать сообщение, на которое аккаунт ответит.
 *
 * Отсев решает три разные задачи, и их стоит различать. Боты, сервисные записи
 * и анонимные админы — это «отвечать некому». Короткие и длинные тексты, а
 * также несвежие — «отвечать нечего или поздно». А свои же аккаунты кампании —
 * защита от худшего следа из возможных: партия, публично переписывающаяся сама
 * с собой, вычисляется мгновенно.
 *
 * null означает «в этом чате сейчас нечего ответить» — активность пропускается,
 * и это нормальный исход, а не ошибка.
 */
export function pickReplyTarget(params: PickReplyTargetParams): ChatMessage | null {
  const { messages, now, ownUserIds, random } = params;
  const maxAgeMs = (params.maxAgeMin ?? REPLY_TARGET_MAX_AGE_MIN) * 60_000;

  const suitable = messages.filter((m) => {
    if (m.isService || m.fromBot) return false;
    if (m.senderId === null || ownUserIds.has(m.senderId)) return false;
    const text = m.text.trim();
    if (text.length < MIN_TEXT_LENGTH || text.length > MAX_TEXT_LENGTH) return false;
    return now.getTime() - m.date.getTime() <= maxAgeMs;
  });

  if (!suitable.length) return null;
  return suitable[Math.floor(random() * suitable.length) % suitable.length];
}

/**
 * Выбрать сообщение под реакцию.
 *
 * Фильтр мягче, чем у ответа: реакцию можно поставить и на короткую реплику, и
 * на картинку без подписи — от нас не требуется ничего понять. Остаются только
 * запреты, не зависящие от содержания: боты, служебные записи и свои аккаунты.
 */
export function pickReactionTarget(params: PickReplyTargetParams): ChatMessage | null {
  const { messages, now, ownUserIds, random } = params;
  const maxAgeMs = (params.maxAgeMin ?? REPLY_TARGET_MAX_AGE_MIN) * 60_000;

  const suitable = messages.filter((m) => {
    if (m.isService || m.fromBot) return false;
    if (m.senderId === null || ownUserIds.has(m.senderId)) return false;
    return now.getTime() - m.date.getTime() <= maxAgeMs;
  });

  if (!suitable.length) return null;
  return suitable[Math.floor(random() * suitable.length) % suitable.length];
}

/**
 * Разобрать ссылку на публичный чат в username.
 *
 * Принимаем то, что реально копируют из Telegram: полную ссылку, короткую
 * `t.me/имя` и просто `@имя`. Ссылки-приглашения (`t.me/+hash`, `joinchat/`)
 * возвращают null — они ведут в закрытые чаты, где активность ботоподобных
 * аккаунтов заметнее всего, и проверить чат заранее нельзя.
 */
export function parseChatLink(raw: string): string | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  const withoutScheme = trimmed
    .replace(/^https?:\/\//i, '')
    .replace(/^t\.me\//i, '')
    .replace(/^telegram\.me\//i, '')
    .replace(/^@/, '');

  // Отрезаем хвост запроса и вложенный путь: t.me/имя/123 — ссылка на конкретное
  // сообщение, нам нужен сам чат.
  const username = withoutScheme.split(/[/?#]/)[0];
  if (!username) return null;
  if (username.startsWith('+')) return null;
  if (/^joinchat$/i.test(username)) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9_]{3,31}$/.test(username)) return null;

  return username;
}
