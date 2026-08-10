/**
 * Прогрев в публичных чатах: всё общение с Telegram.
 *
 * Цикл прогрева работает только через этот модуль и о MTProto ничего не знает —
 * так вся арифметика этапа остаётся в чистых функциях `chatSchedule.ts`, а
 * рискованные места (вступление, публичная отправка) собраны в одном файле, где
 * их видно целиком.
 *
 * Каждый вызов под таймаутом: после инцидента 06.08.2026 известно, что зависший
 * запрос в мобильный прокси не возвращается никогда и доводит цикл до
 * сторожевого таймера воркера, который роняет процесс со всеми кампаниями.
 */
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { withTimeout } from '../withTimeout';
import type { ChatMessage } from './chatSchedule';

/** Сколько ждать ответа Telegram на одну операцию в чате. */
function callTimeoutMs(): number {
  return Number(process.env.TG_WARMUP_CHAT_CALL_TIMEOUT_MS) || 60_000;
}

/** Сколько последних сообщений чата просматриваем в поисках подходящего. */
const HISTORY_LIMIT = 60;

export interface ResolvedChat {
  entity: Api.Channel;
  tgChatId: number;
  title: string;
  participantsCount: number | null;
}

/**
 * Ошибка, из-за которой аккаунту больше нельзя работать в этом чате.
 *
 * Отличается от обычного сбоя тем, что повтор бессмысленен: забаненного не
 * пустят и завтра. Цикл переводит участие в `forbidden` и перестаёт планировать
 * активности, вместо того чтобы каждый день упираться в один и тот же запрет.
 */
export class ChatForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChatForbiddenError';
  }
}

/** Похоже ли на «сюда тебе нельзя» — в отличие от временного сбоя связи. */
export function looksForbidden(errMsg: string): boolean {
  return /CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE|CHAT_ADMIN_REQUIRED|USER_RESTRICTED|CHAT_SEND_PLAIN_FORBIDDEN/i
    .test(errMsg);
}

/** Временный тормоз Telegram: слоу-мод или флуд-контроль. */
export function looksThrottled(errMsg: string): boolean {
  return /SLOWMODE_WAIT|FLOOD_WAIT|PEER_FLOOD/i.test(errMsg);
}

/** Ошибку Telegram — в понятную оператору фразу. */
export function describeChatError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  // Не Telegram, а хранилище портала — иначе фраза про прокси уводит не туда.
  if (/Object not found|The resource was not found/i.test(msg)) {
    return 'файл сессии не найден в хранилище портала — перезалейте аккаунт';
  }

  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID/i.test(msg)) return 'чата с таким адресом нет';
  if (/CHANNEL_PRIVATE/i.test(msg)) return 'чат закрытый — вступить по ссылке нельзя';
  if (/CHAT_WRITE_FORBIDDEN|CHAT_SEND_PLAIN_FORBIDDEN/i.test(msg)) return 'в чате запрещено писать';
  if (/USER_BANNED_IN_CHANNEL/i.test(msg)) return 'аккаунт забанен в этом чате';
  if (/INVITE_REQUEST_SENT/i.test(msg)) return 'чат требует одобрения — заявка отправлена';
  if (/CHANNELS_TOO_MUCH/i.test(msg)) return 'аккаунт состоит в предельном числе чатов';
  const slow = /SLOWMODE_WAIT_(\d+)/i.exec(msg);
  if (slow) return `в чате медленный режим, ждать ${slow[1]}с`;
  const flood = /FLOOD_WAIT_(\d+)/i.exec(msg);
  if (flood) return `Telegram просит подождать ${flood[1]}с`;

  return msg;
}

/**
 * Найти публичный чат по username.
 *
 * Только каналы и супергруппы: обычные группы по username не резолвятся, а
 * приглашения в закрытые чаты мы принципиально не поддерживаем.
 */
export async function resolveChat(
  client: TelegramClient,
  username: string,
): Promise<ResolvedChat> {
  const res = await withTimeout(
    client.invoke(new Api.contacts.ResolveUsername({ username })),
    callTimeoutMs(),
    'поиск чата',
  );

  const channel = res.chats.find((c): c is Api.Channel => c instanceof Api.Channel);
  if (!channel) throw new Error('по этому адресу не публичный чат или канал');

  return {
    entity: channel,
    tgChatId: Number(channel.id),
    title: channel.title ?? username,
    participantsCount: channel.participantsCount ?? null,
  };
}

/**
 * Вступить в чат.
 *
 * Повторное вступление в чат, где аккаунт уже состоит, Telegram принимает
 * молча — отдельно это не проверяем.
 */
export async function joinChat(client: TelegramClient, entity: Api.Channel): Promise<void> {
  try {
    await withTimeout(
      client.invoke(new Api.channels.JoinChannel({ channel: entity })),
      callTimeoutMs(),
      'вступление в чат',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksForbidden(msg)) throw new ChatForbiddenError(describeChatError(e));
    throw e;
  }
}

/**
 * Последние сообщения чата в виде, пригодном для чистого фильтра.
 *
 * Разбор MTProto заканчивается здесь: наружу уходит плоская структура без
 * единого типа из `telegram`, чтобы выбор сообщения тестировался без Telegram.
 */
export async function fetchRecentMessages(
  client: TelegramClient,
  entity: Api.Channel,
): Promise<ChatMessage[]> {
  const res = await withTimeout(
    client.invoke(new Api.messages.GetHistory({ peer: entity, limit: HISTORY_LIMIT })),
    callTimeoutMs(),
    'чтение чата',
  );

  const messages = (res as { messages?: Api.TypeMessage[] }).messages ?? [];
  const bots = new Set(
    ((res as { users?: Api.TypeUser[] }).users ?? [])
      .filter((u): u is Api.User => u instanceof Api.User)
      .filter((u) => u.bot)
      .map((u) => Number(u.id)),
  );

  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (m instanceof Api.MessageService) {
      out.push({
        id: m.id,
        text: '',
        date: new Date(m.date * 1000),
        senderId: null,
        fromBot: false,
        isService: true,
      });
      continue;
    }
    if (!(m instanceof Api.Message)) continue;

    // fromId отсутствует у постов от имени канала и анонимных админов —
    // отвечать там некому, и фильтр это учитывает по senderId === null.
    const senderId =
      m.fromId instanceof Api.PeerUser ? Number(m.fromId.userId) : null;

    out.push({
      id: m.id,
      text: m.message ?? '',
      date: new Date(m.date * 1000),
      senderId,
      fromBot: senderId != null && bots.has(senderId),
      isService: false,
    });
  }

  return out;
}

/** Ответить реплаем на сообщение в чате. */
export async function replyToMessage(
  client: TelegramClient,
  entity: Api.Channel,
  messageId: number,
  text: string,
): Promise<void> {
  try {
    await withTimeout(
      client.sendMessage(entity, { message: text, replyTo: messageId }),
      callTimeoutMs(),
      'ответ в чате',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksForbidden(msg)) throw new ChatForbiddenError(describeChatError(e));
    throw e;
  }
}

/**
 * Эмодзи, которые можно ставить в этом чате.
 *
 * Спрашиваем у самого чата, а не берём из своего списка: в чатах с ограниченным
 * набором реакция «не из списка» отлетит с ошибкой, а это лишний повод для
 * внимания к аккаунту. Пустой ответ означает, что реакции в чате выключены.
 */
export async function availableReactions(
  client: TelegramClient,
  entity: Api.Channel,
): Promise<string[]> {
  const full = await withTimeout(
    client.invoke(new Api.channels.GetFullChannel({ channel: entity })),
    callTimeoutMs(),
    'настройки чата',
  );

  const available = (full.fullChat as Api.ChannelFull).availableReactions;

  if (available instanceof Api.ChatReactionsNone) return [];
  if (available instanceof Api.ChatReactionsSome) {
    return available.reactions
      .filter((r): r is Api.ReactionEmoji => r instanceof Api.ReactionEmoji)
      .map((r) => r.emoticon);
  }
  // ChatReactionsAll или поле не пришло — разрешены стандартные; берём самые
  // безобидные, чтобы реакция не выглядела оценкой.
  return ['👍', '❤️', '🔥', '😁'];
}

/** Поставить реакцию на сообщение. */
export async function sendReaction(
  client: TelegramClient,
  entity: Api.Channel,
  messageId: number,
  emoticon: string,
): Promise<void> {
  try {
    await withTimeout(
      client.invoke(
        new Api.messages.SendReaction({
          peer: entity,
          msgId: messageId,
          reaction: [new Api.ReactionEmoji({ emoticon })],
        }),
      ),
      callTimeoutMs(),
      'реакция в чате',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (looksForbidden(msg)) throw new ChatForbiddenError(describeChatError(e));
    throw e;
  }
}

/**
 * Восстановить сущность чата для работы.
 *
 * Отдельная функция, а не прямой вызов resolveChat: цикл получает чат по одному
 * и тому же пути и в момент вступления, и на каждой активности, а способ
 * восстановления меняется в одном месте.
 */
export async function chatEntity(
  client: TelegramClient,
  chat: { username: string | null },
): Promise<Api.Channel> {
  if (!chat.username) throw new Error('у чата не сохранён адрес');
  const resolved = await resolveChat(client, chat.username);
  return resolved.entity;
}
