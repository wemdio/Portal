/** Колонки БД → подписи в ENG-кабинете. Имя провайдера наружу не тащим. */

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  return typeof value === 'string' ? value : String(value);
}

export function mailboxSendingView(row: object): { sendingStatus: string | null; sendingError: string | null } {
  const rec = row as Record<string, unknown>;
  return {
    sendingStatus: optionalText(rec.instantly_status),
    sendingError: optionalText(rec.instantly_error),
  };
}
