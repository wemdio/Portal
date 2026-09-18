import { randomUUID } from 'crypto';

/**
 * Подстановка {{var}} из полей получателя. Неизвестная переменная → пусто.
 * Кириллица в имени обязательна: колонка «Компания» из базы становится
 * переменной {{компания}}, и раньше такие подстановки молча выпадали.
 * Регистр не важен — ключи колонок хранятся в нижнем регистре.
 */
export function applyVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_а-яА-ЯёЁ]+)\s*\}\}/g, (_, key: string) => vars[key.toLowerCase()] ?? '');
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

/**
 * Message-ID делаем сами и сохраняем ДО отправки: по нему входящий ответ
 * связывается с письмом (заголовок In-Reply-To), а follow-up уходит в ту же
 * переписку. Домен берём от адреса отправителя — так заголовок не выглядит
 * чужеродным для почтовых фильтров.
 */
export function buildMessageId(fromEmail: string): string {
  const domain = fromEmail.split('@')[1] || 'localhost';
  return `<${randomUUID()}@${domain}>`;
}

/** Тема follow-up: пустая = продолжаем ту же переписку («Re: …»). */
export function followUpSubject(stepSubject: string, firstSubject: string): string {
  const subject = stepSubject.trim();
  if (subject) return subject;
  return /^re:/i.test(firstSubject) ? firstSubject : `Re: ${firstSubject}`;
}
