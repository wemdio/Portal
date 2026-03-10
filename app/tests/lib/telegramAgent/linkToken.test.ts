/** @jest-environment node */

import { createLinkToken, verifyLinkToken } from '@/lib/telegramAgent/linkToken';

const SECRET = 'test-bot-token-123';
const USER_ID = 'c29af427-6bdb-464c-bc83-dd062264e625';

describe('telegramAgent/linkToken', () => {
  it('creates a token string within Telegram start param limit (64 chars)', () => {
    const token = createLinkToken(USER_ID, SECRET);
    expect(typeof token).toBe('string');
    expect(token.length).toBeLessThanOrEqual(64);
    expect(token.length).toBeGreaterThan(10);
  });

  it('verifies a valid token and returns userId', () => {
    const token = createLinkToken(USER_ID, SECRET);
    const result = verifyLinkToken(token, SECRET);
    expect(result).toEqual({ ok: true, userId: USER_ID });
  });

  it('rejects a token signed with a different secret', () => {
    const token = createLinkToken(USER_ID, SECRET);
    const result = verifyLinkToken(token, 'wrong-secret');
    expect(result).toEqual({ ok: false, error: 'invalid_signature' });
  });

  it('rejects a corrupted token', () => {
    const result = verifyLinkToken('garbage', SECRET);
    expect(result).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('rejects an empty token', () => {
    const result = verifyLinkToken('', SECRET);
    expect(result).toEqual({ ok: false, error: 'invalid_format' });
  });

  it('rejects an expired token', () => {
    const token = createLinkToken(USER_ID, SECRET, -1);
    const result = verifyLinkToken(token, SECRET);
    expect(result).toEqual({ ok: false, error: 'expired' });
  });

  it('produces different tokens for different users', () => {
    const t1 = createLinkToken(USER_ID, SECRET);
    const t2 = createLinkToken('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', SECRET);
    expect(t1).not.toBe(t2);
  });

  it('produces different tokens at different times', () => {
    const t1 = createLinkToken(USER_ID, SECRET, 60);
    const t2 = createLinkToken(USER_ID, SECRET, 120);
    expect(t1).not.toBe(t2);
  });
});
