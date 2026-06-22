/** @jest-environment node */

import { removeSignalErrorRows } from '@/lib/spreadsheet/removeSignalErrorRows';
import { SIGNAL_ERROR_MARKER } from '@/lib/enrich/signalConstants';

const STACK_COL = 3;

function row(site: string, stack: string): string[] {
  return [site, '', '', stack, ''];
}

describe('removeSignalErrorRows', () => {
  it('keeps header and rows without error marker', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      row('ok.ru', 'GA, AmoCRM'),
      row('also-ok.ru', 'Tilda'),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual(data);
  });

  it('drops rows whose stack cell is exactly the error marker', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      row('ok.ru', 'GA'),
      row('dead.ru', SIGNAL_ERROR_MARKER),
      row('also-dead.ru', SIGNAL_ERROR_MARKER),
      row('alive.ru', 'WordPress'),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(2);
    expect(result.nextData).toHaveLength(3);
    expect(result.nextData[0]).toEqual(data[0]);
    expect(result.nextData.map((r) => r[0])).toEqual(['Сайт', 'ok.ru', 'alive.ru']);
  });

  it('treats whitespace around the marker as match (defensive)', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      row('dead.ru', `  ${SIGNAL_ERROR_MARKER}  `),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(1);
    expect(result.nextData).toHaveLength(1);
  });

  it('keeps row when stack cell is undefined (short row) — not an error', () => {
    const data = [
      ['Сайт', 'A', 'B', 'Стек', 'Профиль'],
      ['short.ru', '', ''],
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual(data);
  });

  it('keeps header even if it accidentally contains the marker', () => {
    const data = [
      ['Сайт', 'A', 'B', SIGNAL_ERROR_MARKER, 'Профиль'],
      row('ok.ru', 'GA'),
    ];
    const result = removeSignalErrorRows(data, STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual(data);
  });

  it('empty data returns empty', () => {
    const result = removeSignalErrorRows([], STACK_COL);
    expect(result.removed).toBe(0);
    expect(result.nextData).toEqual([]);
  });
});
