/**
 * Подписи к задаче парсинга в списке.
 *
 * Вынесено из страницы: обход трёх чатов идёт до сорока минут, и обе подписи —
 * «когда запустили» и «сколько уже идёт» — это то, по чему оператор решает,
 * ждать дальше или вмешиваться. Ошибка в них тихая, поэтому под тестами.
 */

/** «12.08, 10:19» — дата и время запуска. */
export function formatJobStart(ts: number): string {
  if (!Number.isFinite(ts)) return '';
  return new Date(ts).toLocaleString('ru-RU', {
    day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Сколько задача уже идёт: «меньше минуты» → «7 мин» → «1 ч 5 мин».
 *
 * `now` параметром, а не `Date.now()` внутри: вызов часов во время рендера
 * нечист, да и точка отсчёта честнее — момент последнего опроса.
 */
export function formatElapsed(fromTs: number, now: number): string {
  if (!Number.isFinite(fromTs) || !Number.isFinite(now)) return '';
  const min = Math.max(0, Math.floor((now - fromTs) / 60_000));
  if (min < 1) return 'меньше минуты';
  if (min < 60) return `${min} мин`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest === 0 ? `${h} ч` : `${h} ч ${rest} мин`;
}
