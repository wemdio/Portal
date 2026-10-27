/**
 * Как называть наш аккаунт на экране.
 *
 * У аккаунта три имени, и они про разное. `session_name` — техническое имя
 * файла сессии, оно есть всегда, но собеседник его никогда не видел.
 * `tg_username` и `first_name` — то, под чем аккаунт представляется в
 * Telegram: именно их оператор ищет глазами, когда сверяет переписку с
 * телефоном в руках.
 *
 * Поэтому порядок такой: ник, потом имя, и только если Telegram про аккаунт
 * ещё ничего не рассказал (личность заполняется при первом заходе) — техническое
 * имя сессии. Одна функция на весь экран: в списке диалогов и в самих
 * сообщениях аккаунт обязан называться одинаково, иначе строка «ведёт
 * @polza_anna» и подпись «atol_7:» читаются как два разных собеседника.
 */

export interface LabeledAccount {
  session_name: string;
  tg_username?: string | null;
  first_name?: string;
}

export function accountLabel(account: LabeledAccount | null | undefined): string | null {
  if (!account) return null;
  const username = account.tg_username?.trim();
  if (username) return `@${username.replace(/^@/, '')}`;
  const firstName = account.first_name?.trim();
  if (firstName) return firstName;
  return account.session_name || null;
}

/**
 * Как подписывать наш аккаунт в журнале работы кампании.
 *
 * Техническое имя сессии остаётся первым: журнал отдельного аккаунта и счётчики
 * ошибок отбирают строки по нему (accounts/[id]/logs, error-counts,
 * dashboard), без него строка пропадёт из карточки. Но у залитых tdata это
 * просто число, и оператор по нему аккаунт не узнаёт — 27.10.2026 попросили
 * «номер и ФИО». Поэтому в скобках телефон и имя с фамилией из Telegram;
 * телефон не повторяем, если имя сессии им и является, а пока первая проверка
 * его не принесла — пишем что есть.
 */
export interface LoggedAccount {
  session_name: string;
  phone?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

export function accountLogName(account: LoggedAccount): string {
  const phoneDigits = (account.phone ?? '').replace(/\D/g, '');
  const sessionDigits = account.session_name.replace(/\D/g, '');
  const phone = phoneDigits && phoneDigits !== sessionDigits ? `+${phoneDigits}` : '';
  const fullName = [account.first_name, account.last_name]
    .map((part) => (part ?? '').trim())
    .filter(Boolean)
    .join(' ');
  const details = [phone, fullName].filter(Boolean).join(', ');
  return details ? `${account.session_name} (${details})` : account.session_name;
}
