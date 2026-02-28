import { parseBriefScoringContent } from '@/lib/briefScoring/scoring';

describe('brief scoring content parser', () => {
  it('parses plain JSON array', () => {
    const raw = JSON.stringify([
      { idx: 1, score: 8, reason: 'Сильное совпадение' },
      { idx: 2, score: 4, reason: 'Частичное совпадение' },
    ]);

    expect(parseBriefScoringContent(raw)).toEqual([
      { idx: 1, score: 8, reason: 'Сильное совпадение' },
      { idx: 2, score: 4, reason: 'Частичное совпадение' },
    ]);
  });

  it('extracts array from wrapped object and normalizes malformed entries', () => {
    const raw = JSON.stringify({
      scores: [
        { idx: '3', score: 11.7, reason: 123 },
        { idx: 4, score: -2, reason: 'Слабое совпадение' },
      ],
    });

    expect(parseBriefScoringContent(raw)).toEqual([
      { idx: 0, score: 10, reason: '' },
      { idx: 4, score: 0, reason: 'Слабое совпадение' },
    ]);
  });

  it('extracts JSON array embedded in extra text', () => {
    const raw = `some preface\n[{"idx":7,"score":6.2,"reason":"ok"}]\nfooter`;

    expect(parseBriefScoringContent(raw)).toEqual([
      { idx: 7, score: 6, reason: 'ok' },
    ]);
  });

  it('throws when no parseable array is present', () => {
    expect(() => parseBriefScoringContent('{"not":"an array"}')).toThrow();
    expect(() => parseBriefScoringContent('invalid-json')).toThrow();
  });
});

