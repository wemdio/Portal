/** @jest-environment node */

import { applySignalsToTabData } from '@/lib/spreadsheet/applySignalJobResults';

function makeTabData(rowsWithCols: number, colsWithoutTwoLast: number): string[][] {
  // Build header + rows. Rows have `colsWithoutTwoLast` columns.
  const header = ['Сайт', ...Array.from({ length: colsWithoutTwoLast - 1 }, (_, i) => `Col${i + 1}`)];
  const data: string[][] = [header];
  for (let r = 0; r < rowsWithCols; r++) {
    const row = [`site${r + 1}.com`];
    for (let c = 1; c < colsWithoutTwoLast; c++) row.push('');
    data.push(row);
  }
  return data;
}

describe('applySignalsToTabData (pure helper)', () => {
  const STACK_COL = 3;
  const PROFILE_COL = 4;

  it('writes parsed JSON {stack, profile} into two columns', () => {
    const tabData = makeTabData(3, 3);
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'Яндекс.Метрика, WordPress', profile: 'Базовое онлайн-присутствие' }),
      },
      {
        row_index: 2,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'Calltouch, JivoSite', profile: 'Продаёт через звонки' }),
      },
    ];

    const summary = applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
      stackHeader: 'Стек',
      profileHeader: 'Профиль',
    });

    expect(summary.applied).toBe(2);
    expect(tabData[0][STACK_COL]).toBe('Стек');
    expect(tabData[0][PROFILE_COL]).toBe('Профиль');
    expect(tabData[1][STACK_COL]).toBe('Яндекс.Метрика, WordPress');
    expect(tabData[1][PROFILE_COL]).toBe('Базовое онлайн-присутствие');
    expect(tabData[2][STACK_COL]).toBe('Calltouch, JivoSite');
    expect(tabData[2][PROFILE_COL]).toBe('Продаёт через звонки');
  });

  it('extends rows that are shorter than profile column index', () => {
    const tabData = makeTabData(2, 2);
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'WordPress', profile: 'Офлайн пытается стать онлайн' }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
      stackHeader: 'Стек',
      profileHeader: 'Профиль',
    });

    expect(tabData[1][STACK_COL]).toBe('WordPress');
    expect(tabData[1][PROFILE_COL]).toBe('Офлайн пытается стать онлайн');
    expect(tabData[1].length).toBeGreaterThanOrEqual(PROFILE_COL + 1);
  });

  it('writes error markers for failed rows', () => {
    const tabData = makeTabData(2, 5);
    const results = [
      {
        row_index: 1,
        status: 'failed',
        result_text: null,
        last_error: 'Превышено время ожидания сайта',
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
    });

    expect(tabData[1][STACK_COL]).toBe('⚠');
    expect(tabData[1][PROFILE_COL]).toContain('Превышено');
  });

  it('handles invalid JSON by writing empty values, not crashing', () => {
    const tabData = makeTabData(2, 5);
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: 'not a valid json {{{',
      },
    ];

    expect(() =>
      applySignalsToTabData(tabData, results, {
        stackColIndex: STACK_COL,
        profileColIndex: PROFILE_COL,
      }),
    ).not.toThrow();
    expect(tabData[1][STACK_COL]).toBe('');
    expect(tabData[1][PROFILE_COL]).toBe('');
  });

  it('skips rows whose row_index is out of bounds', () => {
    const tabData = makeTabData(2, 5);
    const results = [
      {
        row_index: 99,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'X', profile: 'Y' }),
      },
    ];

    const summary = applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
    });

    expect(summary.applied).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(tabData.length).toBe(3);
  });

  it('skips header row (row_index = 0) to never overwrite it', () => {
    const tabData = makeTabData(2, 5);
    const originalHeader = [...tabData[0]];
    const results = [
      {
        row_index: 0,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'X', profile: 'Y' }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
      stackHeader: 'Стек',
      profileHeader: 'Профиль',
    });

    expect(tabData[0][STACK_COL]).toBe(originalHeader[STACK_COL] ?? 'Стек');
    expect(tabData[0][PROFILE_COL]).toBe(originalHeader[PROFILE_COL] ?? 'Профиль');
  });

  it('does not overwrite filled cells when applyOnlyEmpty=true', () => {
    const tabData = makeTabData(1, 5);
    tabData[1][STACK_COL] = 'Существующий стек';
    tabData[1][PROFILE_COL] = 'Существующий профиль';
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'Новый', profile: 'Новый' }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
      applyOnlyEmpty: true,
    });

    expect(tabData[1][STACK_COL]).toBe('Существующий стек');
    expect(tabData[1][PROFILE_COL]).toBe('Существующий профиль');
  });
});
