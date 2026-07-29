/**
 * @jest-environment node
 */

import { deduplicateRowsByKey } from '@/lib/spreadsheet/deduplicateRowsByKey';

describe('deduplicateRowsByKey', () => {
  it('removes rows without a key and keeps the richest duplicate row', () => {
    const rows = [
      ['first', '', ''],
      ['second', 'sales@example.com', ''],
      ['second richer', 'sales@example.com', '+79990000000'],
      ['third', 'info@example.com', ''],
      ['fourth', 'not-an-email', ''],
    ];
    const getEmail = (row: string[]) => {
      const match = row[1]?.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
      return match ? match[0].toLowerCase() : null;
    };

    expect(deduplicateRowsByKey(rows, getEmail)).toEqual({
      rows: [
        ['second richer', 'sales@example.com', '+79990000000'],
        ['third', 'info@example.com', ''],
      ],
      duplicateCount: 1,
      missingKeyCount: 2,
    });
  });

  it('keeps the first row when duplicate rows have the same score', () => {
    const rows = [
      ['first', 'same@example.com'],
      ['second', 'same@example.com'],
    ];

    expect(deduplicateRowsByKey(rows, (row) => row[1])).toEqual({
      rows: [rows[0]],
      duplicateCount: 1,
      missingKeyCount: 0,
    });
  });
});
