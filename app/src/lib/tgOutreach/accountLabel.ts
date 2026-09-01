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
