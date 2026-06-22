import { SIGNAL_ERROR_MARKER } from '@/lib/enrich/signalConstants';

export interface RemoveSignalErrorRowsResult {
  nextData: string[][];
  removed: number;
}

/**
 * Возвращает новый tabData без строк где в колонке `stackColIndex` стоит
 * маркер ошибки `⚠` (что бы ни было в Профиле — текст ошибки или пусто).
 *
 * Строка 0 (header) сохраняется всегда — даже если в её stack-ячейке
 * случайно оказался маркер. Чистая функция: не мутирует вход.
 *
 * Используется чекбоксом «удалить недоступные» в модалке сигналов:
 * клиентская пост-обработка после завершения signal-job'a.
 */
export function removeSignalErrorRows(
  tabData: string[][],
  stackColIndex: number,
): RemoveSignalErrorRowsResult {
  if (tabData.length === 0) return { nextData: [], removed: 0 };

  const header = tabData[0];
  const kept: string[][] = [header];
  let removed = 0;

  for (let i = 1; i < tabData.length; i += 1) {
    const row = tabData[i];
    const cell = String(row[stackColIndex] ?? '').trim();
    if (cell === SIGNAL_ERROR_MARKER) {
      removed += 1;
      continue;
    }
    kept.push(row);
  }

  return { nextData: kept, removed };
}
