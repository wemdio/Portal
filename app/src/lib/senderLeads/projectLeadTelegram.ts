import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Карточка лида «Рассылки» специалисту проекта — через бот лид-алертов
 * Instantly (LEAD_ALERTS_*): только у него есть кнопки и вебхук
 * (/api/telegram/handoff/webhook). Бот «Рассылки» шлёт только текст.
 *
 * Кнопки — подписанные callback_data `{p|x}.{recipient_id}.{sig24}` (63 байта
 * при лимите 64): p — «Передать клиенту», x — «Не лид». Префиксы не заняты
 * кнопками Instantly (h, n, r, e, u, s, c), подпись — HMAC токеном бота, как у них.
 */

const TG_TIMEOUT_MS = 15_000;
const SIG_LEN = 24;

export type SenderLeadAction = 'p' | 'x';

export type InlineButton = { text: string; callback_data: string } | { text: string; url: string };
export type InlineKeyboard = InlineButton[][];

export function signSenderLeadAction(action: SenderLeadAction, recipientId: string, secret: string): string {
  const body = `${action}.${recipientId}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url').slice(0, SIG_LEN)}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Кнопка карточки «Рассылки» — или null: чужая или поддельная. */
export function verifySenderLeadAction(data: unknown, secret: string): { action: SenderLeadAction; recipientId: string } | null {
  if (typeof data !== 'string' || !secret) return null;
  const match = /^([px])\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{24})$/.exec(data);
  if (!match) return null;
  const action = match[1] as SenderLeadAction;
  return safeEqual(data, signSenderLeadAction(action, match[2], secret)) ? { action, recipientId: match[2] } : null;
}

/** Похоже на кнопку карточки «Рассылки» (без проверки подписи) — вебхук отдаёт её сюда. */
export function isSenderLeadActionData(data: unknown): boolean {
  return typeof data === 'string' && /^[px]\./.test(data);
}

async function tgCall<T>(token: string, method: string, body: Record<string, unknown>): Promise<T> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null;
  if (!res.ok || !json?.ok) throw new Error(`Telegram ${method}: ${json?.description ?? `HTTP ${res.status}`}`.slice(0, 300));
  return json.result as T;
}

export interface SenderLeadCardPost {
  token: string;
  chatId: string;
  threadId: number | null;
  html: string;
  keyboard: InlineKeyboard;
}

/** Отправить карточку. Ошибка — исключение: карточка повторится по лесенке. */
export async function postSenderProjectLeadCard(card: SenderLeadCardPost): Promise<number> {
  const result = await tgCall<{ message_id?: number }>(card.token, 'sendMessage', {
    chat_id: card.chatId,
    text: card.html,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(card.threadId ? { message_thread_id: card.threadId } : {}),
    ...(card.keyboard.length ? { reply_markup: { inline_keyboard: card.keyboard } } : {}),
  });
  if (typeof result?.message_id !== 'number') throw new Error('Telegram sendMessage: нет message_id');
  return result.message_id;
}

/**
 * Заменить текст карточки и её кнопки (по умолчанию — без кнопок решения,
 * со ссылкой на переписку, если она есть). «message is not modified» — не ошибка.
 */
export async function editSenderProjectLeadCard(opts: {
  token: string;
  chatId: string;
  messageId: number;
  html: string;
  keyboard: InlineKeyboard;
}): Promise<void> {
  try {
    await tgCall(opts.token, 'editMessageText', {
      chat_id: opts.chatId,
      message_id: opts.messageId,
      text: opts.html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: opts.keyboard },
    });
  } catch (error) {
    if (error instanceof Error && /message is not modified/i.test(error.message)) return;
    throw error;
  }
}

/** Ответ на нажатие: Telegram принимает не больше 200 символов. Ошибка не важна. */
export async function answerSenderLeadCallback(token: string, callbackQueryId: string, text: string, showAlert = false): Promise<void> {
  try {
    await tgCall(token, 'answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      text: text.length > 200 ? `${text.slice(0, 199)}…` : text,
      show_alert: showAlert,
    });
  } catch {
    // Нажатие уже обработано; всплывающая подсказка — не главное.
  }
}
