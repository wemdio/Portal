/** Колонки БД → подписи в ENG-кабинете. Имя провайдера наружу не тащим. */

export function mailboxSendingView(row: {
  instantly_status?: string | null;
  instantly_error?: string | null;
}): { sendingStatus: string | null; sendingError: string | null } {
  return {
    sendingStatus: row.instantly_status ?? null,
    sendingError: row.instantly_error ?? null,
  };
}
