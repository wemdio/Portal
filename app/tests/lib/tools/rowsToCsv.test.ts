import { rowsToCsv, rowsToCsvFile, rowsToCsvChunks } from '@/lib/tools/rowsToCsv';

describe('rowsToCsv', () => {
  it('quotes every cell and joins with comma / newline', () => {
    expect(rowsToCsv([['a', 'b'], ['c', 'd']])).toBe('"a","b"\n"c","d"');
  });

  it('doubles inner double-quotes', () => {
    expect(rowsToCsv([['say "hi"']])).toBe('"say ""hi"""');
  });

  it('treats null/undefined as empty string', () => {
    expect(rowsToCsv([[null, undefined, '']])).toBe('"","",""');
  });

  it('keeps commas and newlines inside a cell (quoted, so safe)', () => {
    expect(rowsToCsv([['a,b', 'c\nd']])).toBe('"a,b","c\nd"');
  });

  it('coerces non-string cells via String() — locks the intended behavior', () => {
    // In practice cells are string[][], but lock the coercion so it can't silently
    // change: legacy (c||'') blanked 0/false; String(c??'') preserves them.
    expect(rowsToCsv([[0, false, 'x']])).toBe('"0","false","x"');
  });

  it('matches the legacy client-side build byte-for-byte', () => {
    // Old code: jobData.map(row => row.map(c => `"${(c||'').replace(/"/g,'""')}"`).join(',')).join('\n')
    const rows = [
      ['компания', 'сайт', 'email'],
      ['ООО "Ромашка"', 'romashka.ru', 'a@romashka.ru'],
      ['Бета', '', ''],
    ];
    const legacy = rows
      .map((row) => row.map((c) => `"${(c || '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    expect(rowsToCsv(rows)).toBe(legacy);
  });
});

describe('rowsToCsvFile', () => {
  it('prepends a UTF-8 BOM (U+FEFF) so Excel detects UTF-8', () => {
    const out = rowsToCsvFile([['a', 'b']]);
    expect(out.charCodeAt(0)).toBe(0xfeff);
    expect(out).toBe('﻿"a","b"');
  });

  it('is exactly BOM + rowsToCsv body', () => {
    const rows = [['компания', 'сайт'], ['Ромашка', 'r.ru']];
    expect(rowsToCsvFile(rows)).toBe('﻿' + rowsToCsv(rows));
  });

  it('still emits the BOM for an empty result', () => {
    expect(rowsToCsvFile([])).toBe('﻿');
  });
});

describe('rowsToCsvChunks (streaming download)', () => {
  const cases = [
    [],
    [['a']],
    [['a', 'b'], ['c', 'd']],
    [['say "hi"', 'a,b'], ['c\nd', ''], [null, undefined, 0]],
    Array.from({ length: 25 }, (_, i) => [`r${i}`, `v${i}`, i]),
  ] as ReadonlyArray<ReadonlyArray<ReadonlyArray<unknown>>>;

  it('concatenated chunks are byte-identical to rowsToCsvFile, for every chunk size', () => {
    for (const chunkRows of [1, 2, 3, 10, 1000]) {
      for (const rows of cases) {
        expect([...rowsToCsvChunks(rows, chunkRows)].join('')).toBe(rowsToCsvFile(rows));
      }
    }
  });

  it('yields the BOM first and only the BOM for empty input', () => {
    expect([...rowsToCsvChunks([])]).toEqual(['﻿']);
  });

  it('guards chunkRows <= 0 / non-finite (no infinite loop, output still correct)', () => {
    const rows = [['a'], ['b'], ['c']];
    for (const bad of [0, -5, NaN]) {
      expect([...rowsToCsvChunks(rows, bad)].join('')).toBe(rowsToCsvFile(rows));
    }
  });
});
