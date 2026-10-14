/**
 * Деньги на экранах аутричей. Без зависимостей — для клиентского кода: экран
 * запуска RU и EN пишет «ИИ: потрачено $X из $Y» одинаково.
 */

/** Доллары для строки расхода на ИИ: доли цента дешёвой модели не прячем в «$0.00». */
export function fmtUsd(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return '<$0.01';
  return `$${Number.isInteger(value) ? value : value.toFixed(2)}`;
}
