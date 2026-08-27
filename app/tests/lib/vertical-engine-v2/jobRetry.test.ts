/** @jest-environment node */

import {
  isRetryableStageError,
  maxAttemptsFor,
  retryRunAfter,
} from '@/lib/verticalEngineV2/jobRetry';

describe('jobRetry', () => {
  describe('isRetryableStageError', () => {
    it.each([
      ['Requesty 502: {"error":{"origin":"provider","message":"unavailable"}}', true],
      ['Requesty 503: Service Unavailable', true],
      ['Requesty 429: rate limited', true],
      ['Requesty 500: internal', true],
      ['provider is currently unavailable', true],
      ['fetch failed', true],
      ['ECONNRESET', true],
      ['socket hang up', true],
      ['Requesty 400: bad request', false],
      ['Requesty 401: unauthorized', false],
      ['Unterminated string in JSON', false],
      ['no rows found', false],
    ])('classifies %j as retryable=%s', (msg, expected) => {
      expect(isRetryableStageError(msg)).toBe(expected);
    });
  });

  describe('maxAttemptsFor', () => {
    it('gives more attempts to transient errors', () => {
      expect(maxAttemptsFor('Requesty 502: nope')).toBe(5);
    });

    it('keeps 3 attempts for permanent errors', () => {
      expect(maxAttemptsFor('Requesty 400: bad schema')).toBe(3);
    });
  });

  describe('retryRunAfter', () => {
    const NOW = Date.parse('2026-08-26T12:00:00.000Z');

    it('delays transient errors with exponential backoff', () => {
      expect(retryRunAfter(1, true, NOW)).toBe('2026-08-26T12:00:30.000Z');
      expect(retryRunAfter(2, true, NOW)).toBe('2026-08-26T12:01:00.000Z');
      expect(retryRunAfter(3, true, NOW)).toBe('2026-08-26T12:02:00.000Z');
    });

    it('caps the backoff at 120s', () => {
      expect(retryRunAfter(4, true, NOW)).toBe('2026-08-26T12:02:00.000Z');
      expect(retryRunAfter(5, true, NOW)).toBe('2026-08-26T12:02:00.000Z');
    });

    it('returns now for permanent errors (immediate reclaim)', () => {
      expect(retryRunAfter(1, false, NOW)).toBe('2026-08-26T12:00:00.000Z');
    });
  });
});
