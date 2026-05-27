/**
 * @jest-environment node
 *
 * Regression tests for the base-constructor pre-flight ETA. The old
 * formula ignored `cheap`-cost site-scrape steps entirely and predicted
 * «5–15 минут» for a workload that actually wall-clocked at ~2 hours
 * (polza@polza.ru job 8b188038-… on 4297 rows). This file pins the new
 * coefficients against the same real-world data point so we notice if
 * someone «simplifies» the formula back to size-factor heuristics.
 */

import {
  estimateProcessingMinutes,
  formatProcessingTimeBand,
} from '@/lib/tools/baseConstructorEta';

describe('estimateProcessingMinutes', () => {
  it('zero workload returns the 1-minute floor', () => {
    expect(estimateProcessingMinutes({
      rows: 0,
      cheapSteps: 0,
      apiSteps: 0,
      aiSteps: 0,
    })).toBe(1);
  });

  it('rows but only free steps (no cheap/api/ai) returns the 1-minute floor', () => {
    // free steps aren't in the formula — they're pure JS filters and never
    // material. The floor protects against displaying «0 минут» for a
    // dedup-only run.
    expect(estimateProcessingMinutes({
      rows: 10_000,
      cheapSteps: 0,
      apiSteps: 0,
      aiSteps: 0,
    })).toBe(1);
  });

  it('REGRESSION: polza-like workload (4297 rows × 9 client steps) lands in the 1–4h band', () => {
    // Default client mode: 4 free + 1 ai (clean_names) + 3 cheap
    // (check_sites, find_emails, enrich_descriptions) + 1 api (validate_emails).
    // Actual wall-clock: ~120 min. With our coefficients
    // (cheap=0.5, api=0.2, ai=0.1 sec/row):
    //   4297 * (3 * 0.5 + 1 * 0.2 + 1 * 0.1) = 4297 * 1.8 = 7734.6s ≈ 129 min
    // Within the «1–2 часа» tier (60..120 min boundary) or just into «2–4
    // часа» — same order-of-magnitude as actual, which is the goal.
    const minutes = estimateProcessingMinutes({
      rows: 4297,
      cheapSteps: 3,
      apiSteps: 1,
      aiSteps: 1,
    });
    // Allow some drift but ensure it stays in a HOURS band, not minutes.
    expect(minutes).toBeGreaterThanOrEqual(60);
    expect(minutes).toBeLessThanOrEqual(240);
    // And the label must reflect hours, not «5–15 минут».
    const label = formatProcessingTimeBand(minutes);
    expect(label === '1–2 часа' || label === '2–4 часа').toBe(true);
  });

  it('cheap steps dominate the estimate vs api/ai', () => {
    // The whole point of the regression: cheap site-scrape is the time
    // hog, not AI. 1 cheap step should produce a bigger estimate than
    // 1 ai step on the same row count.
    const cheap = estimateProcessingMinutes({
      rows: 1000,
      cheapSteps: 1,
      apiSteps: 0,
      aiSteps: 0,
    });
    const ai = estimateProcessingMinutes({
      rows: 1000,
      cheapSteps: 0,
      apiSteps: 0,
      aiSteps: 1,
    });
    expect(cheap).toBeGreaterThan(ai);
  });

  it('estimate scales linearly with row count', () => {
    const base = estimateProcessingMinutes({
      rows: 1000,
      cheapSteps: 2,
      apiSteps: 1,
      aiSteps: 1,
    });
    const tenx = estimateProcessingMinutes({
      rows: 10_000,
      cheapSteps: 2,
      apiSteps: 1,
      aiSteps: 1,
    });
    // 10× rows should give ~10× minutes (allow small rounding drift).
    expect(tenx).toBeGreaterThanOrEqual(base * 9);
    expect(tenx).toBeLessThanOrEqual(base * 11);
  });

  it('small workload (500 rows, only free + 1 cheap) → minutes range, not hours', () => {
    // 500 * 0.5 = 250s ≈ 4 min → «несколько минут» tier.
    const minutes = estimateProcessingMinutes({
      rows: 500,
      cheapSteps: 1,
      apiSteps: 0,
      aiSteps: 0,
    });
    expect(minutes).toBeLessThan(15);
    expect(formatProcessingTimeBand(minutes)).toBe('несколько минут');
  });
});

describe('formatProcessingTimeBand', () => {
  // Boundary tests pin the tier transitions so we don't accidentally
  // shift them when fiddling with coefficients later.
  it.each<[number, string]>([
    [0, 'до 2 минут'],
    [1, 'до 2 минут'],
    [2, 'несколько минут'],
    [4, 'несколько минут'],
    [5, '5–15 минут'],
    [14, '5–15 минут'],
    [15, '15–30 минут'],
    [29, '15–30 минут'],
    [30, '30–60 минут'],
    [59, '30–60 минут'],
    [60, '1–2 часа'],
    [119, '1–2 часа'],
    [120, '2–4 часа'],
    [239, '2–4 часа'],
    [240, 'более 4 часов'],
    [600, 'более 4 часов'],
  ])('central=%i minutes → %s', (minutes, expected) => {
    expect(formatProcessingTimeBand(minutes)).toBe(expected);
  });
});
