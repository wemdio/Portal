import { createHmac } from 'crypto';

const LINK_TTL_SECONDS = 600; // 10 minutes

/**
 * Stateless HMAC token for Telegram account linking.
 *
 * Format (hex): userId(32) + expiry(8) + signature(16) = 56 chars.
 * Fits Telegram /start parameter limit of 64 characters.
 */
export function createLinkToken(userId: string, secret: string, ttlSeconds = LINK_TTL_SECONDS): string {
  const userHex = userId.replace(/-/g, '');
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  const expiryHex = expiry.toString(16).padStart(8, '0');
  const payload = userHex + expiryHex;
  const sig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);
  return payload + sig;
}

type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; error: 'invalid_format' | 'invalid_signature' | 'expired' };

export function verifyLinkToken(token: string, secret: string): VerifyResult {
  if (!token || token.length !== 56 || !/^[0-9a-f]+$/.test(token)) {
    return { ok: false, error: 'invalid_format' };
  }

  const userHex = token.slice(0, 32);
  const expiryHex = token.slice(32, 40);
  const sig = token.slice(40, 56);

  const payload = userHex + expiryHex;
  const expectedSig = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16);

  if (sig !== expectedSig) {
    return { ok: false, error: 'invalid_signature' };
  }

  const expiry = parseInt(expiryHex, 16);
  if (Date.now() / 1000 > expiry) {
    return { ok: false, error: 'expired' };
  }

  const userId = [
    userHex.slice(0, 8),
    userHex.slice(8, 12),
    userHex.slice(12, 16),
    userHex.slice(16, 20),
    userHex.slice(20, 32),
  ].join('-');

  return { ok: true, userId };
}
