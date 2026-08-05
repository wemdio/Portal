/**
 * Tests for lib/hypothesisEngine/verifyEvidence — кодовая пост-верификация
 * доказательств: URL ∈ скачанных источников, цитата — подстрока его текста.
 */

import { verifyEvidenceItems } from '@/lib/hypothesisEngine/verifyEvidence';

const SOURCES = [
  {
    url: 'https://example.com/report-2026',
    text: 'Рынок логистики вырос на 12% за год.  Доля сделок,\nзастрявших на пилоте, увеличилась в 1,7 раза.',
  },
  {
    url: 'https://other.io/article/',
    text: 'Каждый третий оператор складов внедряет WMS.',
  },
];

describe('verifyEvidenceItems', () => {
  it('keeps items whose quote is a verbatim substring of a fetched source', () => {
    const { valid, dropped } = verifyEvidenceItems(
      [
        {
          claim: 'Рынок растёт',
          source_url: 'https://example.com/report-2026',
          quote: 'Рынок логистики вырос на 12% за год.',
        },
      ],
      SOURCES,
    );
    expect(valid).toHaveLength(1);
    expect(dropped).toBe(0);
  });

  it('normalizes whitespace/newlines inside quotes', () => {
    const { valid } = verifyEvidenceItems(
      [
        {
          claim: 'Пилоты застревают',
          source_url: 'https://example.com/report-2026',
          quote: 'Доля сделок, застрявших на пилоте, увеличилась в 1,7 раза.',
        },
      ],
      SOURCES,
    );
    expect(valid).toHaveLength(1);
  });

  it('drops items with a URL that was never fetched', () => {
    const { valid, dropped } = verifyEvidenceItems(
      [
        {
          claim: 'Выдуманный источник',
          source_url: 'https://fabricated.io/stats',
          quote: 'Рынок логистики вырос на 12% за год.',
        },
      ],
      SOURCES,
    );
    expect(valid).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('drops items whose quote is not in the source text (fabricated quote)', () => {
    const { valid, dropped } = verifyEvidenceItems(
      [
        {
          claim: 'Нет такого в источнике',
          source_url: 'https://example.com/report-2026',
          quote: 'Рынок логистики вырос на 47% за квартал.',
        },
      ],
      SOURCES,
    );
    expect(valid).toHaveLength(0);
    expect(dropped).toBe(1);
  });

  it('matches URLs case-insensitively and ignoring trailing slash', () => {
    const { valid } = verifyEvidenceItems(
      [
        {
          claim: 'WMS',
          source_url: 'https://OTHER.io/article',
          quote: 'Каждый третий оператор складов внедряет WMS.',
        },
      ],
      SOURCES,
    );
    expect(valid).toHaveLength(1);
  });

  it('drops too-short quotes and everything when no sources were fetched', () => {
    const short = verifyEvidenceItems(
      [{ claim: 'x', source_url: 'https://other.io/article/', quote: 'WMS' }],
      SOURCES,
    );
    expect(short.dropped).toBe(1);

    const none = verifyEvidenceItems(
      [{ claim: 'x', source_url: 'https://other.io/article/', quote: 'Каждый третий оператор складов внедряет WMS.' }],
      [],
    );
    expect(none.valid).toHaveLength(0);
    expect(none.dropped).toBe(1);
  });
});
