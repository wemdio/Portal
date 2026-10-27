/**
 * XLSX отчёта по кампании в форме, приложенной к договору: по листу на раздел.
 *
 * Цифры не считает — раскладывает готовый `CampaignReport` (см. report.ts),
 * поэтому файл по сохранённому отчёту выходит таким же, каким был при сборке.
 */
import ExcelJS from 'exceljs';
import { formatDate, type CampaignReport } from './report';

type Cell = string | number | null;

interface Column {
  header: string;
  /** Ширина в символах. */
  width: number;
}

const SECTION_1_COLUMNS: Column[] = [
  { header: 'Период', width: 16 },
  { header: 'Кол-во обработанных чатов', width: 14 },
  { header: 'Кол-во подобранных контактов', width: 14 },
  { header: 'Сообщений доставлено', width: 14 },
  { header: 'Кол-во любых ответов', width: 12 },
  { header: 'Кол-во целевых ответов', width: 12 },
  { header: 'Кол-во блокировок', width: 12 },
  { header: 'Конверсия "Отправлено - ответ", %', width: 16 },
];

const SECTION_2_COLUMNS: Column[] = [
  { header: 'Чат/группа, откуда взят контакт', width: 30 },
  { header: 'Критерий отбора данного контакта', width: 18 },
  { header: 'Никнейм', width: 22 },
  { header: 'Дата отправки оффера', width: 14 },
  { header: '№ оффера', width: 10 },
  { header: 'Качество лида', width: 12 },
  { header: 'Дата передачи лида клиенту', width: 14 },
];

const SECTION_3_COLUMNS: Column[] = [
  { header: '№ Оффера', width: 9 },
  { header: 'Оффер', width: 24 },
  { header: 'Канал/чат', width: 36 },
  { header: 'Язык аудитории', width: 12 },
  { header: 'Статус', width: 12 },
  { header: 'Дедлайн', width: 12 },
  { header: 'Комментарий/ссылки', width: 20 },
  { header: 'Выводы с цифрами', width: 36 },
];

const THIN = { style: 'thin' } as const;
const BORDER: Partial<ExcelJS.Borders> = { top: THIN, left: THIN, bottom: THIN, right: THIN };
const HEADER_FILL: ExcelJS.Fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
const HEADER_ROW = 4;

/** «1» → 1: номер текстом Excel помечает как ошибку «число сохранено как текст». */
function asNumber(value: string): string | number {
  return /^\d+$/.test(value) ? Number(value) : value;
}

/**
 * Высоту строки считаем сами по переносам: не всякая программа подбирает её
 * при открытии файла, и тогда видна только первая строчка ячейки.
 */
function fitHeight(row: ExcelJS.Row, columns: Column[]): void {
  let lines = 1;
  row.eachCell((cell, col) => {
    const width = columns[col - 1]?.width ?? 10;
    const text = cell.value === null || cell.value === undefined ? '' : String(cell.value);
    const cellLines = text.split('\n')
      .reduce((n, part) => n + Math.max(1, Math.ceil(part.length / width)), 0);
    lines = Math.max(lines, cellLines);
  });
  row.height = lines * 15;
}

/**
 * Лист одного раздела формы: заголовок раздела, под ним кампания и период,
 * затем таблица в рамках. Пустая таблица получает одну пустую строку — под
 * ручное дозаполнение.
 */
function addSectionSheet(
  book: ExcelJS.Workbook,
  title: string,
  subtitle: string,
  columns: Column[],
  rows: Cell[][],
): ExcelJS.Worksheet {
  const sheet = book.addWorksheet(title, {
    views: [{ state: 'frozen', ySplit: HEADER_ROW }],
    pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  sheet.columns = columns.map((c) => ({ width: c.width }));

  sheet.mergeCells(1, 1, 1, columns.length);
  const titleCell = sheet.getCell(1, 1);
  titleCell.value = title;
  titleCell.font = { bold: true, size: 13 };
  titleCell.alignment = { horizontal: 'center' };
  sheet.mergeCells(2, 1, 2, columns.length);
  const subtitleCell = sheet.getCell(2, 1);
  subtitleCell.value = subtitle;
  subtitleCell.font = { italic: true, color: { argb: 'FF666666' } };
  subtitleCell.alignment = { horizontal: 'center' };

  const header = sheet.getRow(HEADER_ROW);
  columns.forEach((c, j) => {
    const cell = header.getCell(j + 1);
    cell.value = c.header;
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = BORDER;
    cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  });
  fitHeight(header, columns);

  const body = rows.length ? rows : [columns.map(() => '')];
  body.forEach((values, i) => {
    const row = sheet.getRow(HEADER_ROW + 1 + i);
    columns.forEach((_, j) => {
      const cell = row.getCell(j + 1);
      const value = values[j] ?? '';
      cell.value = value;
      cell.border = BORDER;
      // Числа и прочерки — по центру, как в форме; текст — от левого края.
      const centered = typeof value === 'number' || value === '—';
      cell.alignment = { vertical: 'top', wrapText: true, ...(centered ? { horizontal: 'center' } : {}) };
    });
    fitHeight(row, columns);
  });
  return sheet;
}

/**
 * Три листа — по разделу формы на каждом (26.10.2026). На одном листе три
 * таблицы делили ширину колонок и заголовки обрезались, а в документ по
 * договору каждую таблицу всё равно переносят отдельно.
 */
export async function buildReportWorkbook(
  report: CampaignReport,
  campaignName: string,
  from: string,
  to: string,
  tzOffsetHours: number,
): Promise<ArrayBuffer> {
  const fromMs = new Date(from).getTime();
  const toMs = new Date(to).getTime();
  const subtitle = `Кампания «${campaignName}», период ${formatDate(fromMs, tzOffsetHours)} — ${formatDate(toMs - 1, tzOffsetHours)}`;
  const book = new ExcelJS.Workbook();

  // «Итого» при одной неделе повторял бы её строку слово в слово.
  const weekRows = report.weeks.length > 1 ? [...report.weeks, report.total] : report.weeks;
  const section1 = addSectionSheet(book, '1. Рассылка и реакция', subtitle, SECTION_1_COLUMNS, weekRows.map((w) => [
    w.period,
    w.chats === null ? '—' : w.chats,
    w.contacts,
    w.delivered,
    w.anyReplies,
    w.targetReplies,
    // В отчётах, собранных до 26.10.2026, блокировки не считались.
    w.blocks ?? '—',
    // Долей, а не процентом: ячейка с форматом процента остаётся числом.
    w.conversion === null ? '—' : Math.round(w.conversion * 10) / 1000,
  ]));
  weekRows.forEach((w, i) => {
    const row = section1.getRow(HEADER_ROW + 1 + i);
    row.getCell(SECTION_1_COLUMNS.length).numFmt = '0.0%';
    if (w === report.total) row.font = { bold: true };
  });

  addSectionSheet(book, '2. Лиды', subtitle, SECTION_2_COLUMNS, report.leads.map((l) => [
    l.sourceChat, l.criterion, l.nickname, l.offerSentAt, asNumber(l.offerNumber), l.quality, l.handedOverAt,
  ]));

  addSectionSheet(book, '3. План работ и Офферы', subtitle, SECTION_3_COLUMNS, report.offers.map((o) => [
    asNumber(o.offerNumber), o.offer, o.channel, o.language, o.status, o.deadline, o.comment, o.conclusions,
  ]));

  return (await book.xlsx.writeBuffer()) as ArrayBuffer;
}
