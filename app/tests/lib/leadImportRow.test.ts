/** @jest-environment node */

import { extractInnFromRow } from '@/lib/cisLeads/leadImportRow';

describe('leadImportRow', () => {
  it('extracts inn from header INN', () => {
    const row = { 'ИНН': '7715708080', name: 'ООО Альфа' };
    expect(extractInnFromRow(row)).toBe('7715708080');
  });

  it('extracts inn from INN/KPP header', () => {
    const row = { 'ИНН/КПП': '7715708080/123456789', name: 'ООО Бета' };
    expect(extractInnFromRow(row)).toBe('7715708080');
  });

  it('extracts inn from any cell when header is unknown', () => {
    const row = { col1: 'ИНН: 7715708080', col2: 'foo' };
    expect(extractInnFromRow(row)).toBe('7715708080');
  });

  it('pads leading zero when XLSX parses INN as number (9 digits)', () => {
    const row = { 'ИНН': 323019200, 'Краткое наименование': 'БПП "КОНУС"' };
    expect(extractInnFromRow(row)).toBe('0323019200');
  });

  it('handles 10-digit INN as number correctly', () => {
    const row = { 'ИНН': 7715708080, name: 'test' };
    expect(extractInnFromRow(row)).toBe('7715708080');
  });
});
