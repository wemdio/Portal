import { describe, expect, test } from '@jest/globals';
import {
  isMailganerEndpointUrl,
  resolveMailganerScoringConcurrency,
} from '@/lib/jobs/mailganerScoringThrottle';

describe('isMailganerEndpointUrl', () => {
  test('matches Mailganer API hosts', () => {
    expect(isMailganerEndpointUrl('https://mailganer.com/api/v2/domain-spf-score/')).toBe(true);
    expect(isMailganerEndpointUrl('https://api.mailganer.com/score')).toBe(true);
  });

  test('does not match unrelated endpoints', () => {
    expect(isMailganerEndpointUrl('https://example.com/api/score')).toBe(false);
    expect(isMailganerEndpointUrl(null)).toBe(false);
  });
});

describe('resolveMailganerScoringConcurrency', () => {
  test('halves Mailganer concurrency by default', () => {
    expect(
      resolveMailganerScoringConcurrency({
        endpointUrl: 'https://mailganer.com/api/v2/domain-spf-score/',
        defaultConcurrency: 5,
        env: {},
      }),
    ).toBe(2);
  });

  test('keeps non-Mailganer endpoints unchanged', () => {
    expect(
      resolveMailganerScoringConcurrency({
        endpointUrl: 'https://client.example.com/score',
        defaultConcurrency: 5,
        env: {},
      }),
    ).toBe(5);
  });

  test('uses explicit env override for Mailganer endpoints', () => {
    expect(
      resolveMailganerScoringConcurrency({
        endpointUrl: 'https://mailganer.com/api/v2/domain-spf-score/',
        defaultConcurrency: 5,
        env: { MAILGANER_SCORING_CONCURRENCY: '3' },
      }),
    ).toBe(3);
  });
});
