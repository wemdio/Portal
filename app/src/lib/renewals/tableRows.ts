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

/** Собирает `RenewalTableRow` из сырой строки БД и уже распарсенной даты
 *  оплаты. Общий хвост для `buildRenewalTableRows` и
 *  `buildUndatedRenewalTableRows` — обе строят одну и ту же форму строки,
 *  расходятся только в том, какие строки на вход пропускают. */
function toTableRow(row: RenewalProjectRow, paymentDate: string | null, todayKey: string): RenewalTableRow {
  return {
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
  };
}

/**
 * Строит список строк для таблицы дашборда продлений.
 *
 * Фильтрует по типу проекта, фильтру KPI и — если передано окно — по дате
 * оплаты. Период на дашборде управляет всей страницей целиком: таблица
 * показывает те же продления, что и плитки, а не свой отдельный срез. Две
 * выборки под одним фильтром гарантированно разошлись бы, и объяснять
 * расхождение пришлось бы в переписке.
 *
 * Цена решения: продление без даты оплаты в период не попадает ни при каком
 * выборе — привязать его ко времени не к чему. Такие строки из таблицы
 * выпадают, поэтому под ней стоит сноска с их количеством: пять продлений,
 * исчезнувших с экрана бесследно, — худший исход, чем строка пояснения.
 * Плитки «Запланировано» и «Без даты» остаются независимыми от периода
 * намеренно (см. RenewalsTotals в metrics.ts): они и служат указателем на то,
 * чего в таблице не видно.
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
  window: { fromKey: string; toKey: string } | null = null,
): RenewalTableRow[] {
  const result: RenewalTableRow[] = [];

  for (const row of rows) {
    if (!isRenewalType(row.project_type)) continue;
    if (!passesKpiFilter(row.kpi_fact, kpiFilter)) continue;

    const paymentDate = parseIsoDateKey(row.payment_date);

    // Период фильтрует и таблицу тоже — она показывает те же продления, что
    // и плитки, а не свой отдельный срез. Продление без даты оплаты в период
    // попасть не может ни при каком выборе: его не к чему привязать. Такие
    // строки выпадают, и именно поэтому под таблицей стоит сноска с их
    // числом — иначе пять продлений исчезли бы с экрана бесследно.
    if (window !== null) {
      if (paymentDate === null) continue;
      if (paymentDate < window.fromKey || paymentDate > window.toKey) continue;
    }

    result.push(toTableRow(row, paymentDate, todayKey));
  }

  // Свежие сверху; без даты — в конец. Не «раньше всех», а «неизвестно
  // когда» — конец списка честнее любой позиции среди датированных строк.
  //
  // Это ещё и порядок по умолчанию для сортировки таблицы на дашборде
  // (см. RenewalsRowsTable.tsx): клик по заголовку сортирует по возрастанию/
  // убыванию, третий клик сбрасывает к порядку, который вернула эта функция,
  // — то есть к нему.
  result.sort((a, b) => {
    if (a.paymentDate === null && b.paymentDate === null) return 0;
    if (a.paymentDate === null) return 1;
    if (b.paymentDate === null) return -1;
    if (a.paymentDate === b.paymentDate) return 0;
    return a.paymentDate > b.paymentDate ? -1 : 1;
  });

  return result;
}

/**
 * Строки продлений без распознанной даты оплаты — те самые, что
 * `buildRenewalTableRows` отсеивает, когда передано `window`: без даты
 * привязать продление к периоду не к чему, поэтому период на них не
 * распространяется вовсе (нет параметра окна в этой функции). Фильтр KPI
 * распространяется — это не про время, а про то, какие продления вообще
 * интересны пользователю, и должен работать одинаково в обеих выборках.
 *
 * Отдельная функция, а не флаг у `buildRenewalTableRows`: у флага разное
 * поведение (в одном случае строки, у которых ЕСТЬ дата, в другом — только
 * без даты) означало бы либо union-тип результата, либо два необязательных
 * параметра «дайте мне только с датой / только без» — отдельная функция
 * читается яснее вызывающим кодом (route.ts зовёт обе по имени) и не трогает
 * существующую сигнатуру `buildRenewalTableRows`, которую уже вызывает роут.
 */
export function buildUndatedRenewalTableRows(
  rows: RenewalProjectRow[],
  kpiFilter: KpiFilter | null,
  todayKey: string,
): RenewalTableRow[] {
  const result: RenewalTableRow[] = [];

  for (const row of rows) {
    if (!isRenewalType(row.project_type)) continue;
    if (!passesKpiFilter(row.kpi_fact, kpiFilter)) continue;

    const paymentDate = parseIsoDateKey(row.payment_date);
    if (paymentDate !== null) continue; // это блок именно без даты

    result.push(toTableRow(row, paymentDate, todayKey));
  }

  return result;
}
