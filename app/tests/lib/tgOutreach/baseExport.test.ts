/** @jest-environment node */

/**
 * Выгрузка базы контактов.
 *
 * Проверяем ровно то, что ломает файл на чужой машине: порядок первых двух
 * колонок (по нему база грузится обратно), экранирование в CSV — текст первого
 * касания бывает в несколько абзацев и с кавычками, — и московское время
 * вместо UTC.
 */

import * as XLSX from 'xlsx';
import {
  EXPORT_HEADERS,
  buildExportRows,
  contactToRow,
  exportFileName,
  formatMsk,
  sheetName,
  toCsv,
  toXlsx,
  type ExportContact,
} from '@/lib/tgOutreach/baseExport';
import { parseBaseRows } from '@/lib/tgOutreach/firstTouch/parseBaseFile';

const contact = (over: Partial<ExportContact> = {}): ExportContact => ({
  username: 'ivanov',
  message: 'Добрый день. Есть минута?',
  status: 'pending',
  skip_reason: null,
  attempts: 0,
  tg_user_id: null,
  sent_at: null,
  created_at: '2026-08-11T12:54:53.928Z',
  ...over,
});

describe('contactToRow', () => {
  it('ставит юзернейм и сообщение первыми — в том порядке, в каком их ждёт загрузчик', () => {
    const row = contactToRow(contact());
    expect(row[0]).toBe('ivanov');
    expect(row[1]).toBe('Добрый день. Есть минута?');
    expect(EXPORT_HEADERS[0]).toBe('Юзернейм');
    expect(EXPORT_HEADERS[1]).toBe('Сообщение');
  });

  it('переводит статус на русский, а незнакомый оставляет как есть', () => {
    expect(contactToRow(contact({ status: 'sent' }))[2]).toBe('отправлено');
    expect(contactToRow(contact({ status: 'skipped' }))[2]).toBe('пропущено');
    expect(contactToRow(contact({ status: 'зависло' }))[2]).toBe('зависло');
  });

  it('пустые поля отдаёт пустой строкой, а не null и не «undefined»', () => {
    const row = contactToRow(contact({ skip_reason: null, tg_user_id: null, sent_at: null, attempts: null }));
    expect(row).toEqual([
      'ivanov', 'Добрый день. Есть минута?', 'ждёт', '', '0', '', '', '11.08.2026 15:54',
    ]);
  });

  it('telegram id не теряет точность на больших числах', () => {
    expect(contactToRow(contact({ tg_user_id: '8663827672' }))[5]).toBe('8663827672');
  });
});

describe('formatMsk', () => {
  it('переводит UTC в московское время', () => {
    // 11.08.2026 12:54 UTC = 15:54 МСК.
    expect(formatMsk('2026-08-11T12:54:53.928Z')).toBe('11.08.2026 15:54');
  });

  it('пустое и битое время не роняет выгрузку', () => {
    expect(formatMsk(null)).toBe('');
    expect(formatMsk('не дата')).toBe('');
  });
});

describe('toCsv', () => {
  it('начинается с BOM и разделяет точкой с запятой — иначе русский Excel показывает кракозябры в одну колонку', () => {
    const csv = toCsv([['Юзернейм', 'Сообщение'], ['ivanov', 'Привет']]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv).toContain('ivanov;Привет');
  });

  it('экранирует кавычки, переводы строк и сам разделитель', () => {
    const csv = toCsv([['ivanov', 'Первый абзац\nВторой; с "кавычками"']]);
    expect(csv).toContain('"Первый абзац\nВторой; с ""кавычками"""');
  });
});

describe('exportFileName', () => {
  it('оставляет кириллицу и добавляет дату', () => {
    expect(exportFileName('Ру_аутрич_1', 'xlsx', '2026-08-27')).toBe('Ру_аутрич_1-2026-08-27.xlsx');
  });

  it('убирает символы, на которых спотыкается файловая система', () => {
    expect(exportFileName('Гипотеза 1: базы/чаты?', 'csv', '2026-08-27')).toBe('Гипотеза-1-базычаты-2026-08-27.csv');
  });

  it('у базы без имени всё равно есть имя файла', () => {
    expect(exportFileName('   ', 'csv', '2026-08-27')).toBe('base-2026-08-27.csv');
  });
});

describe('sheetName', () => {
  it('режет до 31 символа и чистит запрещённые символы', () => {
    expect(sheetName('База/для: теста')).toBe('База для  теста');
    expect(sheetName('о'.repeat(40))).toHaveLength(31);
    expect(sheetName('')).toBe('База');
  });
});

describe('круг «выгрузили — загрузили обратно»', () => {
  it('xlsx читается загрузчиком базы: заголовок распознан, контакты те же', async () => {
    const contacts = [
      contact({ username: 'ivanov', message: 'Первое касание для Иванова' }),
      contact({ username: 'petrov', message: 'Первое касание для Петрова', status: 'sent', tg_user_id: 12345 }),
    ];
    const buf = await toXlsx('Ру_аутрич_1', buildExportRows(contacts));

    const wb = XLSX.read(buf, { type: 'array' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], {
      header: 1, blankrows: false, defval: '',
    });

    const parsed = parseBaseRows(rows);
    expect(parsed.headers?.[0]).toBe('Юзернейм');
    expect(parsed.contacts.map((c) => c.username)).toEqual(['ivanov', 'petrov']);
    expect(parsed.contacts[0].message).toBe('Первое касание для Иванова');
    // Статус и прочие колонки уезжают в raw и рассылке не мешают.
    expect(parsed.contacts[1].raw['Статус']).toBe('отправлено');
  });
});
