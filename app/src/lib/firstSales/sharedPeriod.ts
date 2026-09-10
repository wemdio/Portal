/**
 * Общий период дашбордов аналитики: первичка ↔ продления.
 *
 * Экраны смотрят на одни и те же продажи под разными углами, и ходят между
 * ними подряд — «посмотрел август в первичке, открыл продления». Сбрасывать
 * период на дефолтные 30 дней при каждом переходе значит заставлять человека
 * выставлять те же даты по второму разу.
 *
 * Лежит в firstSales/ рядом с `buckets.ts`, который продления уже импортируют
 * отсюда же: заводить третий модуль ради двух функций — лишняя сущность.
 *
 * Хранится в localStorage: период — вещь личная и сиюминутная, в БД ему делать
 * нечего, а query-параметров у этих страниц нет (см. страницы в app/analytics).
 * Любое обращение к хранилищу обёрнуто в try/catch: в приватном окне и при
 * запрете на данные сайта оно бросает исключение, и дашборд обязан открыться с
 * дефолтом, а не белым экраном.
 *
 * Группировка (день/неделя/месяц) и фильтр по каналам НЕ переносятся: наборы у
 * экранов разные, а «неделя» на одном не значит того же, что на другом.
 */
const STORAGE_KEY = 'portal:analytics:period';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type SharedPeriod = { from: string; to: string };

/** Сохранённый период или null, если его нет либо он испорчен. */
export function readSharedPeriod(): SharedPeriod | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SharedPeriod> | null;
    const from = parsed?.from;
    const to = parsed?.to;
    if (typeof from !== 'string' || typeof to !== 'string') return null;
    if (!ISO_DATE_RE.test(from) || !ISO_DATE_RE.test(to)) return null;
    if (from > to) return null;
    return { from, to };
  } catch {
    return null;
  }
}

export function writeSharedPeriod(period: SharedPeriod): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(period));
  } catch {
    /* приватное окно или запрет на данные сайта: период просто не переживёт переход */
  }
}
