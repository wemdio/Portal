import { PLACEHOLDER_RE, varKey } from './templateVars';

// Message-ID общий для обоих движков отправки портала — см. lib/mail/message.
export { buildMessageId } from '@/lib/mail/message';

/**
 * Подстановка {{var}} из полей получателя. Неизвестная переменная → пусто.
 * Имя внутри скобок приводится тем же правилом, что и заголовки колонок
 * (templateVars.varKey): {{Company Name}}, {{companyName}} и {{company_name}}
 * — одно и то же, кириллица работает.
 */
export function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(PLACEHOLDER_RE, (_, raw: string) => vars[varKey(raw)] ?? '');
}

/**
 * Переменные получателя: колонки загруженной базы плюс производные от имени,
 * чтобы в тексте работали привычные {{first_name}} и {{name}}.
 */
export function recipientVars(recipient: { email: string; name: string | null; vars: Record<string, string> }): Record<string, string> {
  const vars: Record<string, string> = { ...recipient.vars, email: recipient.email };
  const name = (recipient.name ?? '').trim();
  if (name) {
    vars.name ??= name;
    vars.first_name ??= name.split(/\s+/)[0] ?? '';
  }
  return vars;
}

/** Тема follow-up: пустая = продолжаем ту же переписку («Re: …»). */
export function followUpSubject(stepSubject: string, firstSubject: string): string {
  const subject = stepSubject.trim();
  if (subject) return subject;
  return /^re:/i.test(firstSubject) ? firstSubject : `Re: ${firstSubject}`;
}
