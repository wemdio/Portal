/**
 * Telegram helpers for the lead-handoff "Передать клиенту" flow.
 * Reuses the LEAD_ALERTS bot (dedicated; already in the alerts chat) — posting
 * the button and answering its press both go through this bot's token.
 */

const TG_TIMEOUT_MS = 15_000;

export function handoffBotToken(): string {
  return process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN || process.env.CHANGELOG_BOT_TOKEN || '';
}

export function handoffChatId(): string {
  return process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID || process.env.CHANGELOG_CHAT_ID || '';
}

export function handoffThreadId(): number | null {
  const raw = Number(
    process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID ?? process.env.CHANGELOG_THREAD_ID ?? '',
  );
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function tg<T = unknown>(token: string, method: string, body: Record<string, unknown>): Promise<T | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TG_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; result?: T };
    return json.ok ? (json.result ?? null) : null;
  } catch {
    return null;
  }
}

/** Posts the handoff message with a single "Передать клиенту" button. Returns the message_id. */
export async function postHandoffMessage(opts: {
  token: string;
  chatId: string;
  text: string;
  callbackData: string;
  threadId?: number | null;
}): Promise<number | null> {
  const body: Record<string, unknown> = {
    chat_id: opts.chatId,
    text: opts.text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: {
      inline_keyboard: [[{ text: '➡️ Передать клиенту', callback_data: opts.callbackData }]],
    },
  };
  if (opts.threadId) body.message_thread_id = opts.threadId;
  const result = await tg<{ message_id?: number }>(opts.token, 'sendMessage', body);
  return result?.message_id ?? null;
}

/** Replies to a button press (toast or alert popup). */
export async function answerCallback(
  token: string,
  callbackQueryId: string,
  text: string,
  showAlert = false,
): Promise<void> {
  await tg(token, 'answerCallbackQuery', {
    callback_query_id: callbackQueryId,
    text,
    show_alert: showAlert,
  });
}

/** Replaces the handoff message text and drops the button (post-send / consumed). */
export async function editHandoffMessage(
  token: string,
  chatId: number | string,
  messageId: number,
  text: string,
): Promise<void> {
  await tg(token, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [] },
  });
}
