/**
 * Telegram ping to the team when a visitor submits the landing demo-gate
 * (name/phone/email) before entering /demo. Mirrors the support/lead alert
 * pattern (lib/clientSupport/telegramAlert.ts).
 *   - Bot token: DEMO_LEADS_TELEGRAM_BOT_TOKEN (dedicated bot for demo signups),
 *     falling back to LEAD_ALERTS → CHANGELOG so it still works before a dedicated
 *     bot is provisioned. Set the dedicated token to split it off its own bot.
 *   - Chat: DEMO_LEADS_TELEGRAM_CHAT_ID, falling back to the lead-alerts chat so
 *     it works out of the box (demo signups are leads); set the dedicated env to
 *     route them to their own chat.
 *   - Topic: DEMO_LEADS_TELEGRAM_THREAD_ID — for forum (topic-enabled) supergroups,
 *     the message_thread_id of the target topic. Paired with the chat: only honoured
 *     when the dedicated chat is set (a thread id is only valid within its own chat);
 *     when we fall back to the lead chat we inherit LEAD_ALERTS_TELEGRAM_THREAD_ID.
 *
 * Never throws: the /api/demo-lead route awaits it best-effort; a TG outage must
 * not break the visitor reaching the demo. The lead is already stored regardless.
 */

const TG_FETCH_TIMEOUT_MS = 10_000;

export interface DemoLeadData {
  name: string;
  email: string;
  phone?: string | null;
  telegram?: string | null;
  company?: string | null;
  message?: string | null;
  /** Which surface produced the lead — drives the alert title. */
  source?: string | null;
  referrer?: string | null;
  /**
   * Campaign attribution captured on the landing via a parent-domain cookie
   * (Domain=outreachos.pro) and read server-side at signup. Only the utm_* keys
   * are rendered; referrer/landing/ts may also be present but are handled elsewhere.
   */
  utm?: Record<string, string> | null;
}

/** Human label per lead source, for the Telegram alert title. */
const SOURCE_LABEL: Record<string, string> = {
  hero: 'Обсудить задачу',
  register: 'Регистрация',
  demo: 'Демо',
};

function sourceLabel(source?: string | null): string {
  return (source && SOURCE_LABEL[source]) || 'лендинг';
}

/** Headline: a registration is a sign-up notice, not a "новый лид". */
function titleLine(source?: string | null): string {
  if (source === 'register') return '✅ <b>Новая регистрация</b>';
  return `🎯 <b>Новый лид — ${esc(sourceLabel(source))}</b>`;
}

function getToken(): string {
  return (
    process.env.DEMO_LEADS_TELEGRAM_BOT_TOKEN ||
    process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.CHANGELOG_BOT_TOKEN ||
    ''
  );
}

function getChatId(): string {
  return (
    process.env.DEMO_LEADS_TELEGRAM_CHAT_ID ||
    process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID ||
    ''
  );
}

function getThreadId(): number | null {
  // A thread id is only valid inside its own chat, so pair it with the chat above:
  // use the dedicated thread when the dedicated chat is set; otherwise (we fell back
  // to the lead chat) inherit the lead chat's thread. Unset/invalid → no thread.
  const raw = process.env.DEMO_LEADS_TELEGRAM_CHAT_ID
    ? process.env.DEMO_LEADS_TELEGRAM_THREAD_ID
    : process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID;
  const n = Number(raw ?? '');
  return Number.isFinite(n) && n > 0 ? n : null;
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendDemoLeadTelegramAlert(data: DemoLeadData): Promise<void> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) {
    console.warn(
      `[demo-lead-alert] skipped (token=${token ? 'set' : 'missing'}, chat=${chatId ? 'set' : 'missing'}). ` +
        'Set DEMO_LEADS_TELEGRAM_BOT_TOKEN + DEMO_LEADS_TELEGRAM_CHAT_ID ' +
        '(token falls back to LEAD_ALERTS/CHANGELOG).',
    );
    return;
  }

  const lines: string[] = [
    titleLine(data.source),
    '',
    `<b>Имя:</b> ${esc(data.name)}`,
    `<b>Почта:</b> ${esc(data.email)}`,
  ];
  if (data.company) lines.push(`<b>Компания:</b> ${esc(data.company)}`);
  if (data.phone) lines.push(`<b>Телефон:</b> ${esc(data.phone)}`);
  if (data.telegram) lines.push(`<b>Telegram:</b> ${esc(data.telegram)}`);
  if (data.utm) {
    const u = data.utm;
    const main = [u.utm_source, u.utm_medium, u.utm_campaign].filter(Boolean).join(' / ');
    if (main) lines.push(`<b>📈 UTM:</b> ${esc(main)}`);
    const extra = [u.utm_term, u.utm_content].filter(Boolean).join(' / ');
    if (extra) lines.push(`<b>UTM доп.:</b> ${esc(extra)}`);
  }
  if (data.message) {
    lines.push('');
    lines.push(esc(data.message));
  }
  if (data.referrer) {
    lines.push('');
    lines.push(`<i>${esc(data.referrer)}</i>`);
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text: lines.join('\n'),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  const threadId = getThreadId();
  if (threadId) payload.message_thread_id = threadId;

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
  } catch {
    // fire-and-forget — lead is already persisted
  }
}
