import 'server-only';

/**
 * Заведение подключённого клиентского ящика у отправляющего провайдера.
 *
 * ЭТО ТОЧКА СХОЖДЕНИЯ ДВУХ ПУТЕЙ подключения почты:
 *  - клиент сам вводит свой ящик в кабинете (self-serve);
 *  - менеджер вводит ящики, которые студия завела клиенту под ключ на
 *    отдельных доменах (шаг «домены» в онбординге).
 * Оба заканчиваются одинаково: креды лежат зашифрованными в
 * client_mailbox_accounts, а отсюда ящик отдаётся провайдеру. Поэтому код
 * регистрации один, и второй путь не требует нового кода отправки.
 *
 * Клиенту имя провайдера не показывается нигде: в интерфейсе это «sending».
 */

import { createAccount, deleteAccount, testAccountVitals } from '@/lib/instantly/client';
import { resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { unsealMailboxSecret } from './credentials';
import { presetFor, type MailboxProvider } from './providers';

/**
 * provider_code у Instantly. 2 — обычный SMTP/IMAP, то есть путь с паролем
 * приложения. Именно он нам и нужен: OAuth-путь провайдера показал бы клиенту
 * их экран согласия, а этого делать нельзя.
 */
const PROVIDER_CODE_SMTP = 2;

export type MailboxRegistration =
  | { ok: true; alreadyRegistered: boolean }
  | { ok: false; error: string; permanent: boolean };

interface MailboxRow {
  id: string;
  email: string;
  display_name: string | null;
  provider: string;
  username: string;
  secret_encrypted: string;
  smtp_host: string;
  smtp_port: number;
  imap_host: string | null;
  imap_port: number | null;
  daily_limit: number;
}

/** «John Smith» из display_name или из локальной части адреса — провайдер требует оба поля. */
function splitName(row: MailboxRow): { first: string; last: string } {
  const source = (row.display_name || row.email.split('@')[0] || 'Outreach').trim();
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return {
    first: parts[0] ? parts[0].slice(0, 60) : 'Outreach',
    last: parts.length > 1 ? parts.slice(1).join(' ').slice(0, 60) : 'Team',
  };
}

/**
 * Отличить «пароль неверный / доступ закрыт» от временного сбоя.
 * Постоянную ошибку показываем клиенту и просим переподключить; временную
 * молча повторим позже, дёргать человека незачем.
 */
function isPermanent(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes('535') ||               // SMTP: bad credentials
    m.includes('authentication') ||
    m.includes('invalid login') ||
    m.includes('username and password') ||
    m.includes('already exists') ||
    m.includes('400') ||
    m.includes('422')
  );
}

/**
 * Завести ящик у провайдера. Идемпотентно: повторный вызов на уже заведённом
 * ящике не считается ошибкой (провайдер отвечает «already exists»).
 */
export async function registerMailboxForSending(
  row: MailboxRow,
  opts: { instantlyAccountId?: string | null } = {},
): Promise<MailboxRegistration> {
  let password: string | undefined;
  try {
    password = unsealMailboxSecret(row.secret_encrypted).smtpPassword;
  } catch {
    password = undefined;
  }
  if (!password) {
    return { ok: false, error: 'Учётные данные ящика не читаются, переподключите его', permanent: true };
  }

  // IMAP нужен провайдеру для детекта ответов и прогрева. Если клиент его не
  // указал, берём пресет его почтового сервиса, а в последнюю очередь выводим
  // из SMTP-хоста (smtp.example.com → imap.example.com) — иначе ящик заведётся
  // «слепым»: письма уходят, ответы не видны.
  const preset = presetFor(row.provider as MailboxProvider);
  const imapHost =
    row.imap_host || preset?.imapHost || row.smtp_host.replace(/^smtp\./i, 'imap.');
  const imapPort = row.imap_port || preset?.imapPort || 993;
  if (!imapHost) {
    return { ok: false, error: 'Не удалось определить IMAP-сервер для этого ящика', permanent: true };
  }

  const { first, last } = splitName(row);
  const requestOptions = { accountId: resolveInstantlyAccountId(opts.instantlyAccountId ?? null) };

  try {
    await createAccount(
      {
        email: row.email,
        first_name: first,
        last_name: last,
        provider_code: PROVIDER_CODE_SMTP,
        smtp_username: row.username || row.email,
        smtp_password: password,
        smtp_host: row.smtp_host,
        smtp_port: row.smtp_port,
        imap_username: row.username || row.email,
        imap_password: password,
        imap_host: imapHost,
        imap_port: imapPort,
        daily_limit: row.daily_limit,
      },
      requestOptions,
    );
    return { ok: true, alreadyRegistered: false };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Повторное подключение того же ящика — не ошибка, состояние уже нужное.
    if (message.toLowerCase().includes('already exists')) {
      return { ok: true, alreadyRegistered: true };
    }
    return { ok: false, error: message.slice(0, 400), permanent: isPermanent(message) };
  }
}

/** Снять ящик у провайдера. Ошибку «нет такого» считаем успехом — состояние нужное. */
export async function unregisterMailboxForSending(
  email: string,
  instantlyAccountId?: string | null,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await deleteAccount(email, { accountId: resolveInstantlyAccountId(instantlyAccountId ?? null) });
    return { ok: true };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (message.includes('404') || message.toLowerCase().includes('not found')) return { ok: true };
    return { ok: false, error: message.slice(0, 400) };
  }
}

/**
 * Проверка живости ящика у провайдера.
 *
 * Ради этого всё и затевалось отдельной ночной задачей: пароль приложения
 * Google отзывается при ЛЮБОЙ смене пароля пользователя, включая
 * принудительный сброс админом, и отправка встаёт молча. Без проверки клиент
 * узнаёт об этом по отсутствию ответов через неделю.
 */
export async function checkMailboxVitals(
  emails: string[],
  instantlyAccountId?: string | null,
): Promise<Map<string, { alive: boolean; detail: string }>> {
  const out = new Map<string, { alive: boolean; detail: string }>();
  if (emails.length === 0) return out;

  try {
    const res = await testAccountVitals(
      { emails },
      { accountId: resolveInstantlyAccountId(instantlyAccountId ?? null) },
    );
    const list = Array.isArray(res) ? res : (res as { items?: unknown[] })?.items ?? [];
    for (const raw of list as Array<Record<string, unknown>>) {
      const email = String(raw.email ?? '').toLowerCase();
      if (!email) continue;
      // У провайдера набор полей плавает между версиями: считаем живым только
      // явное подтверждение, всё остальное — повод показать предупреждение.
      const okFlag = raw.status === 'success' || raw.success === true || raw.vitals_status === 1;
      const detail = String(raw.error ?? raw.message ?? raw.status ?? (okFlag ? 'ok' : 'unknown')).slice(0, 300);
      out.set(email, { alive: Boolean(okFlag), detail });
    }
  } catch (e) {
    // Сбой самой проверки не должен помечать ящики мёртвыми: иначе блип
    // провайдера обернётся веером ложных писем «у вас всё сломалось».
    const message = e instanceof Error ? e.message : String(e);
    for (const email of emails) out.set(email.toLowerCase(), { alive: true, detail: `check failed: ${message.slice(0, 120)}` });
  }
  return out;
}
