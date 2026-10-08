import type { DialogMessage } from './types';

/** A reply to a role-check question is not consent to an offer that was never made. */
export function isRoleOnlyReply(messages: DialogMessage[]): boolean {
  const lastOurs = [...messages].reverse().find(message => message.role === 'assistant')?.content ?? '';
  if (!lastOurs.includes('?')) return false;

  const asksAboutRole = /(ваша задача|ваш[а-яё]*\s+задач|занимаетесь|отвечаете|вед[её]те|курируете|работаете|управляете|владелец|руководител|маркетолог|директор|собственник)/i.test(lastOurs);
  const containsOffer = /(интересно|обсудить|помогаем|мы можем|могу (?:помочь|рассказать)|предлож|условия|стоимост|оплат|вознагражден|партн[её]рск|прислать|показать)/i.test(lastOurs);
  return asksAboutRole && !containsOffer;
}
