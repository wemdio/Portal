/** @jest-environment node */

import {
  createGuestToken,
  verifyGuestToken,
  hashGuestToken,
} from '@/lib/databaseReview/guestToken';

const SECRET = 'test-secret-key-for-guest-tokens';
const REQUEST_ID = '550e8400-e29b-41d4-a716-446655440000';

describe('Guest token', () => {
  describe('createGuestToken', () => {
    it('returns token, expiresAt and hash', () => {
      const result = createGuestToken(REQUEST_ID, SECRET);
      expect(result.token).toBeTruthy();
      expect(result.token).toContain('.');
      expect(result.expiresAt).toBeTruthy();
      expect(result.hash).toBeTruthy();
      expect(result.hash).toHaveLength(64); // sha256 hex
    });

    it('creates unique tokens for same request', () => {
      const a = createGuestToken(REQUEST_ID, SECRET);
      const b = createGuestToken(REQUEST_ID, SECRET);
      expect(a.token).not.toBe(b.token);
    });
  });

  describe('verifyGuestToken', () => {
    it('verifies a valid token', () => {
      const { token } = createGuestToken(REQUEST_ID, SECRET);
      const result = verifyGuestToken(token, SECRET);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.rid).toBe(REQUEST_ID);
        expect(result.payload.exp).toBeGreaterThan(Date.now());
      }
    });

    it('rejects empty token', () => {
      const result = verifyGuestToken('', SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Missing token');
    });

    it('rejects token without separator', () => {
      const result = verifyGuestToken('nodot', SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid token format');
    });

    it('rejects forged signature', () => {
      const { token } = createGuestToken(REQUEST_ID, SECRET);
      const [payload] = token.split('.');
      const forged = `${payload}.forged-signature`;
      const result = verifyGuestToken(forged, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid token signature');
    });

    it('rejects token signed with different secret', () => {
      const { token } = createGuestToken(REQUEST_ID, 'other-secret');
      const result = verifyGuestToken(token, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Invalid token signature');
    });

    it('rejects expired token', () => {
      const { token } = createGuestToken(REQUEST_ID, SECRET, -1000);
      const result = verifyGuestToken(token, SECRET);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toBe('Token expired');
    });
  });

  describe('hashGuestToken', () => {
    it('produces consistent hash for same token', () => {
      const { token } = createGuestToken(REQUEST_ID, SECRET);
      const h1 = hashGuestToken(token, SECRET);
      const h2 = hashGuestToken(token, SECRET);
      expect(h1).toBe(h2);
    });

    it('matches hash from createGuestToken', () => {
      const { token, hash } = createGuestToken(REQUEST_ID, SECRET);
      expect(hashGuestToken(token, SECRET)).toBe(hash);
    });
  });
});
