/** @jest-environment node */

/**
 * Tests for lib/hypothesisEngine/baseCsv.ts — CSV-выгрузка he_bases:
 *
 *   buildBaseCsv      — BOM, заголовки = columns, разделитель ';', экранирование
 *                       (кавычки удваиваются, поля с [";\n] в кавычках), \r\n-строки
 *   safeBaseFilename  — транслит кириллицы, только [a-z0-9-_.], fallback base-<id>
 */

import { buildBaseCsv, csvField, safeBaseFilename } from '@/lib/hypothesisEngine/baseCsv';

describe('csvField', () => {
  it('passes plain values through untouched', () => {
    expect(csvField('ООО Код')).toBe('ООО Код');
    expect(csvField(42)).toBe('42');
    expect(csvField('')).toBe('');
  });

  it('renders null/undefined as empty', () => {
    expect(csvField(null)).toBe('');
    expect(csvField(undefined)).toBe('');
  });

  it('wraps fields containing the delimiter and doubles inner quotes', () => {
    expect(csvField('a;b')).toBe('"a;b"');
    expect(csvField('ООО "Код"')).toBe('"ООО ""Код"""');
    expect(csvField('строка1\nстрока2')).toBe('"строка1\nстрока2"');
  });

  it('prefixes formula-injection cells (=,+,-,@) with an apostrophe', () => {
    // Значения приходят из парсеров — Excel иначе вычислит их как формулу.
    expect(csvField('=1+1')).toBe("'=1+1");
    expect(csvField('+79151234567')).toBe("'+79151234567");
    expect(csvField('-5')).toBe("'-5");
    expect(csvField('@channel')).toBe("'@channel");
    // Префикс ставится до экранирования: поле с разделителем всё равно в кавычках.
    expect(csvField('=a;b')).toBe(`"'=a;b"`);
    // Опасный символ не в начале ячейки — не трогаем.
    expect(csvField('a=b')).toBe('a=b');
  });
});

describe('buildBaseCsv', () => {
  it('starts with a UTF-8 BOM (Excel-RU detects encoding)', () => {
    const csv = buildBaseCsv(['company'], [{ company: 'АС' }]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('uses columns as the header row, semicolon-delimited', () => {
    const csv = buildBaseCsv(
      ['company', 'website'],
      [{ company: 'АС', website: 'as.ru' }],
    );
    const body = csv.slice(1); // срезаем BOM
    expect(body).toBe('company;website\r\nАС;as.ru');
  });

  it('escapes cells with delimiter/quotes/newlines and keeps column order', () => {
    const csv = buildBaseCsv(
      ['company', 'note', 'missing'],
      [{ note: 'первая\nвторая', company: 'ООО "Код"; ИП', extra: 'не попадает' }],
    );
    const [header, line] = csv.slice(1).split('\r\n');
    expect(header).toBe('company;note;missing');
    // Колонки идут в порядке columns, лишние ключи строки игнорируются,
    // отсутствующая колонка — пустая ячейка.
    expect(line).toBe('"ООО ""Код""; ИП";"первая\nвторая";');
  });

  it('handles an empty row set (headers only)', () => {
    expect(buildBaseCsv(['a', 'b'], [])).toBe('﻿a;b');
  });
});

describe('safeBaseFilename', () => {
  it('transliterates cyrillic and replaces unsafe chars with dashes', () => {
    expect(safeBaseFilename('auto: HR-агентства', 'b1')).toBe('auto-hr-agentstva.csv');
    expect(safeBaseFilename('База «Стоматологии» 2026', 'b1')).toBe('baza-stomatologii-2026.csv');
  });

  it('does not duplicate the .csv extension', () => {
    expect(safeBaseFilename('leads.csv', 'b1')).toBe('leads.csv');
    expect(safeBaseFilename('LEADS.CSV', 'b1')).toBe('leads.csv');
  });

  it('strips known spreadsheet extensions (.xlsx/.xls) before appending .csv', () => {
    expect(safeBaseFilename('подъём.xlsx', 'b1')).toBe('podem.csv');
    expect(safeBaseFilename('Book.XLS', 'b1')).toBe('book.csv');
  });

  it('keeps dots and dashes, collapses repeats', () => {
    expect(safeBaseFilename('base  v2.1 -- final', 'b1')).toBe('base-v2.1-final.csv');
  });

  it('falls back to base-<id>.csv when nothing safe remains', () => {
    expect(safeBaseFilename('🔥🔥', 'abc-123')).toBe('base-abc-123.csv');
    expect(safeBaseFilename('', 'abc-123')).toBe('base-abc-123.csv');
    expect(safeBaseFilename(null, 'abc-123')).toBe('base-abc-123.csv');
  });
});
