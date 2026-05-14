const TG_FETCH_TIMEOUT_MS = 15_000;

export interface LeadTelegramSpecialistMention {
  userId: string;
  fullName: string | null;
  telegramId: string | number | null;
  telegramUsername: string | null;
}

export interface LeadTelegramAlertData {
  qualificationId: string;
  campaignId: string;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  campaignName: string | null;
  specialistMentions: LeadTelegramSpecialistMention[];
  replySubject: string | null;
  replyPreview: string | null;
  aiReason: string | null;
}

interface TgSendResult {
  ok: boolean;
  result?: { message_id?: number };
}

function getToken(): string {
  return process.env.LEAD_ALERTS_TELEGRAM_BOT_TOKEN
    || process.env.CHANGELOG_BOT_TOKEN
    || '';
}

function getChatId(): string {
  return process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID || '';
}

function getThreadId(): number | null {
  const raw = Number(process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : null;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeUsername(username: string | null): string | null {
  const value = username?.trim().replace(/^@+/, '');
  return value || null;
}

function mentionSpecialist(specialist: LeadTelegramSpecialistMention): string {
  const username = normalizeUsername(specialist.telegramUsername);
  if (username) return `@${escapeHtml(username)}`;

  const name = specialist.fullName?.trim() || 'Специалист';
  if (specialist.telegramId) {
    return `<a href="tg://user?id=${escapeHtml(String(specialist.telegramId))}">${escapeHtml(name)}</a>`;
  }
  return escapeHtml(name);
}

function buildMessage(data: LeadTelegramAlertData): string {
  const contactLabel = data.leadName
    ? `${data.leadName} (${data.leadEmail})`
    : data.leadEmail;
  const mentions = data.specialistMentions.length
    ? data.specialistMentions.map(mentionSpecialist).join(', ')
    : 'ответственный специалист не найден';

  const lines: string[] = [
    '<b>Новый лид из Instantly</b>',
    '',
    `<b>Ответственный:</b> ${mentions}`,
    `<b>Контакт:</b> ${escapeHtml(contactLabel)}`,
  ];

  if (data.companyName) lines.push(`<b>Компания:</b> ${escapeHtml(data.companyName)}`);
  if (data.campaignName) lines.push(`<b>Кампания:</b> ${escapeHtml(data.campaignName)}`);
  if (data.replySubject) lines.push(`<b>Тема:</b> ${escapeHtml(data.replySubject)}`);

  if (data.replyPreview) {
    lines.push('');
    lines.push('<b>Ответ:</b>');
    lines.push(`<pre>${escapeHtml(data.replyPreview.slice(0, 1200))}</pre>`);
  }

  if (data.aiReason) {
    lines.push('');
    lines.push(`<b>AI:</b> ${escapeHtml(data.aiReason)}`);
  }

  lines.push('');
  lines.push(`<code>${escapeHtml(data.qualificationId)}</code>`);

  return lines.join('\n');
}

export async function sendLeadTelegramAlert(
  data: LeadTelegramAlertData,
): Promise<{ sent: boolean; messageId: number | null }> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) return { sent: false, messageId: null };

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

    const json = await res.json() as TgSendResult;
    return {
      sent: json.ok,
      messageId: json.result?.message_id ?? null,
    };
  } catch {
    return { sent: false, messageId: null };
  }
}

export const _private = {
  buildMessage,
  escapeHtml,
};
