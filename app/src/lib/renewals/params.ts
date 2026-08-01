import type { GroupBy } from '@/lib/firstSales/buckets';
import type { KpiFilter } from '@/lib/renewals/metrics';

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Верхняя граница диапазона — сильно щедрее, чем 800 дней у firstSales/params.ts.
 * Там лимит защищает от тяжёлого запроса по десяткам тысяч лидов AMO; здесь
 * весь источник — `projects` с `project_type = 'Продление'`, это 32 строки на
 * 2026-07-31, и запрос остаётся дешёвым при любом разумном диапазоне. Запас
 * нужен, чтобы дефолт «вся история» (см. getDefaultFilters в
 * components/renewals/FiltersBar.tsx) не упирался в лимит по мере роста
 * данных на годы вперёд, но лимит всё равно остаётся конечным — это защита от
 * опечатки в query-параметрах, а не бизнес-ограничение.
 */
const MAX_RANGE_DAYS = 1500;

const GROUP_BYS: GroupBy[] = ['day', 'week', 'month'];

export type RenewalsParams = {
  from: Date;
  to: Date;
  groupBy: GroupBy;
  kpiFilter: KpiFilter | null;
};

/**
 * Границы приходят как YYYY-MM-DD и трактуются как МСК-сутки целиком: from —
 * 00:00:00.000 МСК, to — 23:59:59.999 МСК того же дня.
 *
 * Логика этого блока намеренно ПОВТОРЯЕТ firstSales/params.ts, а не
 * импортирует его: там она не вынесена в отдельную переиспользуемую функцию
 * (только в `parseFirstSalesParams` целиком, вместе с разбором `channel`,
 * которого здесь нет), а заводить у двух дашбордов общую точку разбора дат
 * ради восьми строк арифметики — значит незаметно связать их: правка формата
 * границ под нужды каналов первички могла бы задеть продления и наоборот.
 * Сама арифметика (сдвиг на MSK_OFFSET_MS, границы суток) должна остаться
 * идентичной — это сверено вручную построчно с оригиналом.
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

  const kpiMinRaw = url.searchParams.get('kpiMin');
  const kpiMaxRaw = url.searchParams.get('kpiMax');
  const min = kpiMinRaw !== null && kpiMinRaw !== '' ? Number(kpiMinRaw) : undefined;
  const max = kpiMaxRaw !== null && kpiMaxRaw !== '' ? Number(kpiMaxRaw) : undefined;
  if (min !== undefined && !Number.isFinite(min)) return { value: null, error: 'kpiMin должен быть числом' };
  if (max !== undefined && !Number.isFinite(max)) return { value: null, error: 'kpiMax должен быть числом' };

  const kpiFilter: KpiFilter | null =
    min !== undefined || max !== undefined
      ? { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) }
      : null;

  return {
    value: { from, to, groupBy: groupByRaw as GroupBy, kpiFilter },
    error: null,
  };
}
