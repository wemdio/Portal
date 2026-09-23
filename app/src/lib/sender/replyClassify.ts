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

/**
 * Метка прогрева Instantly в конце темы: «… | fat--effect 8RPM8Z3»,
 * «… | T77FWPB 8RPM8Z3» — слово-код письма и фильтр-тег аккаунта заглавными
 * латинскими буквами с цифрами. Так выглядели все 552 «ответа» от чужих
 * доменов на проде 24.09.2026.
 */
// Тег обязан содержать и букву, и цифру: «| Заказ 12345678» — не прогрев.
const INSTANTLY_WARMUP_TAG = /\|\s*\S+\s+(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{6,8}\s*$/;

/** Адрес нашего же парка: письма между своими ящиками — прогрев, не ответы. */
export function isOwnMailboxReply(fromEmail: string | null, ownEmails: ReadonlySet<string>): boolean {
  if (!fromEmail) return false;
  return ownEmails.has(fromEmail.toLowerCase());
}

/**
 * Публичные почтовые сервисы: совпадение домена тут ничего не говорит — с
 * gmail.com пишут все подряд. Для них нужен точный адрес. Список тот же, что
 * в миграции 20260924_0002 (перенос накопленного прогрева).
 */
const PUBLIC_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yandex.ru', 'yandex.com', 'ya.ru', 'mail.ru', 'bk.ru',
  'inbox.ru', 'list.ru', 'internet.ru', 'rambler.ru', 'outlook.com', 'hotmail.com',
  'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'proton.me', 'protonmail.com',
  'gmx.com', 'aol.com',
]);

/** Корпоративный домен адреса; null — адреса нет или это публичная почта. */
export function corporateDomain(email: string | null): string | null {
  const domain = (email ?? '').toLowerCase().split('@')[1]?.trim();
  if (!domain || PUBLIC_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}

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

  if (WARMUP_SUBJECTS.test(subject) || INSTANTLY_WARMUP_TAG.test(subject)) return 'warmup';
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

/**
 * Код из поля Status: отчёта о недоставке (DSN) — «5.1.1», «4.2.2», …
 * Именно он отличает «адреса не существует» от «ящик переполнен» и прочих
 * временных причин: подавление адреса по ним было бы вечным и незаслуженным.
 */
export function extractBounceStatus(body: string | null): string | null {
  if (!body) return null;
  // Средняя часть — от одной до трёх цифр: 5.1.1 и 5.2.22 одинаково валидны.
  const match = body.match(/(?:^|\n)\s*Status:\s*([245])\.(\d{1,3})\.(\d+)/i);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

/**
 * Вечное подавление адреса — только за «адреса нет» (5.1.x). Переполнение
 * ящика, greylisting и прочие 4.x/5.2.x проходят: адрес жив, повторная
 * кампания имеет право написать ещё раз.
 */
export function bounceIsPermanent(status: string | null): boolean {
  if (!status) return true; // код не разобрался — действуем по-старому
  return /^5\.1\./.test(status);
}

// Граница перед ключевым словом — не-буква: «отпишите» в середине фразы это
// тот же отказ, что и «Стоп» с новой строки, а влезание внутрь чужого слова
// исключаем.
const STOP_REQUEST = /(?:^|[^\p{L}])(стоп|отпиш\p{L}*|отпис\p{L}*|не\s+пиш\p{L}+|удал\p{L}*\s+(меня|адрес|из\s+базы)|unsubscribe|remove\s+me|stop\s+(?:emailing|sending)|take\s+me\s+off)/iu;

/**
 * Просьба больше не писать. Такой ответ — не лид для дожима, а отказ:
 * цепочка обрывается, адрес уходит в глобальный стоп-лист (reason
 * 'unsubscribe'), чтобы следующая кампания не написала снова.
 */
export function isStopRequest(body: string | null, subject: string | null): boolean {
  const text = `${subject ?? ''}\n${body ?? ''}`;
  return STOP_REQUEST.test(text.slice(0, 2000));
}
