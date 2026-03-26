/** Сообщения для частичного завершения парсинга (лимит контактов / ошибка Telegram). */
export function formatParseStopMessage(stopReason?: string, detail?: string): string {
  if (stopReason === 'contact_limit') {
    return 'Остановлено: достигнут лимит «макс. контактов за запуск» для этого аккаунта (настройка в таблице аккаунтов). Экспортируйте CSV или Excel.';
  }
  if (stopReason === 'error') {
    return `Остановлено из-за ошибки; сохранён частичный результат. ${detail ?? ''}`.trim();
  }
  return 'Частичный результат — экспортируйте данные, если нужно.';
}
