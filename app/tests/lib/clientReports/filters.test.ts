/** @jest-environment node */

import {
  REPORT_TIME_ZONE,
  normalizeEmail,
  resolveClientReportFilters,
  scoreToCode,
} from '@/lib/clientReports/filters';

const NOW = new Date('2026-08-06T09:15:00.000Z');

describe('resolveClientReportFilters', () => {
  it.each([
    ['last_7_days', '2026-07-31', '2026-08-06', '2026-07-30T21:00:00.000Z', '2026-08-06T21:00:00.000Z'],
    ['last_30_days', '2026-07-08', '2026-08-06', '2026-07-07T21:00:00.000Z', '2026-08-06T21:00:00.000Z'],
    ['current_month', '2026-08-01', '2026-08-06', '2026-07-31T21:00:00.000Z', '2026-08-06T21:00:00.000Z'],
    ['previous_month', '2026-07-01', '2026-07-31', '2026-06-30T21:00:00.000Z', '2026-07-31T21:00:00.000Z'],
  ] as const)(
    'resolves %s as inclusive Moscow calendar dates and a half-open UTC range',
    (preset, from, to, fromUtc, toExclusiveUtc) => {
      const result = resolveClientReportFilters({ preset, score: 'all' }, NOW);

      expect(result).toMatchObject({
        period: { preset, from, to },
        score: 'all',
        campaignId: null,
      });
      expect(result.period.fromUtc.toISOString()).toBe(fromUtc);
      expect(result.period.toExclusiveUtc.toISOString()).toBe(toExclusiveUtc);
    },
  );

  it('uses the Moscow calendar day when UTC is still on the previous date', () => {
    const augustFirstInMoscow = new Date('2026-07-31T21:30:00.000Z');

    const result = resolveClientReportFilters(
      { preset: 'current_month', score: 'all' },
      augustFirstInMoscow,
    );

    expect(result.period).toMatchObject({ from: '2026-08-01', to: '2026-08-01' });
    expect(result.period.fromUtc.toISOString()).toBe('2026-07-31T21:00:00.000Z');
    expect(result.period.toExclusiveUtc.toISOString()).toBe('2026-08-01T21:00:00.000Z');
  });

  it('resolves a custom inclusive range and accepts exactly 366 calendar days', () => {
    const result = resolveClientReportFilters(
      {
        preset: 'custom',
        from: '2024-01-01',
        to: '2024-12-31',
        score: 'B',
        campaignId: '  campaign-external-id  ',
      },
      NOW,
    );

    expect(result).toMatchObject({
      period: {
        preset: 'custom',
        from: '2024-01-01',
        to: '2024-12-31',
      },
      score: 'B',
      campaignId: 'campaign-external-id',
    });
    expect(result.period.fromUtc.toISOString()).toBe('2023-12-31T21:00:00.000Z');
    expect(result.period.toExclusiveUtc.toISOString()).toBe('2024-12-31T21:00:00.000Z');
  });

  it.each([
    [{ preset: 'custom', from: '2026-2-01', to: '2026-02-02', score: 'all' }, 'YYYY-MM-DD'],
    [{ preset: 'custom', from: '2026-02-30', to: '2026-03-01', score: 'all' }, 'YYYY-MM-DD'],
    [{ preset: 'custom', from: '2026-03-02', to: '2026-03-01', score: 'all' }, 'from must not be after to'],
    [{ preset: 'custom', from: '2024-01-01', to: '2025-01-01', score: 'all' }, '366 days'],
    [{ preset: 'custom', from: '2026-03-01', score: 'all' }, 'from and to'],
  ] as const)('rejects an invalid custom range %#', (input, message) => {
    expect(() => resolveClientReportFilters(input, NOW)).toThrow(message);
  });

  it.each(['last_7_days', 'last_30_days', 'current_month', 'previous_month', 'custom']) (
    'accepts the supported preset %s',
    (preset) => {
      const customDates = preset === 'custom' ? { from: '2026-08-01', to: '2026-08-06' } : {};

      expect(() =>
        resolveClientReportFilters({ preset, score: 'all', ...customDates }, NOW),
      ).not.toThrow();
    },
  );

  it.each(['rolling_week', '', null, undefined, 7])(
    'rejects unsupported preset %p instead of falling back',
    (preset) => {
      expect(() => resolveClientReportFilters({ preset, score: 'all' }, NOW)).toThrow(
        'Unsupported period preset',
      );
    },
  );

  it.each(['all', 'A', 'B', 'C'] as const)('accepts score filter %s', (score) => {
    expect(resolveClientReportFilters({ preset: 'last_7_days', score }, NOW).score).toBe(score);
  });

  it.each(['a', 'rejected', '', null, undefined, 1])(
    'rejects unsupported score %p instead of falling back to all',
    (score) => {
      expect(() => resolveClientReportFilters({ preset: 'last_7_days', score }, NOW)).toThrow(
        'Unsupported score filter',
      );
    },
  );

  it('accepts an optional UUID campaign identifier', () => {
    const campaignId = '8f4bd130-a9f7-4d3f-9434-6a15f5061a9f';

    expect(
      resolveClientReportFilters({ preset: 'last_7_days', score: 'C', campaignId }, NOW)
        .campaignId,
    ).toBe(campaignId);
  });

  it.each(['', '   ', null, 123, ['campaign-id']])(
    'rejects an explicitly supplied invalid campaign %p instead of removing the filter',
    (campaignId) => {
      expect(() =>
        resolveClientReportFilters({ preset: 'last_7_days', score: 'all', campaignId }, NOW),
      ).toThrow('Campaign must be a non-empty string');
    },
  );

  it('exports the reporting timezone used for all calendar calculations', () => {
    expect(REPORT_TIME_ZONE).toBe('Europe/Moscow');
  });
});

describe('scoreToCode', () => {
  it.each([
    [-1, 'rejected'],
    [0, 'rejected'],
    [1_000, 'rejected'],
    [1_001, 'C'],
    [15_000, 'C'],
    [15_001, 'B'],
    [1_000_000, 'B'],
    [1_000_001, 'A'],
  ] as const)('maps score %d to %s', (score, code) => {
    expect(scoreToCode(score)).toBe(code);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects non-finite score %p',
    (score) => {
      expect(() => scoreToCode(score)).toThrow('Score must be a finite number');
    },
  );
});

describe('normalizeEmail', () => {
  it('trims and lowercases an email for stable recipient deduplication', () => {
    expect(normalizeEmail('  Alice.Example@Example.COM\t')).toBe('alice.example@example.com');
  });

  it.each([null, undefined, '', '   '])('normalizes empty input %p to null', (email) => {
    expect(normalizeEmail(email)).toBeNull();
  });

  it('does not pretend to validate email syntax', () => {
    expect(normalizeEmail('  NOT AN EMAIL  ')).toBe('not an email');
  });
});
