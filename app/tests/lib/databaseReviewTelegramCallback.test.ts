/** @jest-environment node */

import {
  signCallbackData,
  verifyCallbackData,
} from '@/lib/databaseReview/telegramCallback';

const SECRET = 'tg-callback-secret-for-tests';
const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Telegram callback data', () => {
  describe('signCallbackData', () => {
    it('returns a string with dot separator', () => {
      const data = signCallbackData(REQUEST_ID, 'approve', SECRET);
      expect(typeof data).toBe('string');
      expect(data).toContain('.');
    });

    it('produces different data for different actions', () => {
      const approve = signCallbackData(REQUEST_ID, 'approve', SECRET);
      const changes = signCallbackData(REQUEST_ID, 'request_changes', SECRET);
      expect(approve).not.toBe(changes);
    });
  });

  describe('verifyCallbackData', () => {
    it('verifies approve callback', () => {
      const data = signCallbackData(REQUEST_ID, 'approve', SECRET);
      const result = verifyCallbackData(data, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.rid).toBe(REQUEST_ID);
        expect(result.payload.act).toBe('approve');
        expect(result.payload.exp).toBeGreaterThan(Date.now());
      }
    });

    it('verifies request_changes callback', () => {
      const data = signCallbackData(REQUEST_ID, 'request_changes', SECRET);
      const result = verifyCallbackData(data, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.act).toBe('request_changes');
      }
    });

    it('rejects empty data', () => {
      const result = verifyCallbackData('', SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Missing callback data');
    });

    it('rejects data without separator', () => {
      const result = verifyCallbackData('noseparator', SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid callback format');
    });

    it('rejects forged signature', () => {
      const data = signCallbackData(REQUEST_ID, 'approve', SECRET);
      const [payload] = data.split('.');
      const forged = `${payload}.forged`;
      const result = verifyCallbackData(forged, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid callback signature');
    });

    it('rejects data signed with wrong secret', () => {
      const data = signCallbackData(REQUEST_ID, 'approve', 'wrong-secret');
      const result = verifyCallbackData(data, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid callback signature');
    });

    it('rejects expired callback', () => {
      const data = signCallbackData(REQUEST_ID, 'approve', SECRET, -1000);
      const result = verifyCallbackData(data, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Callback expired');
    });
  });
});
