import type { GroupBy } from '@/lib/firstSales/buckets';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 800;
const MAX_SOURCES = 100;

const GROUP_BYS: GroupBy[] = ['day', 'week', 'month'];

export type FirstSalesParams = {
  from: Date;
  to: Date;
  groupBy: GroupBy;
  sources: string[] | null;
};

/** Границы приходят как YYYY-MM-DD и трактуются как МСК-сутки целиком:
 *  from — 00:00:00.000 МСК, to — 23:59:59.999 МСК того же дня. Иначе
 *  «по 31 июля» отрежет последний день. */
export function parseFirstSalesParams(
  url: URL,
): { value: FirstSalesParams; error: null } | { value: null; error: string } {
  const fromRaw = url.searchParams.get('from');
  const toRaw = url.searchParams.get('to');
  if (!fromRaw || !toRaw) return { value: null, error: 'Нужны параметры from и to (YYYY-MM-DD)' };

  const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  if (!isDate(fromRaw) || !isDate(toRaw)) {
    return { value: null, error: 'from и to должны быть в формате YYYY-MM-DD' };
  }

  const from = new Date(new Date(`${fromRaw}T00:00:00.000Z`).getTime() - MSK_OFFSET_MS);
  const to = new Date(new Date(`${toRaw}T23:59:59.999Z`).getTime() - MSK_OFFSET_MS);
  if (to.getTime() < from.getTime()) {
    return { value: null, error: 'Конец периода раньше начала' };
  }
  const days = (to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000);
  if (days > MAX_RANGE_DAYS) {
    return { value: null, error: `Слишком длинный период: максимум ${MAX_RANGE_DAYS} дней` };
  }

  const groupByRaw = url.searchParams.get('groupBy') ?? 'day';
  if (!GROUP_BYS.includes(groupByRaw as GroupBy)) {
    return { value: null, error: `Недопустимый groupBy: ${groupByRaw}` };
  }

  // Список допустимых значений не проверяем: источники ведут продажи в AMO,
  // портал их перечня у себя не держит и не вправе объявить чужое значение
  // недопустимым. Ограничиваем только количество — защита от бесконечной
  // строки запроса.
  const sourceRaw = url.searchParams.getAll('source');
  if (sourceRaw.length > MAX_SOURCES) {
    return { value: null, error: `Слишком много источников в фильтре: максимум ${MAX_SOURCES}` };
  }

  return {
    value: {
      from,
      to,
      groupBy: groupByRaw as GroupBy,
      sources: sourceRaw.length > 0 ? sourceRaw : null,
    },
    error: null,
  };
}

/**
 * Предыдущее окно той же длины, вплотную к текущему, но БЕЗ пересечения.
 *
 * Конец прошлого окна — на миллисекунду раньше начала текущего. Иначе они
 * делят одну точку, а проверка попадания в окно (`inWindow` в metrics.ts)
 * включает обе границы — и сделка, случившаяся ровно в полночь по Москве,
 * посчиталась бы и в текущем периоде, и в прошлом. Полночь по Москве — ровно
 * та секунда, в которую такое и происходит, так что «маловероятно» тут не
 * аргумент.
 */
export function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  return {
    from: new Date(prevTo.getTime() - span),
    to: prevTo,
  };
}
