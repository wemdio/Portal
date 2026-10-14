/**
 * Колонки БД → подписи в ENG-кабинете. Имя провайдера наружу не тащим.
 *
 * Теперь нейтральные имена приходят уже из ответа: `GET /api/client/mailboxes`
 * отдаёт строку не как есть, а проекцией — `sendingStatus`/`sendingError`
 * вместо `instantly_*`, и текст ошибки там уже константа, а не ответ
 * провайдера. Поэтому сначала читаем нейтральные поля и лишь потом падаем на
 * старые имена.
 *
 * Фолбэк оставлен намеренно: экран зовёт хелпер как `{ ...row,
 * ...mailboxSendingView(row) }`, то есть его результат ПЕРЕКРЫВАЕТ уже готовые
 * поля ответа. Без чтения нейтральных имён хелпер затирал бы их обоими `null`,
 * и кабинет терял бы и бейдж готовности, и строку ошибки. Когда потребители
 * перейдут на поля ответа напрямую, файл уходит целиком.
 */

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'string' ? value : String(value);
}

export function mailboxSendingView(row: object): { sendingStatus: string | null; sendingError: string | null } {
  const rec = row as Record<string, unknown>;
  return {
    sendingStatus: optionalText(rec.sendingStatus ?? rec.instantly_status),
    sendingError: optionalText(rec.sendingError ?? rec.instantly_error),
  };
}
