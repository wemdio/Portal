import 'server-only';

/**
 * Telegram-уведомления инструмента «Рассылка» (задача 5.8 хендоффа масштаба).
 *
 * Паттерн — lib/clientSupport/telegramAlert.ts: токен с fallback-цепочкой на
 * существующие боты, чат строго свой (SENDER_ALERTS_TELEGRAM_CHAT_ID) без
 * fallback в чужие каналы. Не настроено — предупредили и пропустили: мониторинг
 * не должен ронять отправку.
 */

const TG_FETCH_TIMEOUT_MS = 15_000;

function getToken(): string {
  return (
    process.env.SENDER_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN ||
    process.env.CHANGELOG_BOT_TOKEN ||
    ''
  );
}

function getChatId(): string {
  return process.env.SENDER_ALERTS_TELEGRAM_CHAT_ID || '';
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Заголовок + строки маркированным списком, как в остальных алертах портала. */
export async function sendSenderAlert(title: string, lines: string[]): Promise<boolean> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) {
    console.warn(
      `[sender-alert] skipped (token=${token ? 'set' : 'missing'}, chat=${chatId ? 'set' : 'missing'}). ` +
        'Set SENDER_ALERTS_TELEGRAM_CHAT_ID to enable sender monitoring alerts.',
    );
    return false;
  }

  const text = [`⚠️ <b>${escapeHtml(title)}</b>`, '', ...lines.map((l) => `• ${escapeHtml(l)}`)].join('\n');

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(TG_FETCH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
