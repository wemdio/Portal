/**
 * Telegram ping to the operator when a client posts a support message.
 *
 * Why: the in-app fanout (lib/clientSupport/notify.ts → public.notifications) is
 * a polled bell icon, not a push — so managers miss messages when the portal
 * isn't open. This sends a real-time Telegram nudge, mirroring the proven
 * lead-alert pattern (lib/instantly/leadTelegramAlerts.ts).
 *
 * Config:
 *   - Bot token: reuses the existing alerts bot by fallback chain
 *     (SUPPORT_ALERTS → LEAD_ALERTS → CHANGELOG), so no new bot is required.
 *   - Chat: SUPPORT_ALERTS_TELEGRAM_CHAT_ID ONLY — deliberately NO fallback to
 *     the lead/changelog chat, so support pings never leak into those channels.
 *     If unset, we warn + skip (the message itself is already saved).
 *
 * Never throws: callers fire-and-forget it; a TG outage must not break the
 * client's "send message" request.
 */

const TG_FETCH_TIMEOUT_MS = 15_000;
const PREVIEW_MAX = 1500;

export interface SupportTelegramAlertData {
  clientDisplayName: string;
  body: string;
  threadId: string;
}

interface TgSendResult {
  ok: boolean;
  result?: { message_id?: number };
}

function getToken(): string {
  return (
    process.env.SUPPORT_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.CHANGELOG_BOT_TOKEN ||
    ''
  );
}

function getChatId(): string {
  return process.env.SUPPORT_ALERTS_TELEGRAM_CHAT_ID || '';
}

function getThreadId(): number | null {
  const raw = Number(process.env.SUPPORT_ALERTS_TELEGRAM_THREAD_ID ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function getPortalUrl(): string {
  return (process.env.SUPPORT_ALERTS_PORTAL_URL || process.env.NEXT_PUBLIC_SITE_URL || '')
    .trim()
    .replace(/\/+$/, '');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildMessage(data: SupportTelegramAlertData): string {
  const lines: string[] = [
    '🆘 <b>Новое сообщение в поддержку</b>',
    '',
    `<b>От:</b> ${escapeHtml(data.clientDisplayName)}`,
    '',
    `<pre>${escapeHtml(data.body.slice(0, PREVIEW_MAX))}</pre>`,
  ];

  const base = getPortalUrl();
  if (base) {
    lines.push('');
    lines.push(`<a href="${escapeHtml(base)}/support">Открыть в портале →</a>`);
  }

  return lines.join('\n');
}

export async function sendSupportTelegramAlert(
  data: SupportTelegramAlertData,
): Promise<{ sent: boolean; messageId: number | null }> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) {
    console.warn(
      `[support-telegram-alert] skipped (token=${token ? 'set' : 'missing'}, chat=${chatId ? 'set' : 'missing'}). ` +
        'Set SUPPORT_ALERTS_TELEGRAM_CHAT_ID (token falls back to LEAD_ALERTS/CHANGELOG).',
    );
    return { sent: false, messageId: null };
  }

  const body: Record<string, unknown> = {
    chat_id: chatId,
    text: buildMessage(data),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const threadId = getThreadId();
  if (threadId) body.message_thread_id = threadId;

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return { sent: false, messageId: null };

    const json = (await res.json()) as TgSendResult;
    return { sent: json.ok, messageId: json.result?.message_id ?? null };
  } catch {
    return { sent: false, messageId: null };
  }
}

export const _private = { buildMessage, escapeHtml };
