/** @jest-environment node */

/**
 * Regression test for the "Найти ИНН" UI bug:
 *
 *   handleStartInnLookup() in DatabaseSpreadsheet.tsx used to compute the
 *   indices of the "ИНН (найден)" / "Компания (найдена)" columns inside a
 *   setTabs() updater callback and then read them on the very next line.
 *   React 18 defers updaters, so on the FIRST run (when those columns did
 *   not yet exist) the indices were `undefined`, every subsequent batch
 *   wrote to `row[undefined]`, and the cells stayed visibly empty even
 *   though the API returned the INN correctly.
 *
 *   The fix is to resolve the column indices synchronously, before
 *   touching React state. This test pins that contract.
 */

import {
  resolveInnLookupColumns,
} from '@/lib/enrich/innLookupColumns';

const INN_LABEL = 'ИНН (найден)';
const COMP_LABEL = 'Компания (найдена)';

describe('resolveInnLookupColumns', () => {
  it('reuses existing column indices when both headers already exist', () => {
    const header = ['Сайт', INN_LABEL, COMP_LABEL, 'Прочее'];
    const r = resolveInnLookupColumns(header, INN_LABEL, COMP_LABEL);
    expect(r).toEqual({ innCol: 1, compCol: 2, missingLabels: [] });
  });

  it('appends both columns when neither exists (regression: first run was empty)', () => {
    const header = ['Сайт', 'Город'];
    const r = resolveInnLookupColumns(header, INN_LABEL, COMP_LABEL);
    expect(r.innCol).toBe(2);
    expect(r.compCol).toBe(3);
    expect(r.missingLabels).toEqual([INN_LABEL, COMP_LABEL]);
  });

  it('appends only the company column when ИНН column already exists', () => {
    const header = ['Сайт', INN_LABEL];
    const r = resolveInnLookupColumns(header, INN_LABEL, COMP_LABEL);
    expect(r.innCol).toBe(1);
    expect(r.compCol).toBe(2);
    expect(r.missingLabels).toEqual([COMP_LABEL]);
  });

  it('appends only the ИНН column when company column already exists', () => {
    const header = ['Сайт', COMP_LABEL];
    const r = resolveInnLookupColumns(header, INN_LABEL, COMP_LABEL);
    expect(r.innCol).toBe(2);
    expect(r.compCol).toBe(1);
    expect(r.missingLabels).toEqual([INN_LABEL]);
  });

  it('treats null/undefined header cells as empty strings', () => {
    const header = ['Сайт', null, undefined, INN_LABEL] as unknown[];
    const r = resolveInnLookupColumns(header, INN_LABEL, COMP_LABEL);
    expect(r.innCol).toBe(3);
    expect(r.compCol).toBe(4);
    expect(r.missingLabels).toEqual([COMP_LABEL]);
  });

  it('trims whitespace before matching headers', () => {
    const header = ['Сайт', `  ${INN_LABEL}  `];
    const r = resolveInnLookupColumns(header, INN_LABEL, COMP_LABEL);
    expect(r.innCol).toBe(1);
    expect(r.compCol).toBe(2);
    expect(r.missingLabels).toEqual([COMP_LABEL]);
  });

  it('end-to-end: rows can be filled at the resolved indices on first run', () => {
    // Simulates the contract DatabaseSpreadsheet.tsx relies on:
    // - resolveInnLookupColumns must be called synchronously
    // - then setTabs appends headers + pads rows
    // - then batch writes use innCol / compCol to fill cells
    const headerRow = ['Сайт'];
    const dataRow = ['example.com'];

    const { innCol, compCol, missingLabels } = resolveInnLookupColumns(
      headerRow,
      INN_LABEL,
      COMP_LABEL,
    );

    // Apply header expansion (mirrors the setTabs updater logic)
    let nextCols = headerRow.length;
    for (const label of missingLabels) {
      headerRow[nextCols] = label;
      nextCols += 1;
    }
    while (dataRow.length < nextCols) dataRow.push('');

    // Now mimic batch write
    dataRow[innCol] = '7707083893';
    dataRow[compCol] = 'ООО Тест';

    expect(headerRow).toEqual(['Сайт', INN_LABEL, COMP_LABEL]);
    expect(dataRow).toEqual(['example.com', '7707083893', 'ООО Тест']);
    // Crucially: no stray "undefined" property
    expect(Object.prototype.hasOwnProperty.call(dataRow, 'undefined')).toBe(false);
  });
});
