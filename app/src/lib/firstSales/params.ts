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
  /**
   * Режим счёта, `cohort=0|1` в запросе, по умолчанию 1.
   *
   * true — «по когорте»: в период попадает всё, что в нём СЛУЧИЛОСЬ, в том
   * числе по сделкам, заведённым раньше (августовская сделка, оплаченная в
   * сентябре, — продажа и деньги сентября). Так дашборд считает с 25.09.2026.
   *
   * false — «без когорты»: продажи, встречи и деньги засчитываются только
   * сделкам, ЗАВЕДЁННЫМ в периоде. Лиды и квал от режима не зависят — они и
   * так считаются по дате создания. Просьба CEO от 26.09.2026, спека
   * docs/superpowers/specs/2026-09-26-first-sales-cohort-toggle-design.md.
   */
  cohort: boolean;
  /**
   * Период, по которому режим «без когорты» решает, заведена ли сделка «в
   * периоде». По умолчанию совпадает с from/to. Отдельно — ради клика по
   * столбцу графика: таблицы тогда сужаются до одного дня, а «заведена в
   * периоде» обязано по-прежнему значить выбранный период целиком. Иначе
   * сделка, заведённая 3 сентября и оплаченная 15-го, пропадала бы из
   * таблиц столбца 15 сентября, хотя в цифрах сентября она есть.
   * Параметры запроса `cohortFrom`/`cohortTo` (YYYY-MM-DD), только парой.
   */
  cohortFrom: Date;
  cohortTo: Date;
};

const MSK_DAY_START = (day: string) => new Date(new Date(`${day}T00:00:00.000Z`).getTime() - MSK_OFFSET_MS);
const MSK_DAY_END = (day: string) => new Date(new Date(`${day}T23:59:59.999Z`).getTime() - MSK_OFFSET_MS);

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

  // Строго 0 или 1: опечатка вида `cohort=false` молча дала бы режим по
  // умолчанию, и экран показал бы не те цифры, о которых просили.
  const cohortRaw = url.searchParams.get('cohort') ?? '1';
  if (cohortRaw !== '0' && cohortRaw !== '1') {
    return { value: null, error: `Недопустимый cohort: ${cohortRaw} (ожидается 0 или 1)` };
  }

  const cohortFromRaw = url.searchParams.get('cohortFrom');
  const cohortToRaw = url.searchParams.get('cohortTo');
  let cohortFrom = from;
  let cohortTo = to;
  if (cohortFromRaw !== null || cohortToRaw !== null) {
    if (!cohortFromRaw || !cohortToRaw || !isDate(cohortFromRaw) || !isDate(cohortToRaw)) {
      return { value: null, error: 'cohortFrom и cohortTo передаются парой в формате YYYY-MM-DD' };
    }
    cohortFrom = MSK_DAY_START(cohortFromRaw);
    cohortTo = MSK_DAY_END(cohortToRaw);
    if (cohortTo.getTime() < cohortFrom.getTime()) {
      return { value: null, error: 'Конец периода когорты раньше начала' };
    }
    if ((cohortTo.getTime() - cohortFrom.getTime()) / (24 * 60 * 60 * 1000) > MAX_RANGE_DAYS) {
      return { value: null, error: `Слишком длинный период когорты: максимум ${MAX_RANGE_DAYS} дней` };
    }
  }

  return {
    value: {
      from,
      to,
      groupBy: groupByRaw as GroupBy,
      sources: sourceRaw.length > 0 ? sourceRaw : null,
      cohort: cohortRaw === '1',
      cohortFrom,
      cohortTo,
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
