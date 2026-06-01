/**
 * @jest-environment node
 *
 * Регрессионные тесты для parseCSV.
 *
 * Главный кейс который этот файл прикрепляет: client polza@polza.ru загрузил
 * `B2B_объединённая с почтами 2ч.csv` (4297 строк), у нескольких компаний в
 * колонке «Отрасль» лежало `Консалтинговые услуги;Кадровые агентства` — две
 * отрасли через `;` БЕЗ обёртки кавычками. Старый parseCSV сплитил cells на
 * `,` ИЛИ `;` ИЛИ `\t` одновременно, поэтому `;` внутри ячейки разбивал её
 * на две и сдвигал все следующие колонки вправо. В итоге у Atsal в колонке
 * `email` оказался текст вакансий, а 1795 из 2418 финальных строк ушли в
 * вывод вообще без почт. Фикс — детектировать разделитель из первой строки
 * и использовать только его.
 */

import * as XLSX from 'xlsx';
import { parseCSV, detectDelimiter, readXlsxRows } from '@/lib/spreadsheet/parseCSV';

describe('detectDelimiter', () => {
  it('comma-CSV header → ","', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('semicolon-CSV header → ";"', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });

  it('TSV header → "\\t"', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });

  it('ignores delimiter chars inside quoted header cells', () => {
    // Header: `"a,b","c;d","e"` — comma and semicolon are INSIDE quoted
    // cells in the header. Outside quotes there's only one `,` actually
    // delimiting fields. Detector must NOT count the inner ones.
    expect(detectDelimiter('"a,b","c;d","e"\n1,2,3')).toBe(',');
  });

  it('mixed inside quotes prefers the delimiter that appears OUTSIDE most often', () => {
    // Header: `name;email;notes\n` — pure `;`-CSV.  Body line 2 has commas
    // inside a quoted cell, but detector only looks at row 1.
    expect(detectDelimiter('name;email;notes\n"Acme, Inc.";a@x;\"hi, there\"')).toBe(';');
  });

  it('single-column file with no delimiters defaults to ","', () => {
    expect(detectDelimiter('header\nvalue1\nvalue2')).toBe(',');
  });

  it('stops at the first unquoted newline (does not peek into row 2)', () => {
    // Row 1: 2 commas, 0 semicolons.
    // Row 2: 0 commas, 100 semicolons.
    // We must pick `,` because that's what the header uses.
    const text = 'a,b,c\n' + 'x' + ';y'.repeat(100);
    expect(detectDelimiter(text)).toBe(',');
  });
});

describe('parseCSV', () => {
  it('REGRESSION: ";" inside an UNQUOTED cell in a comma-CSV stays one cell', () => {
    // The polza@polza.ru bug. Raw line from the client file:
    //   ATSAL,B2B,http://www.atsal.com,Консалтинговые услуги;Кадровые агентства,"Москва, СПб",...
    // The «Отрасль» cell is unquoted because RFC-4180 doesn't require quotes
    // for a cell containing only `;` (it's not a CSV-special char).
    // Old parser split on `;` too → 9 cells. Fixed parser → 8 cells.
    const csv =
      'компания,Тип,сайт,Отрасль,Города,описание,вакансии,email\n' +
      'ATSAL,B2B,http://www.atsal.com,Консалтинговые услуги;Кадровые агентства,"Москва, Санкт-Петербург",ATSAL desc,Vacancies here,\n';
    const rows = parseCSV(csv);
    expect(rows).toHaveLength(2); // header + 1 data row
    expect(rows[0]).toHaveLength(8);
    expect(rows[1]).toHaveLength(8);
    expect(rows[1][0]).toBe('ATSAL');
    expect(rows[1][3]).toBe('Консалтинговые услуги;Кадровые агентства'); // ← unsplit
    expect(rows[1][4]).toBe('Москва, Санкт-Петербург');
    expect(rows[1][5]).toBe('ATSAL desc');
    expect(rows[1][6]).toBe('Vacancies here');
    expect(rows[1][7]).toBe('');
  });

  it('comma-CSV with quoted cells containing commas parses correctly', () => {
    const csv =
      'a,b,c\n' +
      '"hello, world","foo,bar",baz\n';
    const rows = parseCSV(csv);
    expect(rows[1]).toEqual(['hello, world', 'foo,bar', 'baz']);
  });

  it('semicolon-CSV (EU style) parses with ; as delimiter', () => {
    // Header is `;`-delimited → all rows use `;` as the delimiter, even
    // if comma appears inside cells (which is exactly why some locales
    // use `;` — decimal-comma cultures).
    const csv = 'a;b;c\n1,5;hello, world;3,14';
    const rows = parseCSV(csv);
    expect(rows[1]).toEqual(['1,5', 'hello, world', '3,14']);
  });

  it('TSV parses with tab as delimiter', () => {
    const csv = 'a\tb\tc\n1\thello, world\t3';
    const rows = parseCSV(csv);
    expect(rows[1]).toEqual(['1', 'hello, world', '3']);
  });

  it('escaped double-quotes "" inside a quoted cell decode to one "', () => {
    const csv = 'a,b\n"He said ""hi""",ok';
    const rows = parseCSV(csv);
    expect(rows[1]).toEqual(['He said "hi"', 'ok']);
  });

  it('CRLF line endings parsed identically to LF', () => {
    const csvLF = 'a,b\n1,2\n3,4\n';
    const csvCRLF = 'a,b\r\n1,2\r\n3,4\r\n';
    expect(parseCSV(csvLF)).toEqual(parseCSV(csvCRLF));
  });

  it('skips fully-empty rows but keeps rows with empty cells', () => {
    const csv = 'a,b\n1,2\n\n,\n3,4\n';
    const rows = parseCSV(csv);
    // ['', ''] from `,\n` has no trimmed content → skipped
    expect(rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('delimiterOverride argument bypasses detection', () => {
    // Forced `;` parsing of a comma-CSV-looking string. Useful when
    // caller has out-of-band knowledge of the delimiter.
    const csv = 'a;b;c\n1,2;hi;ok';
    const rows = parseCSV(csv, ';');
    expect(rows[1]).toEqual(['1,2', 'hi', 'ok']);
  });
});

describe('readXlsxRows', () => {
  it('keeps Excel dates formatted and long numeric IDs as plain strings', async () => {
    const sheet = XLSX.utils.aoa_to_sheet([
      ['ID продавца', 'Дата регистрации на Wildberries', 'ОГРН', 'Организация'],
      [1107548066689, 43978, 1111111111111, 'ООО Тест'],
      [7725693620, '', '', 'ИП Тест'],
    ]);
    sheet.B2.z = 'yyyy-mm-dd';

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;

    await expect(readXlsxRows(buffer)).resolves.toEqual([
      ['ID продавца', 'Дата регистрации на Wildberries', 'ОГРН', 'Организация'],
      ['1107548066689', '2020-05-27', '1111111111111', 'ООО Тест'],
      ['7725693620', '', '', 'ИП Тест'],
    ]);
  });
});
