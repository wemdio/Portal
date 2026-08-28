/**
 * Метрики дашборда продлений.
 *
 * Модуль считает метрики, но НЕ ходит в БД: строки ему приносит источник —
 * `amoRenewals.ts`, воронка AMO «Вторичные (и не только) продажи». До
 * 28.08.2026 источником были строки `projects` с `project_type = 'Продление'`,
 * отсюда и имя типа `RenewalProjectRow` — форма строки при переезде не
 * менялась специально, чтобы расчёт и UI остались нетронутыми.
 *
 * Ключевые поля (`budget`, `payment_date`, `contract_date`, `kpi_fact`)
 * приходят строками и заполняются людьми руками, поэтому парсинг везде
 * защитный и никогда не проглатывает мусор молча — см. счётчики
 * `withoutDate`/`withoutBudget` и разбор `parseAmount`.
 *
 * Стиль и границы — по образцу `firstSales/metrics.ts`:
 *   1. Чистая функция `computeRenewalsMetrics` + отдельные функции выборки.
 *   2. «Сегодня» приходит параметром, а не берётся из `Date.now()` — иначе
 *      тест зависит от дня запуска.
 *   3. Недостоверная метрика — явный флаг (`cycleReliable`), а не тихий ноль.
 *   4. Группировка по датам — только через `bucketKey`/`buildBuckets` из
 *      `firstSales/buckets.ts`: границы МСК там уже решены, копировать нельзя
 *      — вторая реализация разъедется с первой, и два дашборда начнут
 *      показывать разные месяцы.
 */
import { bucketKey, buildBuckets, type GroupBy } from '@/lib/firstSales/buckets';

export type RenewalProjectRow = {
  id: string;
  name: string | null;
  client: string | null;
  project_type: string | null;
  budget: string | null;
  payment_date: string | null;
  contract_date: string | null;
  kpi_fact: string | null;
  status: string | null;
  manager: string | null;
  specialist: string | null;
};

export type ProjectPeriodRow = {
  project_id: string;
  period_start: string | null;
  period_end: string | null;
};

export type RenewalSeriesBucket = {
  key: string;
  count: number;
  revenue: number;
};

/** Числовой диапазон для фильтра по KPI-факту. Оба края необязательны. */
export type KpiFilter = {
  min?: number;
  max?: number;
};

export type RenewalsTotals = {
  /** Продлений с датой оплаты в [from, to] и не позже «сегодня». */
  count: number;
  /** Сумма `budget` по тем же продлениям, у кого бюджет распарсился. */
  revenue: number;
  avgCheck: number | null;
  medianCheck: number | null;
  /** Продления с датой оплаты позже «сегодня» — план, не факт. Не завязано
   *  на [from, to]: это сквозная цифра «сколько ждём», а не метрика периода. */
  planned: number;
  /** Продления без парсящейся даты оплаты (пусто или не `YYYY-MM-DD`).
   *  Тоже сквозная цифра — без даты нельзя понять, попадает ли строка в
   *  выбранный период вовсе, поэтому не молчим, а считаем отдельно. */
  withoutDate: number;
  /** Из `count` — те, у кого `budget` не распарсился. Не входят в `revenue`
   *  и в выборку для среднего/медианы, но и не выброшены — видны отдельно. */
  withoutBudget: number;
  cycleAvgDays: number | null;
  cycleMedianDays: number | null;
  /**
   * false — цикл удалось посчитать меньше чем у трети продлений периода
   * (`count`). История периодов (`project_periods`) есть всего у 11 проектов
   * из 139 в базе, так что у большинства продлений её просто нет — ноль или
   * среднее по паре точек здесь читалось бы как факт, хотя было бы почти
   * всегда основано на 1-2 сделках. UI обязан показать прочерк.
   */
  cycleReliable: boolean;
  /** Сколько продлений из `count` реально дали цикл (числитель порога). */
  cycleSampleSize: number;
  /** Знаменатель порога — он же `count`, продублирован для удобства UI. */
  cycleCandidates: number;
};

export type RenewalsResult = {
  series: RenewalSeriesBucket[];
  totals: RenewalsTotals;
};

/** Доля продлений периода, у которых обязан посчитаться цикл, чтобы считать
 *  `cycleAvgDays`/`cycleMedianDays` достоверными. Навскidку взята 1/3 — при
 *  текущей полноте `project_periods` (11 проектов из 139) флаг почти всегда
 *  будет `false`, и это осознанно: лучше стабильный прочерк, чем метрика,
 *  посчитанная по одной-двум сделкам и выданная за факт. */
export const CYCLE_RELIABLE_MIN_SHARE = 1 / 3;

const DAY_MS = 24 * 60 * 60 * 1000;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Строгий разбор `YYYY-MM-DD` в UTC-полночь того дня. Возвращает `null` для
 *  всего, что не в этом формате, включая календарно невозможные даты
 *  (`2026-02-30`) — `Date` их не отвергает молча, а перекатывает на март,
 *  поэтому дату сверяем покомпонентно после конструирования. */
function parseIsoDate(raw: string | null): Date | null {
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
  return date;
}

/**
 * Защитный разбор числа из текстового поля (`budget`, `kpi_fact`).
 *
 * `parseFloat('120к')` вернёт 120 и не скажет ни слова — ровно так метрика
 * однажды покажет оборот в тысячу раз меньше настоящего. Поэтому сначала
 * строка целиком сверяется регуляркой (допустимы пробелы/неразрывные пробелы
 * как разделители разрядов и `,`/`.` как разделитель дробной части) и только
 * потом преобразуется. Всё, что не прошло проверку целиком, — `null`.
 */
const NUMERIC_RE = /^\d+(?:[  ]\d+)*(?:[.,]\d+)?$/;

function parseAmount(raw: string | null): number | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!NUMERIC_RE.test(trimmed)) return null;
  const normalized = trimmed.replace(/[  ]/g, '').replace(',', '.');
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function isRenewalType(projectType: string | null): boolean {
  if (typeof projectType !== 'string') return false;
  return projectType.trim().toLowerCase() === 'продление';
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function passesKpiFilter(kpiFact: string | null, filter: KpiFilter | null): boolean {
  if (!filter) return true;
  const value = parseAmount(kpiFact);
  // Непарсящийся kpi_fact «не подпадает» под заданный диапазон — исключаем,
  // как и значение вне границ. Но только когда фильтр реально задан: если
  // filter === null, ни одна строка из-за kpi_fact не выкидывается вовсе.
  if (value === null) return false;
  if (filter.min !== undefined && value < filter.min) return false;
  if (filter.max !== undefined && value > filter.max) return false;
  return true;
}

/**
 * Считает метрики продлений за окно `[from, to]`.
 *
 * `rows` — ВСЕ продления (без окна по дате оплаты на уровне выборки из БД):
 * фильтрация по датам, включая «без даты» и «план», происходит здесь, чтобы
 * ни одна строка не терялась молча на уровне SQL. `periods` — история
 * `project_periods` для тех же проектов, нужна только для расчёта цикла.
 */
export function computeRenewalsMetrics(
  rows: RenewalProjectRow[],
  periods: ProjectPeriodRow[],
  from: Date,
  to: Date,
  groupBy: GroupBy,
  kpiFilter: KpiFilter | null,
  today: Date,
): RenewalsResult {
  const fromKey = bucketKey(from, 'day');
  const toKey = bucketKey(to, 'day');
  const todayKey = bucketKey(today, 'day');

  const keys = buildBuckets(from, to, groupBy);
  const series = new Map<string, RenewalSeriesBucket>(
    keys.map((key) => [key, { key, count: 0, revenue: 0 }]),
  );

  const totals: RenewalsTotals = {
    count: 0,
    revenue: 0,
    avgCheck: null,
    medianCheck: null,
    planned: 0,
    withoutDate: 0,
    withoutBudget: 0,
    cycleAvgDays: null,
    cycleMedianDays: null,
    cycleReliable: false,
    cycleSampleSize: 0,
    cycleCandidates: 0,
  };

  // Карта project_id -> отсортированные по возрастанию UTC-полночи period_end
  // (только те, что распарсились). Нужна, чтобы для каждого продления найти
  // «последний предыдущий период» без O(n*m) пересканирования periods целиком
  // на каждой строке.
  const periodEndsByProject = new Map<string, number[]>();
  for (const p of periods) {
    const end = parseIsoDate(p.period_end);
    if (!end) continue;
    const list = periodEndsByProject.get(p.project_id);
    if (list) {
      list.push(end.getTime());
    } else {
      periodEndsByProject.set(p.project_id, [end.getTime()]);
    }
  }
  for (const list of periodEndsByProject.values()) list.sort((a, b) => a - b);

  /** Последний period_end проекта, не позже contractTime. `null`, если истории
   *  нет или все известные периоды закончились уже после даты договора. */
  function lastPeriodEndBefore(projectId: string, contractTime: number): number | null {
    const list = periodEndsByProject.get(projectId);
    if (!list) return null;
    let best: number | null = null;
    for (const end of list) {
      if (end <= contractTime) best = end; // list отсортирован по возрастанию — берём последний подходящий
    }
    return best;
  }

  const checks: number[] = [];
  const cycles: number[] = [];

  for (const row of rows) {
    if (!isRenewalType(row.project_type)) continue;
    if (!passesKpiFilter(row.kpi_fact, kpiFilter)) continue;

    const paymentTrimmed = row.payment_date == null ? null : row.payment_date.trim();
    const paymentDate = parseIsoDate(row.payment_date);
    if (!paymentDate || !paymentTrimmed) {
      totals.withoutDate += 1;
      continue;
    }

    // Строка уже валидна как YYYY-MM-DD (parseIsoDate вернул дату), так что
    // сравнение строк ниже эквивалентно сравнению дат — и не требует лишнего
    // сдвига в МСК: UTC-полночь + 3 часа никогда не пересекает границу дня.
    if (paymentTrimmed > todayKey) {
      totals.planned += 1;
      continue;
    }

    if (paymentTrimmed < fromKey || paymentTrimmed > toKey) continue; // вне выбранного периода — не считаем нигде, как в firstSales

    totals.count += 1;
    const bucket = series.get(bucketKey(paymentDate, groupBy));
    if (bucket) bucket.count += 1;

    const amount = parseAmount(row.budget);
    if (amount === null) {
      totals.withoutBudget += 1;
    } else {
      totals.revenue += amount;
      checks.push(amount);
      if (bucket) bucket.revenue += amount;
    }

    // Цикл — от period_end последнего предыдущего периода ДО contract_date
    // этого продления. Нет даты договора или истории периодов — сделка
    // просто не попадает в cycles; это не ошибка, а ожидаемая тонкость.
    const contractDate = parseIsoDate(row.contract_date);
    if (contractDate) {
      const prevEnd = lastPeriodEndBefore(row.id, contractDate.getTime());
      if (prevEnd !== null) {
        const days = (contractDate.getTime() - prevEnd) / DAY_MS;
        if (Number.isFinite(days) && days >= 0) cycles.push(days);
      }
    }
  }

  totals.avgCheck = checks.length > 0 ? checks.reduce((a, b) => a + b, 0) / checks.length : null;
  totals.medianCheck = median(checks);

  totals.cycleCandidates = totals.count;
  totals.cycleSampleSize = cycles.length;
  totals.cycleReliable =
    totals.count > 0 && cycles.length / totals.count >= CYCLE_RELIABLE_MIN_SHARE;
  if (totals.cycleReliable) {
    totals.cycleAvgDays = cycles.reduce((a, b) => a + b, 0) / cycles.length;
    totals.cycleMedianDays = median(cycles);
  }

  return {
    series: keys.map((k) => series.get(k) as RenewalSeriesBucket),
    totals,
  };
}
