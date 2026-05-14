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

  it('overwrites cells containing only the ⚠ error marker when applyOnlyEmpty=true', () => {
    const tabData = makeTabData(1, 5);
    tabData[1][STACK_COL] = '⚠';
    tabData[1][PROFILE_COL] = 'Превышено время ожидания сайта';
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'Tilda, Roistat', profile: 'B2B продажи' }),
      },
    ];

    const summary = applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
      applyOnlyEmpty: true,
    });

    expect(summary.applied).toBe(1);
    expect(tabData[1][STACK_COL]).toBe('Tilda, Roistat');
    expect(tabData[1][PROFILE_COL]).toBe('B2B продажи');
  });

  it('overwrites stale ⚠ row even if new attempt also fails (replaces error message)', () => {
    const tabData = makeTabData(1, 5);
    tabData[1][STACK_COL] = '⚠';
    tabData[1][PROFILE_COL] = 'старая ошибка';
    const results = [
      {
        row_index: 1,
        status: 'failed',
        result_text: null,
        last_error: 'Новая ошибка: DNS не отвечает',
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
      applyOnlyEmpty: true,
    });

    expect(tabData[1][STACK_COL]).toBe('⚠');
    expect(tabData[1][PROFILE_COL]).toBe('Новая ошибка: DNS не отвечает');
  });

  it('still skips truly filled cells (real stack present, no ⚠) when applyOnlyEmpty=true', () => {
    const tabData = makeTabData(1, 5);
    tabData[1][STACK_COL] = 'Tilda, Bitrix';
    tabData[1][PROFILE_COL] = 'Корп. сайт';
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({ stack: 'другое', profile: 'другое' }),
      },
    ];

    const summary = applySignalsToTabData(tabData, results, {
      stackColIndex: STACK_COL,
      profileColIndex: PROFILE_COL,
      applyOnlyEmpty: true,
    });

    expect(summary.skipped).toBe(1);
    expect(tabData[1][STACK_COL]).toBe('Tilda, Bitrix');
  });
});

describe('applySignalsToTabData — extra columns from extractors', () => {
  it('writes string[] (customers) joined by comma into the configured column', () => {
    const tabData = [
      ['Сайт', '', '', 'Стек', 'Профиль', ''],
      ['site.com', '', '', '', '', ''],
    ];
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({
          stack: 'Roistat',
          profile: 'B2B',
          customers: ['Сбербанк', 'Газпром', 'Тинькофф'],
        }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: 3,
      profileColIndex: 4,
      extraCols: [{ key: 'customers', colIndex: 5, header: 'Клиенты' }],
    });

    expect(tabData[0][5]).toBe('Клиенты');
    expect(tabData[1][5]).toBe('Сбербанк, Газпром, Тинькофф');
  });

  it('writes booleans as "Да" (true) and empty string (false)', () => {
    const tabData = [
      ['Сайт', '', '', 'Стек', 'Профиль', '', ''],
      ['a.com', '', '', '', '', '', ''],
      ['b.com', '', '', '', '', '', ''],
    ];
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({ stack: '', profile: '', enterprise_logos: true, free_trial: false }),
      },
      {
        row_index: 2,
        status: 'completed',
        result_text: JSON.stringify({ stack: '', profile: '', enterprise_logos: false, free_trial: true }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: 3,
      profileColIndex: 4,
      extraCols: [
        { key: 'enterprise_logos', colIndex: 5, header: 'Enterprise лого' },
        { key: 'free_trial', colIndex: 6, header: 'Free trial' },
      ],
    });

    expect(tabData[1][5]).toBe('Да');
    expect(tabData[1][6]).toBe('');
    expect(tabData[2][5]).toBe('');
    expect(tabData[2][6]).toBe('Да');
  });

  it('writes numbers as plain strings, missing fields as empty', () => {
    const tabData = [
      ['Сайт', '', '', 'Стек', 'Профиль', ''],
      ['a.com', '', '', '', '', ''],
      ['b.com', '', '', '', '', ''],
    ];
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({ stack: '', profile: '', vacancies_count: 12 }),
      },
      {
        row_index: 2,
        status: 'completed',
        result_text: JSON.stringify({ stack: '', profile: '' }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: 3,
      profileColIndex: 4,
      extraCols: [{ key: 'vacancies_count', colIndex: 5, header: 'Вакансий' }],
    });

    expect(tabData[1][5]).toBe('12');
    expect(tabData[2][5]).toBe('');
  });

  it('writes pricing_min as "<value> <currency>" and pricing_model as plain string', () => {
    const tabData = [
      ['Сайт', '', '', 'Стек', 'Профиль', '', ''],
      ['a.com', '', '', '', '', '', ''],
    ];
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({
          stack: '',
          profile: '',
          pricing_model: 'self-serve',
          pricing_min: { value: 990, currency: 'RUB' },
        }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: 3,
      profileColIndex: 4,
      extraCols: [
        { key: 'pricing_model', colIndex: 5, header: 'Модель продаж' },
        { key: 'pricing_min', colIndex: 6, header: 'Мин. цена' },
      ],
    });

    expect(tabData[1][5]).toBe('Самообслуживание');
    expect(tabData[1][6]).toBe('990 RUB');
  });

  it('writes hiring_roles as comma-joined enabled role names in RU', () => {
    const tabData = [
      ['Сайт', '', '', 'Стек', 'Профиль', ''],
      ['a.com', '', '', '', '', ''],
    ];
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({
          stack: '',
          profile: '',
          hiring_roles: { engineering: true, marketing: true, sales: false },
        }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: 3,
      profileColIndex: 4,
      extraCols: [{ key: 'hiring_roles', colIndex: 5, header: 'Нанимают' }],
    });

    expect(tabData[1][5]).toBe('инженеры, маркетинг');
  });

  it('writes empty extra cells for failed rows but still marks ⚠ in stack/profile', () => {
    const tabData = [
      ['Сайт', '', '', 'Стек', 'Профиль', ''],
      ['a.com', '', '', '', '', ''],
    ];
    const results = [
      {
        row_index: 1,
        status: 'failed',
        result_text: null,
        last_error: 'Тайм-аут',
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: 3,
      profileColIndex: 4,
      extraCols: [{ key: 'customers', colIndex: 5, header: 'Клиенты' }],
    });

    expect(tabData[1][3]).toBe('⚠');
    expect(tabData[1][5]).toBe('');
  });

  it('respects applyOnlyEmpty for extra columns too — does not overwrite filled cells', () => {
    const tabData = [
      ['Сайт', '', '', 'Стек', 'Профиль', 'Клиенты'],
      ['a.com', '', '', 'Roistat', 'B2B', 'Старые клиенты'],
    ];
    const results = [
      {
        row_index: 1,
        status: 'completed',
        result_text: JSON.stringify({
          stack: 'Roistat, AmoCRM',
          profile: 'B2B',
          customers: ['Новый1', 'Новый2'],
        }),
      },
    ];

    applySignalsToTabData(tabData, results, {
      stackColIndex: 3,
      profileColIndex: 4,
      extraCols: [{ key: 'customers', colIndex: 5, header: 'Клиенты' }],
      applyOnlyEmpty: true,
    });

    expect(tabData[1][5]).toBe('Старые клиенты');
  });
});
