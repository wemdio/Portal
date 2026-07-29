/**
 * Читает структуру месячного листа отчёта «Отчетность продаж Polza Agency»
 * и возвращает адреса ячеек ФАКТ + временные окна для месяца и недель.
 *
 * Ничего не хардкодим — всё вытаскиваем из первых двух строк листа и
 * колонки B (название метрики). Так один и тот же код работает для любого
 * месяца без переписывания при добавлении новой метрики или сдвиге строк.
 */
import { getSheetsClient } from '@/lib/googleSheets/auth';

/** Метрики, которые скрипт умеет считать (см. lib/salesReport/metrics.ts). */
export type SalesReportMetricKey =
  | 'newLeadsMarketing'
  | 'qualMarketing'
  | 'newLeadsSmm'
  | 'qualSmm'
  | 'newLeadsOutreach'
  | 'qualOutreach'
  | 'newLeadsPartners'
  | 'qualPartners'
  | 'newLeadsTgOutreach'
  | 'qualTgOutreach'
  | 'meetings'
  | 'contracts'
  | 'invoicesSent'
  | 'paymentsReceived'
  | 'revenue';

/**
 * Соответствие текста в колонке B → нашей SalesReportMetricKey.
 * Регистр/пунктуация игнорируются, но проверяется префикс — так подхватываются
 * лёгкие правки в шаблоне вроде «шт», «руб» или лишних пробелов.
 */
const METRIC_LABEL_TO_KEY: Array<{ prefix: string; key: SalesReportMetricKey }> = [
  { prefix: 'новых лидов с маркетинга', key: 'newLeadsMarketing' },
  { prefix: 'квал маркетинг',           key: 'qualMarketing' },
  { prefix: 'новых лидов с smm',        key: 'newLeadsSmm' },
  { prefix: 'квал лидов с smm',         key: 'qualSmm' },
  { prefix: 'новых лидов с аутрича',    key: 'newLeadsOutreach' },
  { prefix: 'квал аутрич',              key: 'qualOutreach' },
  { prefix: 'новых лидов с партнерки',  key: 'newLeadsPartners' },
  { prefix: 'квал партнерка',           key: 'qualPartners' },
  { prefix: 'новых лидов с tg-аутрича', key: 'newLeadsTgOutreach' },
  { prefix: 'квал tg-аутрич',           key: 'qualTgOutreach' },
  { prefix: 'встреч',                   key: 'meetings' },
  { prefix: 'договоров',                key: 'contracts' },
  { prefix: 'счетов отправлено',        key: 'invoicesSent' },
  { prefix: 'оплат получено',           key: 'paymentsReceived' },
  { prefix: 'сумма оплат',              key: 'revenue' },
];

const normalize = (v: unknown): string =>
  String(v ?? '').trim().toLocaleLowerCase('ru-RU').replaceAll('ё', 'е');

function matchMetricKey(label: string): SalesReportMetricKey | null {
  const n = normalize(label);
  for (const { prefix, key } of METRIC_LABEL_TO_KEY) {
    if (n.startsWith(prefix)) return key;
  }
  return null;
}

const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Одно окно (месяц или неделя): [start, end) в UTC + номер колонки ФАКТ. */
export type FactColumn = {
  label: string;                  // 'МЕСЯЦ' | '[ I ] НЕДЕЛЯ' | ...
  factColumnIndex: number;        // 1-based (F=6, J=10, S=19, ...)
  start: Date;
  end: Date;
};

/** Позиция метрики в блоке (row в шите). */
export type MetricRow = {
  key: SalesReportMetricKey;
  row: number;                     // 1-based
};

/** Разобранная схема одного месячного листа. */
export type SheetSchema = {
  sheetName: string;
  factColumns: FactColumn[];       // порядок: МЕСЯЦ, [I], [II], ..., [V]
  totalsBlock: MetricRow[];        // ИТОГО ПО ОТДЕЛУ
};

/**
 * Разбирает имя листа «Июль 2026» и возвращает {year: 2026, month: 6}.
 * Нужно, чтобы правильно распарсить даты вида «01.07» (без года) в шапке —
 * год берётся из имени листа, а не гадаем.
 */
function parseSheetNameForContext(
  sheetName: string,
): { year: number; monthIndex: number } | null {
  const RU = [
    'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
  ];
  const m = sheetName.trim().match(/^(\S+)\s+(\d{4})$/);
  if (!m) return null;
  const lower = m[1].toLocaleLowerCase('ru-RU');
  const monthIndex = RU.findIndex((name) => name.startsWith(lower) || lower.startsWith(name));
  if (monthIndex < 0) return null;
  return { year: Number(m[2]), monthIndex };
}

/**
 * Парсит значение даты из шапки листа. Поддерживает:
 *  - Excel serial number (число дней с 1899-12-30) — если Google API вернул число;
 *  - строку «DD.MM.YYYY» — полный русский формат;
 *  - строку «DD.MM» (без года) — год берётся из ctx.year (обычно из имени листа);
 *  - ISO «YYYY-MM-DD» — на случай кастомного формата ячейки.
 *
 * Нативный `new Date(s)` намеренно НЕ используется как fallback: он слишком
 * либеральный и на короткие строки типа «01», «07» возвращает даты годов
 * 2001-2007 — из-за этого первый прогон salesReportCron посчитал июль
 * как несуществующие окна и записал 90 нулей.
 */
function parseSheetDate(
  v: unknown,
  ctx?: { year: number },
): Date | null {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v;
  if (typeof v === 'number' && Number.isFinite(v) && v > 25000 && v < 100000) {
    const EPOCH_MS = Date.UTC(1899, 11, 30);
    return new Date(EPOCH_MS + Math.round(v) * 86_400_000);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    const ruFull = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
    if (ruFull) {
      const day = Number(ruFull[1]);
      const month = Number(ruFull[2]);
      const year = Number(ruFull[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month - 1, day));
      }
    }
    const ruShort = /^(\d{1,2})\.(\d{1,2})$/.exec(s);
    if (ruShort && ctx) {
      const day = Number(ruShort[1]);
      const month = Number(ruShort[2]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return new Date(Date.UTC(ctx.year, month - 1, day));
      }
    }
    const iso = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s]|$)/.exec(s);
    if (iso) {
      const year = Number(iso[1]);
      const month = Number(iso[2]);
      const day = Number(iso[3]);
      if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        return new Date(Date.UTC(year, month - 1, day));
      }
    }
  }
  return null;
}

function mskMidnight(y: number, m: number, d: number): Date {
  // 00:00 МСК = 21:00 UTC предыдущего дня. Проще собрать через UTC минус смещение.
  return new Date(Date.UTC(y, m, d, 0, 0, 0) - MSK_OFFSET_MS);
}

function endOfDayMsk(y: number, m: number, d: number): Date {
  // Начало следующего дня 00:00 МСК (эксклюзивная граница).
  return mskMidnight(y, m, d + 1);
}

/**
 * Читает лист и возвращает схему.
 *
 * Логика:
 *  - Строка 1: маркеры блоков (МЕСЯЦ, [I] НЕДЕЛЯ, ...) в колонках E/I/R/AC/AN/AY;
 *    в остальных колонках блока — даты (только для недельных, для месяца дат нет).
 *  - Строка 2: 'ПЛАН'/'ФАКТ'/'%' — используем чтобы точно найти колонку ФАКТ.
 *  - Колонка B, строки 5..37 (примерно): имена метрик; матчим по нормализованному префиксу.
 *  - Границы недель: min/max дат из подписей заголовков (не из числа рабочих дней).
 *  - Границы месяца: min/max по всем датам всех недель.
 */
export async function loadSheetSchema(
  spreadsheetId: string,
  sheetName: string,
): Promise<SheetSchema> {
  const sheets = getSheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${sheetName}!A1:BF40`,
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  });
  const rows = (resp.data.values ?? []) as unknown[][];
  if (rows.length < 2) {
    throw new Error(`Sheet '${sheetName}': too few rows read`);
  }
  const r1 = rows[0] ?? [];
  const r2 = rows[1] ?? [];
  // Год берём из имени листа («Июль 2026» → 2026), нужен для парсинга дат
  // в шапке вида «01.07» без указания года. Если имя листа нестандартное —
  // fallback на текущий год (лучше чем 2001 из new Date("01.07")).
  const nameCtx = parseSheetNameForContext(sheetName);
  const parseCtx = { year: nameCtx?.year ?? new Date().getUTCFullYear() };

  // 1. Находим блоки: индекс колонки, содержащей 'МЕСЯЦ' или '[ N ] НЕДЕЛЯ'.
  type Block = { label: string; startCol: number };
  const blocks: Block[] = [];
  for (let c = 0; c < r1.length; c++) {
    const v = normalize(r1[c]);
    if (v === 'месяц' || /^\[\s*[ivx]+\s*\]\s*неделя$/i.test(String(r1[c] ?? ''))) {
      blocks.push({ label: String(r1[c]), startCol: c + 1 });
    }
  }
  if (blocks.length === 0) {
    throw new Error(`Sheet '${sheetName}': no МЕСЯЦ/НЕДЕЛЯ block markers in row 1`);
  }

  // 2. Для каждого блока: находим ФАКТ-колонку (r2 = 'ФАКТ') и собираем даты из r1.
  const factColumns: FactColumn[] = [];
  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi];
    const nextStart = bi + 1 < blocks.length ? blocks[bi + 1].startCol : r1.length + 1;

    let factCol = -1;
    for (let c = block.startCol; c < nextStart; c++) {
      if (normalize(r2[c - 1]) === 'факт') {
        factCol = c;
        break;
      }
    }
    if (factCol < 0) {
      throw new Error(`Sheet '${sheetName}': ФАКТ column not found in block ${block.label}`);
    }

    // Собираем даты для этого блока (в r1, между заголовком блока и следующим).
    const dates: Date[] = [];
    for (let c = block.startCol; c < nextStart; c++) {
      const d = parseSheetDate(r1[c - 1], parseCtx);
      if (d) dates.push(d);
    }

    let start: Date;
    let end: Date;
    if (dates.length > 0) {
      const min = dates.reduce((a, b) => (a < b ? a : b));
      const max = dates.reduce((a, b) => (a > b ? a : b));
      start = mskMidnight(min.getUTCFullYear(), min.getUTCMonth(), min.getUTCDate());
      end = endOfDayMsk(max.getUTCFullYear(), max.getUTCMonth(), max.getUTCDate());
    } else {
      // МЕСЯЦ: собираем даты из ВСЕХ остальных блоков (недельных).
      const allDates: Date[] = [];
      for (let c = 0; c < r1.length; c++) {
        const d = parseSheetDate(r1[c], parseCtx);
        if (d) allDates.push(d);
      }
      if (allDates.length === 0) {
        throw new Error(`Sheet '${sheetName}': month range cannot be resolved (no dates anywhere in row 1)`);
      }
      const min = allDates.reduce((a, b) => (a < b ? a : b));
      const max = allDates.reduce((a, b) => (a > b ? a : b));
      start = mskMidnight(min.getUTCFullYear(), min.getUTCMonth(), min.getUTCDate());
      end = endOfDayMsk(max.getUTCFullYear(), max.getUTCMonth(), max.getUTCDate());
    }

    factColumns.push({ label: block.label, factColumnIndex: factCol, start, end });
  }

  // 3. Строки метрик в блоке ИТОГО ПО ОТДЕЛУ (первые ~35 строк листа).
  const totalsBlock: MetricRow[] = [];
  for (let r = 4; r < rows.length; r++) {
    const label = rows[r]?.[1];
    if (label == null) continue;
    const key = matchMetricKey(String(label));
    if (key && !totalsBlock.find((x) => x.key === key)) {
      totalsBlock.push({ key, row: r + 1 }); // +1 → 1-based
    }
  }
  if (totalsBlock.length === 0) {
    throw new Error(`Sheet '${sheetName}': no known metrics found in column B`);
  }

  return { sheetName, factColumns, totalsBlock };
}

/** Название листа для месяца по MSK. Пример: (2026, 7) → 'Июль 2026'. */
export function monthlySheetName(mskDate: Date): string {
  const MONTHS_RU = [
    'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
  ];
  const nowMsk = new Date(mskDate.getTime() + MSK_OFFSET_MS);
  return `${MONTHS_RU[nowMsk.getUTCMonth()]} ${nowMsk.getUTCFullYear()}`;
}

export function columnIndexToLetter(index1: number): string {
  let n = index1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode('A'.charCodeAt(0) + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
