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
  /**
   * true — ИИ признал ответ лидом по критериям, которые КЛИЕНТ сам задал на
   * /client/replies («свой промпт»). Даёт бейдж в DM. Для дефолтных/проектных
   * критериев не ставится — DM остаётся обычным уведомлением.
   */
  isLeadByClientCriteria?: boolean;
  /**
   * true — Instantly НЕ привязал письмо к кампании («сирота»: лид ответил с
   * другого адреса своей компании, сломанные заголовки треда), кампания
   * атрибутирована НАМИ по цитируемому домену (othersWatchdog). DM обязан
   * сказать об этом честно — «Ответ вне треда кампании»: формулировка «по
   * вашей кампании» отправляла клиента искать письмо в кампании, где его нет
   * и быть не может (ложная атрибуция, инцидент 11.08.2026).
   */
  outOfCampaign?: boolean;
  /** Ящик, физически принявший письмо — показываем в DM при outOfCampaign. */
  eaccount?: string | null;
}

/**
 * Build the client-facing reply notification. Intentionally omits internal
 * fields (AI reasoning, confidence, our last outbound) — the client just wants
 * to see who replied and what they said.
 */
export function buildClientReplyMessage(data: ClientReplyMessageData): string {
  const dateSource = data.replyTimestamp ? new Date(data.replyTimestamp) : new Date();
  // timeZone обязателен: воркер крутится в контейнере с TZ=UTC, и без него
  // toLocale* рендерил время на 3 часа раньше московского — спец получала
  // «09:52» на ответ, пришедший в 12:52 МСК (инцидент 16.07.2026). Клиенты и
  // спецы у нас в РФ, поэтому единый ориентир — Москва, и он подписан явно,
  // чтобы «а это в каком поясе?» больше не возникало.
  const date = Number.isNaN(dateSource.getTime())
    ? ''
    : `${dateSource.toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: 'Europe/Moscow',
      })} (МСК)`;

  const lines: string[] = [];
  if (data.outOfCampaign) {
    // Сирота: заголовок НЕ «по вашей кампании» — честно, что Instantly письмо
    // не привязал. Бейдж «по вашим критериям» (если промпт клиента дал lead)
    // сохраняем второй строкой — он про вердикт, а не про привязку.
    lines.push('📩 <b>Ответ вне треда кампании</b>');
    if (data.isLeadByClientCriteria) lines.push('🔥 <b>Лид по вашим критериям</b>');
  } else {
    lines.push(
      data.isLeadByClientCriteria
        ? '🔥 <b>Лид по вашим критериям</b>'
        : '📩 <b>Новый ответ по вашей кампании</b>',
    );
  }
  lines.push('');

  if (data.outOfCampaign && data.eaccount) {
    lines.push(`📬 <b>Ящик:</b> ${escapeHtml(data.eaccount)}`);
  }
  if (data.campaignName) {
    // У сироты кампания — наша атрибуция по домену («похоже на лид кампании»),
    // а не факт привязки. Полезно как контекст, но не как утверждение.
    lines.push(
      data.outOfCampaign
        ? `🔎 <b>Похоже на лид кампании:</b> ${escapeHtml(data.campaignName)}`
        : `📨 <b>Кампания:</b> ${escapeHtml(data.campaignName)}`,
    );
  }
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
