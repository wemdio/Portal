/**
 * Telegram ping to the team when a visitor submits the landing demo-gate
 * (name/phone/email) before entering /demo. Mirrors the support/lead alert
 * pattern (lib/clientSupport/telegramAlert.ts): reuses the existing alerts bot
 * token (LEAD_ALERTS → CHANGELOG fallback), so NO new bot is required. Chat:
 * DEMO_LEADS_TELEGRAM_CHAT_ID, falling back to the lead-alerts chat so it works
 * out of the box (demo signups are leads); set the dedicated env to split them.
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
  referrer?: string | null;
}

function getToken(): string {
  return (
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

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendDemoLeadTelegramAlert(data: DemoLeadData): Promise<void> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) {
    console.warn(
      `[demo-lead-alert] skipped (token=${token ? 'set' : 'missing'}, chat=${chatId ? 'set' : 'missing'}). ` +
        'Set DEMO_LEADS_TELEGRAM_CHAT_ID (token falls back to LEAD_ALERTS/CHANGELOG).',
    );
    return;
  }

  const lines: string[] = [
    '🎯 <b>Новый лид с лендинга (демо)</b>',
    '',
    `<b>Имя:</b> ${esc(data.name)}`,
    `<b>Почта:</b> ${esc(data.email)}`,
  ];
  if (data.phone) lines.push(`<b>Телефон:</b> ${esc(data.phone)}`);
  if (data.telegram) lines.push(`<b>Telegram:</b> ${esc(data.telegram)}`);
  if (data.referrer) {
    lines.push('');
    lines.push(`<i>${esc(data.referrer)}</i>`);
  }

  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: lines.join('\n'),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
  } catch {
    // fire-and-forget — lead is already persisted
  }
}
