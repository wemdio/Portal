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
  clientName: string | null;
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

/**
 * Куда слать алерт. Раньше fallback'а на CHANGELOG не было: если поставили
 * LEAD_ALERTS_TELEGRAM_BOT_TOKEN, но забыли _CHAT_ID — silent skip без логов.
 * На проде до 2026-05-14 это привело к тому, что лидовая система вообще не
 * писала никуда (был задан только CHANGELOG_BOT_TOKEN, без LEAD_ALERTS).
 *
 * Теперь: если LEAD_ALERTS_TELEGRAM_CHAT_ID задан — используем его. Иначе —
 * fallback на CHANGELOG_CHAT_ID (тот же канал что и dev-сводки). Это
 * симметрично с поведением для токена и не оставляет систему беззвучной.
 */
function getChatId(): string {
  return process.env.LEAD_ALERTS_TELEGRAM_CHAT_ID
    || process.env.CHANGELOG_CHAT_ID
    || '';
}

/**
 * Опциональный thread в группе. Если задан LEAD_ALERTS_TELEGRAM_THREAD_ID —
 * шлём именно туда, иначе fallback на CHANGELOG_THREAD_ID (тот же thread
 * что и changelog), чтобы лиды не валились в общий поток группы и были
 * легко находимы.
 */
function getThreadId(): number | null {
  const raw = Number(
    process.env.LEAD_ALERTS_TELEGRAM_THREAD_ID
    ?? process.env.CHANGELOG_THREAD_ID
    ?? '',
  );
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
  // Пинг по числовому telegram_id НАДЁЖНЕЕ, чем @username. Ник кэшируется в
  // telegram_links при линковке и устаревает: сменил ник или даже регистр —
  // @упоминание перестаёт пинговать, хотя человек в группе. Инцидент Илианы
  // (10.07.2026): в БД `gziliana`, реальный ник стал `gzIliana` → бот «перестал
  // отмечать» по PP Prod. telegram_id неизменен, а text_mention по нему пингует
  // любого участника группы. Поэтому ID — приоритетный путь, @username — фолбэк.
  const name =
    specialist.fullName?.trim() ||
    normalizeUsername(specialist.telegramUsername) ||
    'Специалист';
  if (specialist.telegramId) {
    return `<a href="tg://user?id=${escapeHtml(String(specialist.telegramId))}">${escapeHtml(name)}</a>`;
  }
  const username = normalizeUsername(specialist.telegramUsername);
  if (username) return `@${escapeHtml(username)}`;
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
  if (data.clientName) lines.push(`<b>Клиент Portal:</b> ${escapeHtml(data.clientName)}`);
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
  if (!token || !chatId) {
    // Silent fail в прошлом приводил к «лиды есть, чат пустой» без объяснений.
    // Логируем чтобы причина была видна в docker logs portal-worker-instantly-leads.
    console.warn(
      `[lead-telegram-alert] skipped (token=${token ? 'set' : 'missing'}, chat=${chatId ? 'set' : 'missing'}). ` +
        `Set LEAD_ALERTS_TELEGRAM_BOT_TOKEN/CHAT_ID (or rely on CHANGELOG_* fallback).`,
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
