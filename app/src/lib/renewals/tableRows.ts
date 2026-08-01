import type { KpiFilter, RenewalProjectRow } from '@/lib/renewals/metrics';

/**
 * Строка таблицы продлений на дашборде.
 *
 * В отличие от `RenewalsTotals` из metrics.ts, таблица не срезана диапазоном
 * дат — это осознанный выбор (см. buildRenewalTableRows ниже), поэтому у
 * строки нет понятия «попала в период». `paymentDate` — либо провалидированный
 * `YYYY-MM-DD`, либо `null` (пусто или не распарсилось); `isPlanned` — дата
 * есть и она позже `todayKey`. И то и другое видно в таблице напрямую, а не
 * прячется молча, как того требует план дашборда («Проекты без даты —
 * отдельной строкой, не прячем»).
 */
export type RenewalTableRow = {
  id: string;
  client: string | null;
  name: string | null;
  budget: number | null;
  budgetRaw: string | null;
  paymentDate: string | null;
  isPlanned: boolean;
  contractDate: string | null;
  kpiFact: number | null;
  kpiFactRaw: string | null;
  status: string | null;
  manager: string | null;
};

// --- Разбор значений ---------------------------------------------------
//
// Три функции ниже (`isRenewalType`, `parseIsoDateKey`, `parseAmount`)
// побайтово повторяют одноимённую приватную логику `metrics.ts`
// (`isRenewalType`, `parseIsoDate` + сравнение строк, `parseAmount`). Задача
// прямо запрещает менять metrics.ts, а нужный список строк для таблицы там
// не экспортируется — только агрегаты. Дублирование — компромисс с открытыми
// глазами: если правила разбора в metrics.ts изменятся, эту копию придётся
// поправить вручную, тесты `tableRows.test.ts` синхронизацию не гарантируют
// сами по себе. Более надёжное решение — экспортировать эти хелперы из
// metrics.ts, но это правка запрещённого файла, пусть и безопасная.

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NUMERIC_RE = /^\d+(?:[  ]\d+)*(?:[.,]\d+)?$/;

function isRenewalType(projectType: string | null): boolean {
  if (typeof projectType !== 'string') return false;
  return projectType.trim().toLowerCase() === 'продление';
}

/** Строгий разбор `YYYY-MM-DD`, вернёт саму строку (обрезанную) при успехе,
 *  иначе `null`. В отличие от `metrics.ts` не строит `Date` — здесь только
 *  сравнение строк для сортировки/поиска «план vs факт», для чего валидного
 *  ISO-ключа достаточно. */
function parseIsoDateKey(raw: string | null): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  const match = ISO_DATE_RE.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) {
    return null;
  }
  return trimmed;
}

function parseAmount(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!NUMERIC_RE.test(trimmed)) return null;
  const normalized = trimmed.replace(/[  ]/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function passesKpiFilter(kpiFact: string | null, filter: KpiFilter | null): boolean {
  if (!filter) return true;
  const value = parseAmount(kpiFact);
  if (value === null) return false;
  if (filter.min !== undefined && value < filter.min) return false;
  if (filter.max !== undefined && value > filter.max) return false;
  return true;
}

/**
 * Строит список строк для таблицы дашборда продлений.
 *
 * Намеренно НЕ фильтрует по диапазону дат (`from`/`to`) — только по типу
 * проекта и фильтру KPI. Диапазон дат на дашборде управляет периодом для
 * KPI-плиток и графика (обороту какого периода верить), а не тем, что видно
 * в таблице: иначе продления без даты оплаты или с датой в будущем пришлось
 * бы либо выкидывать из таблицы независимо от периода, либо городить для них
 * отдельный обходной путь показа. Плитки «Запланировано» и «Без даты» тоже
 * не зависят от периода по той же причине (см. комментарии в
 * RenewalsTotals в metrics.ts) — таблица просто делает то же самое видимым
 * построчно.
 *
 * `todayKey` — дата «сегодня» в формате ключа `bucketKey(_, 'day')`
 * (`YYYY-MM-DD` в МСК), передаётся параметром, а не берётся из `Date.now()`
 * внутри — тот же приём, что и в `computeRenewalsMetrics`, ради
 * тестируемости без зависимости от дня запуска.
 */
export function buildRenewalTableRows(
  rows: RenewalProjectRow[],
  kpiFilter: KpiFilter | null,
  todayKey: string,
): RenewalTableRow[] {
  const result: RenewalTableRow[] = [];

  for (const row of rows) {
    if (!isRenewalType(row.project_type)) continue;
    if (!passesKpiFilter(row.kpi_fact, kpiFilter)) continue;

    const paymentDate = parseIsoDateKey(row.payment_date);

    result.push({
      id: row.id,
      client: row.client,
      name: row.name,
      budget: parseAmount(row.budget),
      budgetRaw: row.budget,
      paymentDate,
      isPlanned: paymentDate !== null && paymentDate > todayKey,
      contractDate: parseIsoDateKey(row.contract_date),
      kpiFact: parseAmount(row.kpi_fact),
      kpiFactRaw: row.kpi_fact,
      status: row.status,
      manager: row.manager,
    });
  }

  // Свежие сверху; без даты — в конец. Не «раньше всех», а «неизвестно
  // когда» — конец списка честнее любой позиции среди датированных строк.
  result.sort((a, b) => {
    if (a.paymentDate === null && b.paymentDate === null) return 0;
    if (a.paymentDate === null) return 1;
    if (b.paymentDate === null) return -1;
    if (a.paymentDate === b.paymentDate) return 0;
    return a.paymentDate > b.paymentDate ? -1 : 1;
  });

  return result;
}
