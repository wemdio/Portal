import type { ReplyKind } from './types';

/**
 * Что это за входящее письмо. Цепочку останавливает только живой ответ:
 * автоответ «в отпуске», отбойник почтового сервера и письмо прогрева — нет.
 */

const BOUNCE_SENDERS = /(mailer-daemon|postmaster|no-?reply@.*(mail|smtp)|delivery.?subsystem)/i;
const BOUNCE_SUBJECTS = /(undeliverable|delivery (status notification|has failed|failure)|returned mail|mail delivery failed|не доставлено|доставка не выполнена)/i;
const BOUNCE_BODY = /(550|551|552|553|554|5\.1\.1|5\.4\.1|recipient address rejected|user unknown|mailbox (unavailable|not found)|does not exist)/i;

const AUTO_SUBJECTS = /(out of office|автоответ|отсутствую|on vacation|automatic reply|auto-?reply|absence)/i;
const AUTO_BODY = /(я в отпуске|вернусь|out of the office|currently away|automatic reply)/i;

/** Прогрев ходит по своим ящикам со служебными метками в теме. */
const WARMUP_SUBJECTS = /(warm-?up|warmy|mailreach|instantly.*warm|\[wu-)/i;

export interface ReplyInput {
  fromEmail: string | null;
  subject: string | null;
  body: string | null;
  /** Заголовки отчёта о недоставке, если их удалось прочитать. */
  contentType?: string | null;
}

export function classifyReply(input: ReplyInput): ReplyKind {
  const from = (input.fromEmail ?? '').toLowerCase();
  const subject = input.subject ?? '';
  const body = input.body ?? '';
  const contentType = (input.contentType ?? '').toLowerCase();

  // Формальный отчёт о доставке — самый надёжный признак отбойника.
  if (contentType.includes('report-type=delivery-status') || contentType.includes('message/delivery-status')) {
    return 'bounce';
  }
  if (BOUNCE_SENDERS.test(from) || BOUNCE_SUBJECTS.test(subject)) return 'bounce';
  if (BOUNCE_BODY.test(body) && BOUNCE_SENDERS.test(from)) return 'bounce';

  if (WARMUP_SUBJECTS.test(subject)) return 'warmup';
  if (AUTO_SUBJECTS.test(subject) || AUTO_BODY.test(body)) return 'auto_reply';

  return from ? 'human' : 'unknown';
}

/**
 * Адрес получателя, к которому относится отбойник. В теле отчёта он приходит
 * в поле Final-Recipient/Original-Recipient, иначе берём из текста первый
 * адрес, не совпадающий с нашим ящиком.
 */
export function extractBouncedRecipient(body: string | null, mailboxEmail: string): string | null {
  if (!body) return null;
  const explicit = body.match(/(?:final|original)-recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i);
  if (explicit) return explicit[1].toLowerCase();

  const candidates = body.match(/[^\s<>"]+@[^\s<>"]+\.[a-z]{2,}/gi) ?? [];
  for (const candidate of candidates) {
    const email = candidate.toLowerCase().replace(/[.,;:]+$/, '');
    if (email !== mailboxEmail.toLowerCase()) return email;
  }
  return null;
}
