import type { DialogMessage } from './types';

// Only the TG_VBI campaign uses a role-check first touch. Other campaigns
// keep the existing interest detection and handoff behaviour.
export const VBI_CAMPAIGN_ID = '978f79cb-6ccd-4b4c-9b6f-aa23cb4af614';

export function isVbiRoleOnlyReply(messages: DialogMessage[]): boolean {
  const lastOurs = [...messages].reverse().find(message => message.role === 'assistant')?.content ?? '';
  return /\?/.test(lastOurs)
    && /(маркетинг|привлечени[ея] клиент|продвижени[ея])/.test(lastOurs.toLowerCase())
    && /(ваша задача|отвечаете|занимаетесь|вед[её]те|курируете|работаете)/.test(lastOurs.toLowerCase())
    && !/(интересно|обсудить|помогаем|разбор|стратеги|рост продаж|предложени)/.test(lastOurs.toLowerCase());
}

export function vbiRoleStageReply(messages: DialogMessage[]): string | null {
  const incoming = [...messages].reverse().find(message => message.role === 'user')?.content.trim().toLowerCase() ?? '';
  if (!incoming || /(?:^|\s)(?:нет|не занимаюсь|не моя|не отвечаю|не работаю|не интересно|неинтересно)(?:\s|$|[,.!])/.test(incoming)) return null;
  // A vendor offering *their* marketing services is not a prospect agreeing
  // to discuss ours, even when they also answer the role question with "да".
  if (/(могу|можем|готов[аы]?)\s+помочь|предлагаю|оказыва[юем]|мои услуги|наши услуги/.test(incoming)) {
    return 'Спасибо за предложение. Сейчас мы ищем компании, которым может быть актуально развитие собственного маркетинга. Не буду отвлекать.';
  }
  if (!/^(?:(?:добрый день|здравствуйте|доброе утро|добрый вечер)[!,. ]*)?(?:да|верно|всё верно|все верно|это моя задача)(?:\s|$|[,.!])/.test(incoming)) return null;
  return 'Спасибо за ответ! Написал, потому что мы помогаем компаниям находить возможности для роста продаж через digital-маркетинг. Подскажите, пожалуйста, вам было бы интересно это обсудить?';
}
