const TG_FETCH_TIMEOUT_MS = 15_000;

function getToken(): string {
  return process.env.TELEGRAM_ATMOS_BOT_TOKEN ?? '';
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

interface TgSendResult {
  ok: boolean;
  result?: { message_id: number };
}

export interface LeadNotificationData {
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  phone: string | null;
  website: string | null;
  linkedinUrl: string | null;
  campaignName: string | null;
  replySubject: string | null;
  replyBody: string | null;
  lastOutboundPreview: string | null;
  replyTimestamp: string | null;
  status: string | null;
  aiReason: string | null;
}

export async function sendLeadNotification(
  chatId: number,
  data: LeadNotificationData,
): Promise<{ messageId: number | null }> {
  const token = getToken();
  if (!token) return { messageId: null };

  // timeZone обязателен: TZ контейнера = UTC, без него дата у полуночи съезжает
  // на день назад (ответ в 01:30 МСК 17-го = 22:30 UTC 16-го → «16 июля»).
  // Единый ориентир — Москва, как и в клиентском DM (см. clientReplyBot/bot.ts).
  const date = data.replyTimestamp
    ? new Date(data.replyTimestamp).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        timeZone: 'Europe/Moscow',
      })
    : new Date().toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        timeZone: 'Europe/Moscow',
      });

  const lines: string[] = [];

  lines.push('🎯 <b>Новый лид</b>');
  lines.push('');

  lines.push(`📅 <b>Дата:</b> ${escapeHtml(date)}`);
  if (data.campaignName) {
    lines.push(`📨 <b>Кампания:</b> ${escapeHtml(data.campaignName)}`);
  }
  lines.push('');

  lines.push('👤 <b>Контакт:</b>');
  if (data.leadName) lines.push(`  Имя: ${escapeHtml(data.leadName)}`);
  lines.push(`  Email: ${escapeHtml(data.leadEmail)}`);
  if (data.companyName) lines.push(`  Компания: ${escapeHtml(data.companyName)}`);
  if (data.phone) lines.push(`  Телефон: ${escapeHtml(data.phone)}`);
  if (data.website) lines.push(`  Сайт: ${escapeHtml(data.website)}`);
  if (data.linkedinUrl) lines.push(`  LinkedIn: ${escapeHtml(data.linkedinUrl)}`);
  lines.push('');

  if (data.lastOutboundPreview) {
    lines.push('📤 <b>Наше последнее письмо:</b>');
    const preview = data.lastOutboundPreview.slice(0, 500);
    lines.push(`<i>${escapeHtml(preview)}</i>`);
    lines.push('');
  }

  if (data.replyBody || data.replySubject) {
    lines.push('📩 <b>Ответ лида:</b>');
    if (data.replySubject) lines.push(`Тема: ${escapeHtml(data.replySubject)}`);
    if (data.replyBody) {
      const body = data.replyBody.slice(0, 1500);
      lines.push(`<pre>${escapeHtml(body)}</pre>`);
    }
    lines.push('');
  }

  if (data.aiReason) {
    lines.push(`🤖 <b>AI-анализ:</b> ${escapeHtml(data.aiReason)}`);
  }

  const text = lines.join('\n');

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

    if (!res.ok) return { messageId: null };

    const json = (await res.json()) as TgSendResult;
    return { messageId: json.result?.message_id ?? null };
  } catch {
    return { messageId: null };
  }
}
