import { rowsToCsv } from '@/lib/tools/rowsToCsv';

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
