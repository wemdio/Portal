/**
 * Выгрузка базы контактов в файл.
 *
 * До этого база уезжала в портал в одну сторону: файл грузили, а забрать назад
 * — только через SQL на проде. Между тем именно выгрузка отвечает на живые
 * вопросы: кому уже написали, кто не нашёлся в Telegram, что осталось в
 * очереди, — и она же нужна, чтобы поднять гипотезу в другой кампании.
 *
 * Первые две колонки — юзернейм и сообщение, ровно в том порядке, который ждёт
 * загрузчик (`parseBaseRows`). Выгруженный файл грузится обратно: заголовок
 * распознаётся по первой ячейке, остальные колонки уедут в `raw` и рассылке не
 * помешают.
 *
 * Чтение из БД живёт в роуте: здесь чистые функции над строками, поэтому их
 * поведение целиком покрыто тестами.
 */
import ExcelJS from 'exceljs';

export type ExportContact = {
  username: string | null;
  message: string | null;
  status: string | null;
  skip_reason: string | null;
  attempts: number | null;
  tg_user_id: number | string | null;
  sent_at: string | null;
  created_at: string | null;
};

/** Статусы человеческим языком: файл читает продажник, а не разработчик. */
const STATUS_RU: Record<string, string> = {
  pending: 'ждёт',
  sent: 'отправлено',
  replied: 'ответил',
  failed: 'отложено',
  skipped: 'пропущено',
};

export const EXPORT_HEADERS = [
  'Юзернейм',
  'Сообщение',
  'Статус',
  'Причина пропуска',
  'Попыток',
  'Telegram ID',
  'Отправлено (МСК)',
  'Добавлено (МСК)',
];

/** Время в московской зоне: портал везде показывает МСК, файл не исключение. */
export function formatMsk(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')} ${get('hour')}:${get('minute')}`;
}

export function contactToRow(c: ExportContact): string[] {
  return [
    c.username ?? '',
    c.message ?? '',
    (c.status && STATUS_RU[c.status]) || c.status || '',
    c.skip_reason ?? '',
    String(c.attempts ?? 0),
    c.tg_user_id == null ? '' : String(c.tg_user_id),
    formatMsk(c.sent_at),
    formatMsk(c.created_at),
  ];
}

export function buildExportRows(contacts: ExportContact[]): string[][] {
  return [EXPORT_HEADERS, ...contacts.map(contactToRow)];
}

/**
 * CSV для Excel: разделитель — точка с запятой, в начале BOM.
 *
 * С запятой и без BOM русский Excel открывает файл одной колонкой в
 * кракозябрах — то есть выгрузка формально есть, а пользоваться ей нельзя.
 * Текст первого касания бывает в несколько абзацев, поэтому переводы строк
 * экранируем наравне с кавычками.
 */
export function toCsv(rows: string[][]): string {
  const esc = (v: string) => (/[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\r\n') + '\r\n';
}

/** Имя листа: Excel режет на 31 символе и не терпит `/\?*[]:`. */
export function sheetName(baseName: string): string {
  return baseName.replace(/[\\/?*[\]:]+/g, ' ').trim().slice(0, 31) || 'База';
}

export async function toXlsx(baseName: string, rows: string[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName(baseName));
  for (const r of rows) ws.addRow(r);
  ws.getRow(1).font = { bold: true };
  ws.columns = [
    { width: 26 }, { width: 90 }, { width: 14 }, { width: 50 },
    { width: 10 }, { width: 16 }, { width: 18 }, { width: 18 },
  ];
  ws.autoFilter = { from: 'A1', to: `${String.fromCharCode(64 + EXPORT_HEADERS.length)}1` };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  return new Uint8Array(Buffer.from(await wb.xlsx.writeBuffer() as ArrayBuffer));
}

/**
 * Имя файла. Кириллицу оставляем — её несёт заголовок `filename*` по RFC 5987;
 * режем только то, что ломает файловую систему.
 */
export function exportFileName(baseName: string | null | undefined, format: 'xlsx' | 'csv', day: string): string {
  const raw = (baseName ?? '').trim();
  const slug = raw
    ? raw.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '-').slice(0, 60)
    : 'base';
  return `${slug || 'base'}-${day}.${format}`;
}
