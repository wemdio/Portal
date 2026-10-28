import { extractAuthoredReplyText, getBodyText, type ThreadContext } from '@/lib/instantly/leadQualifier';
import { isFreeProvider } from '@/lib/emailValidation/shared';
import { stripQuoted } from '@/lib/senderLeads/telegram';

/**
 * Карточка лида наших кампаний («N. Polza_…», «ENagency …») для примечания в AMO
 * и сообщение в ТГ. Вид примечания — как у TG-аутрича: шапка, контакты, переписка (МСК).
 */

export interface CardMessage {
  role: 'us' | 'lead';
  text: string;
  timestamp: string | null;
}

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 3000;
const REPLY_PREVIEW_MAX = 1200;
const REASON_MAX = 600;

/** Письма ветки по порядку: ue_type 2 — ответ лида, остальное (и без типа, как в leadQualifier) — наши. */
export function messagesFromContext(ctx: ThreadContext): CardMessage[] {
  const emails = [...ctx.threadEmails];
  if (!emails.some((e) => e.id === ctx.replyEmail.id)) emails.push(ctx.replyEmail);
  return emails
    .map((e) => ({
      role: (e.ue_type ?? 1) === 2 ? ('lead' as const) : ('us' as const),
      text: extractAuthoredReplyText(getBodyText(e.body)).trim(),
      timestamp: e.timestamp_email ?? e.timestamp_created ?? null,
    }))
    .filter((m) => m.text)
    .sort((a, b) => (Date.parse(a.timestamp ?? '') || 0) - (Date.parse(b.timestamp ?? '') || 0));
}

function fmtStamp(value: string | null): string {
  if (!value) return '';
  const t = Date.parse(value);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t + 3 * 3600_000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `[${p(d.getUTCDate())}.${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}] `;
}

export function buildOwnReplyCard(input: {
  campaignName: string;
  leadEmail: string;
  leadName?: string | null;
  companyName?: string | null;
  phone?: string | null;
  website?: string | null;
  messages: CardMessage[];
}): string {
  const lines = [`Лид email-аутрича · ${input.campaignName || 'наши кампании'}`, '', `Почта: ${input.leadEmail}`];
  if (input.leadName) lines.push(`Имя: ${input.leadName}`);
  if (input.companyName) lines.push(`Компания: ${input.companyName}`);
  if (input.website) lines.push(`Сайт: ${input.website}`);
  if (input.phone) lines.push(`Телефон: ${input.phone}`);
  const messages = input.messages.slice(-MAX_MESSAGES);
  if (messages.length) {
    lines.push('', '── Переписка ──');
    for (const m of messages) {
      const clipped = m.text.length > MAX_MESSAGE_CHARS ? `${m.text.slice(0, MAX_MESSAGE_CHARS)}…` : m.text;
      lines.push(`${fmtStamp(m.timestamp)}${m.role === 'us' ? 'Мы' : 'Клиент'}: ${clipped}`);
    }
  }
  return lines.join('\n');
}

const CYRILLIC = /[а-яё]/i;

/** «аутрич» — если наши письма по-русски; иначе «англ аутрич» (как пишут менеджеры). */
export function subSourceOf(messages: CardMessage[], replyPreview: string | null): 'аутрич' | 'англ аутрич' {
  const ours = messages.filter((m) => m.role === 'us').map((m) => m.text).join('\n');
  const sample = ours || replyPreview || '';
  return CYRILLIC.test(sample) ? 'аутрич' : 'англ аутрич';
}

export function emailDomain(email: string | null | undefined): string | null {
  const at = (email ?? '').trim().toLowerCase().lastIndexOf('@');
  if (at < 0) return null;
  const domain = (email ?? '').trim().toLowerCase().slice(at + 1);
  return domain.includes('.') ? domain : null;
}

/** Домен почты, если она не на бесплатном сервисе (gmail, mail.ru…); иначе null. */
export function corporateDomain(email: string): string | null {
  const domain = emailDomain(email);
  return domain && !isFreeProvider(domain) ? domain : null;
}

/** «https://www.Acme.ru/about» → «acme.ru». */
export function siteHost(url: string | null | undefined): string | null {
  const raw = (url ?? '').trim().toLowerCase();
  if (!raw) return null;
  const host = raw.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#:]/)[0];
  return host.includes('.') ? host : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface OwnReplyTgInput {
  action: 'created' | 'note_added';
  campaignName: string;
  leadEmail: string;
  leadName: string | null;
  companyName: string | null;
  replySubject: string | null;
  replyBody: string | null;
  aiReason: string | null;
  leadUrl: string | null;
  amoLeadName: string | null;
}

export function buildOwnReplyTgMessage(input: OwnReplyTgInput): string {
  const lines: string[] = input.action === 'created'
    ? ['🟢 <b>Новый лид с email-аутрича</b>', '']
    : [`🔁 <b>Переписка добавлена к сделке</b>${input.amoLeadName ? ` «${escapeHtml(clip(input.amoLeadName, 200))}»` : ''}`, ''];
  lines.push(`<b>Кампания:</b> ${escapeHtml(clip(input.campaignName, 200))}`);
  lines.push(`<b>Контакт:</b> ${escapeHtml(clip(input.leadName ? `${input.leadName} · ${input.leadEmail}` : input.leadEmail, 320))}`);
  if (input.companyName) lines.push(`<b>Компания:</b> ${escapeHtml(clip(input.companyName, 200))}`);
  if (input.action === 'note_added') lines.push('С этой почтой или компанией сделка уже была — дубль не создан.');
  if (input.replySubject) lines.push(`<b>Тема:</b> ${escapeHtml(clip(input.replySubject, 300))}`);
  const body = (input.replyBody ?? '').trim();
  const reply = stripQuoted(body) || body;
  if (reply) lines.push('', '<b>Ответ:</b>', `<pre>${escapeHtml(clip(reply, REPLY_PREVIEW_MAX))}</pre>`);
  if (input.aiReason) lines.push('', `<b>ИИ:</b> ${escapeHtml(clip(input.aiReason, REASON_MAX))}`);
  if (input.leadUrl) lines.push('', `🔗 <a href="${escapeHtml(input.leadUrl)}">Сделка в AMO</a>`);
  lines.push('', '@u_obt');
  return lines.join('\n');
}
