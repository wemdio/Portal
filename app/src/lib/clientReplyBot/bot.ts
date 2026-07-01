/**
 * Dedicated, passive "client replies" Telegram bot.
 *
 * Sole purpose: DM a client the TEXT of a meaningful reply to their cold-outreach
 * campaign, the moment the qualifier classifies it (lead / objection /
 * needs_review). The client connects this bot themselves from the portal
 * (`/client/replies` → «Подключить Telegram» → deep-link `/start lnk<token>`),
 * so it is fully self-serve and isolated from:
 *   - the team "agent" bot (@Polza_portal_bot, TG_AGENT_BOT_TOKEN), and
 *   - the atmos notifications bot (TELEGRAM_ATMOS_BOT_TOKEN) used for the
 *     team's MANUAL group-chat lead forwarding.
 *
 * Everything degrades gracefully: with no token configured every call is a
 * silent no-op, so the feature can ship dark and light up once the env vars are
 * set on prod.
 */

const TG_FETCH_TIMEOUT_MS = 15_000;
const TG_MAX_MESSAGE_LENGTH = 4096;

export function getClientRepliesBotToken(): string {
  return process.env.CLIENT_REPLIES_BOT_TOKEN ?? '';
}

/** Bot @username without a leading @ (used to build the t.me deep-link). */
export function getClientRepliesBotUsername(): string {
  return (process.env.CLIENT_REPLIES_BOT_USERNAME ?? '').trim().replace(/^@+/, '');
}

/** True only when both the token and the username are configured. */
export function isClientRepliesBotConfigured(): boolean {
  return !!getClientRepliesBotToken() && !!getClientRepliesBotUsername();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Split on newline/space boundaries to respect Telegram's 4096-char limit. */
function splitMessage(text: string): string[] {
  if (text.length <= TG_MAX_MESSAGE_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= TG_MAX_MESSAGE_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', TG_MAX_MESSAGE_LENGTH);
    if (splitAt < TG_MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = remaining.lastIndexOf(' ', TG_MAX_MESSAGE_LENGTH);
    }
    if (splitAt < TG_MAX_MESSAGE_LENGTH * 0.3) {
      splitAt = TG_MAX_MESSAGE_LENGTH;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

async function tgSend(token: string, chatId: number, text: string): Promise<number | null> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { ok: boolean; result?: { message_id: number } };
    return json.ok ? (json.result?.message_id ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Send an already-built HTML message to a chat. Returns the first chunk's
 * message id (or null on any failure — never throws).
 */
export async function sendClientReplyTelegram(
  chatId: number,
  html: string,
): Promise<{ messageId: number | null }> {
  const token = getClientRepliesBotToken();
  if (!token) return { messageId: null };

  const chunks = splitMessage(html);
  let firstId: number | null = null;
  for (let i = 0; i < chunks.length; i++) {
    const id = await tgSend(token, chatId, chunks[i]);
    if (i === 0) firstId = id;
  }
  return { messageId: firstId };
}

/** Send a short plain status message (linking confirmations, errors). */
export async function sendClientReplyPlain(chatId: number, text: string): Promise<void> {
  const token = getClientRepliesBotToken();
  if (!token) return;
  await tgSend(token, chatId, text);
}

export interface ClientReplyMessageData {
  campaignName: string | null;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  replySubject: string | null;
  replyBody: string | null;
  replyTimestamp: string | null;
}

/**
 * Build the client-facing reply notification. Intentionally omits internal
 * fields (AI reasoning, confidence, our last outbound) — the client just wants
 * to see who replied and what they said.
 */
export function buildClientReplyMessage(data: ClientReplyMessageData): string {
  const dateSource = data.replyTimestamp ? new Date(data.replyTimestamp) : new Date();
  const date = Number.isNaN(dateSource.getTime())
    ? ''
    : dateSource.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
      });

  const lines: string[] = [];
  lines.push('📩 <b>Новый ответ по вашей кампании</b>');
  lines.push('');

  if (data.campaignName) lines.push(`📨 <b>Кампания:</b> ${escapeHtml(data.campaignName)}`);
  if (data.leadName) lines.push(`👤 <b>От:</b> ${escapeHtml(data.leadName)}`);
  lines.push(`✉️ <b>Email:</b> ${escapeHtml(data.leadEmail)}`);
  if (data.companyName) lines.push(`🏢 <b>Компания:</b> ${escapeHtml(data.companyName)}`);
  if (date) lines.push(`🕘 ${escapeHtml(date)}`);
  lines.push('');

  if (data.replySubject) {
    lines.push(`<b>Тема:</b> ${escapeHtml(data.replySubject)}`);
  }
  if (data.replyBody) {
    const body = data.replyBody.slice(0, 2500);
    lines.push(`<pre>${escapeHtml(body)}</pre>`);
  }

  const siteUrl = (process.env.NEXT_PUBLIC_SITE_URL || process.env.PORTAL_PUBLIC_URL || '').replace(/\/+$/, '');
  if (siteUrl) {
    lines.push('');
    lines.push(`🔗 <a href="${siteUrl}/client/replies">Открыть в портале</a>`);
  }

  return lines.join('\n');
}
