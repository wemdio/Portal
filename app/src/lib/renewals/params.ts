import type { GroupBy } from '@/lib/firstSales/buckets';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Верхняя граница диапазона — щедрая, но конечная (защита от опечатки в
 * query-параметрах, а не бизнес-ограничение). Источник теперь —
 * `renewal_marks`/`bank_transactions`, а не 32 строки `projects`, но объём
 * всё равно остаётся многие годы дешёвым: `fetchRevenueTransactions` и
 * `fetchRenewalMarks` в `metrics.ts` в любом случае тянут историю целиком —
 * это ограничение только на ширину показанного окна `[from, to]`.
 */
const MAX_RANGE_DAYS = 1500;

const GROUP_BYS: GroupBy[] = ['day', 'week', 'month'];

export type RenewalsParams = {
  from: Date;
  to: Date;
  groupBy: GroupBy;
};

/**
 * Границы приходят как YYYY-MM-DD и трактуются как МСК-сутки целиком: from —
 * 00:00:00.000 МСК, to — 23:59:59.999 МСК того же дня.
 *
 * Логика этого блока намеренно ПОВТОРЯЕТ firstSales/params.ts, а не
 * импортирует его — см. исходное обоснование в истории файла: заводить у двух
 * дашбордов общую точку разбора дат ради восьми строк арифметики значит
 * незаметно связать их.
 *
 * Фильтра по KPI-факту здесь больше нет: он был про `projects.kpi_fact`,
 * которого в новой выборке (renewal_marks + bank_transactions) не существует
 * — оставлять параметр без действия значило бы держать нерабочий рычаг в UI.
 */
export function parseRenewalsParams(
  url: URL,
): { value: RenewalsParams; error: null } | { value: null; error: string } {
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

  const groupByRaw = url.searchParams.get('groupBy') ?? 'month';
  if (!GROUP_BYS.includes(groupByRaw as GroupBy)) {
    return { value: null, error: `Недопустимый groupBy: ${groupByRaw}` };
  }

  return {
    value: { from, to, groupBy: groupByRaw as GroupBy },
    error: null,
  };
}
