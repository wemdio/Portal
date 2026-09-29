import { sendMessage } from '@/lib/tgBot/telegramClient';

/**
 * Лид «Рассылки» → общий ТГ-чат продаж.
 *
 * Бот — «Polza Site Feedback»: его обновления (кнопки, сообщения) принимает
 * сторонний сервис лидмагнита, поэтому здесь только sendMessage — ни кнопок,
 * ни setWebhook. «Не лид» ставят на портале по ссылке из сообщения.
 *
 * По умолчанию — группа «Продажи Polza», подчат General: у General номера
 * подчата нет, сообщение без message_thread_id попадает туда само.
 */

const DEFAULT_CHAT_ID = -1001852890744;
const REPLY_PREVIEW_MAX = 1200;
const REASON_MAX = 600;

export interface LeadTelegramConfig {
  token: string;
  chatId: number;
  threadId: number | null;
}

export function leadTelegramConfig(env: NodeJS.ProcessEnv = process.env): LeadTelegramConfig | null {
  const token = (env.SENDER_LEADS_TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!token) return null;
  const chatRaw = Number((env.SENDER_LEADS_TELEGRAM_CHAT_ID ?? '').trim());
  const threadRaw = Number((env.SENDER_LEADS_TELEGRAM_THREAD_ID ?? '').trim());
  return {
    token,
    chatId: Number.isFinite(chatRaw) && chatRaw !== 0 ? chatRaw : DEFAULT_CHAT_ID,
    threadId: Number.isFinite(threadRaw) && threadRaw > 0 ? threadRaw : null,
  };
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Ответ без процитированной переписки: в чате нужен сам ответ, а не наше письмо под ним. */
export function stripQuoted(body: string): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const cut = lines.findIndex((line) => {
    const t = line.trim();
    return t.startsWith('>')
      || /^On\b.*\bwrote:$/i.test(t)
      || /написал(а)?:$/i.test(t)
      || /^-{2,}\s*Original Message/i.test(t)
      || /^From:\s/i.test(t);
  });
  return (cut > 0 ? lines.slice(0, cut) : lines).join('\n').trim();
}

export interface LeadMessageInput {
  folderName: string | null;
  campaignName: string;
  recipientName: string | null;
  recipientEmail: string;
  replyFrom: string | null;
  replySubject: string | null;
  replyBody: string;
  aiReason: string | null;
  threadUrl: string | null;
}

export function buildLeadMessage(input: LeadMessageInput): string {
  const lines: string[] = ['📨 <b>Новый лид из Рассылки</b>', ''];
  const where = [input.folderName, input.campaignName].filter(Boolean).map((s) => escapeHtml(clip(s!, 200)));
  lines.push(`<b>Рассылка:</b> ${where.join(' · ')}`);
  const contact = input.replyFrom && input.replyFrom.toLowerCase() !== input.recipientEmail.toLowerCase()
    ? `${input.replyFrom} (писали на ${input.recipientEmail})`
    : input.recipientEmail;
  lines.push(`<b>Контакт:</b> ${escapeHtml(clip(contact, 320))}`);
  if (input.recipientName) lines.push(`<b>Компания:</b> ${escapeHtml(clip(input.recipientName, 200))}`);
  if (input.replySubject) lines.push(`<b>Тема:</b> ${escapeHtml(clip(input.replySubject, 300))}`);

  const reply = stripQuoted(input.replyBody) || input.replyBody.trim();
  if (reply) lines.push('', '<b>Ответ:</b>', `<pre>${escapeHtml(clip(reply, REPLY_PREVIEW_MAX))}</pre>`);
  if (input.aiReason) lines.push('', `<b>ИИ:</b> ${escapeHtml(clip(input.aiReason, REASON_MAX))}`);
  if (input.threadUrl) lines.push('', `🔗 <a href="${escapeHtml(input.threadUrl)}">Открыть переписку</a>`);
  return lines.join('\n');
}

export async function sendLeadMessage(config: LeadTelegramConfig, text: string): Promise<number> {
  const result = await sendMessage(config.token, {
    chatId: config.chatId,
    text,
    parseMode: 'HTML',
    disableWebPagePreview: true,
    ...(config.threadId ? { messageThreadId: config.threadId } : {}),
  });
  return result.message_id;
}

/** Адрес переписки на портале: вкладка «Письма» сразу открывает её. */
export function threadUrl(recipientId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const base = (env.PORTAL_PUBLIC_URL ?? env.NEXT_PUBLIC_SITE_URL ?? '').trim().replace(/\/+$/, '');
  return base ? `${base}/tools/sender?tab=threads&thread=${encodeURIComponent(recipientId)}` : null;
}
