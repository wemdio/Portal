/**
 * Прогрев: кто виноват в сорванной переписке.
 *
 * Переписка всегда парная, поэтому её провал раньше приписывался обоим
 * участникам: 2 сорванные переписки превращались в UI в «4 аккаунта не
 * подрубаются», хотя половина из них была просто собеседниками. Сообщение о
 * сбое знает виновника по имени — здесь мы это имя достаём.
 *
 * Возвращаем null, когда виновник не выделяется (сбой общий для пары или
 * причина старого формата): тогда вызывающий код показывает ошибку обоим,
 * как раньше.
 */

const NOT_CONNECTED = /^account_not_connected:\s*(.+)$/;
const SEND_FAILED = /^отправка не удалась \(([^)]+)\)/;

export function culpritNames(errorReason: string | null): string[] | null {
  if (!errorReason) return null;

  const notConnected = NOT_CONNECTED.exec(errorReason);
  if (notConnected) {
    const names = notConnected[1].split(',').map((s) => s.trim()).filter(Boolean);
    return names.length ? names : null;
  }

  const sendFailed = SEND_FAILED.exec(errorReason);
  if (sendFailed) return [sendFailed[1].trim()];

  return null;
}

/** Виноват ли конкретный аккаунт. Неизвестный виновник — виноваты оба. */
export function isCulprit(errorReason: string | null, sessionName: string | undefined): boolean {
  const names = culpritNames(errorReason);
  if (!names) return true;
  if (!sessionName) return false;
  return names.includes(sessionName);
}
