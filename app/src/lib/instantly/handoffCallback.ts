import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed Telegram callback_data for the lead-handoff "Передать клиенту" button.
 * Format: `h.{qualificationId}.{sig24}` — h(1)+.(1)+uuid(36)+.(1)+sig(24) = 63
 * bytes, within Telegram's 64-byte callback_data limit. The HMAC stops anyone
 * from forging a press for an arbitrary qualification id.
 * Mirrors the database-review callback pattern (lib/databaseReview/telegramCallback.ts).
 */

const PREFIX = 'h';
const SIG_LEN = 24;

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export function signHandoffCallback(qualificationId: string, secret: string): string {
  const body = `${PREFIX}.${qualificationId}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url').slice(0, SIG_LEN);
  return `${body}.${sig}`;
}

export type HandoffVerifyResult =
  | { ok: true; qualificationId: string }
  | { ok: false; error: string };

export function verifyHandoffCallback(data: string, secret: string): HandoffVerifyResult {
  if (!data || typeof data !== 'string') return { ok: false, error: 'Missing callback data' };

  const lastDot = data.lastIndexOf('.');
  if (lastDot < 2) return { ok: false, error: 'Invalid callback format' };

  const body = data.slice(0, lastDot);
  const sig = data.slice(lastDot + 1);
  if (!body || !sig) return { ok: false, error: 'Invalid callback format' };

  const expectedSig = createHmac('sha256', secret).update(body).digest('base64url').slice(0, SIG_LEN);
  if (!safeEqual(sig, expectedSig)) return { ok: false, error: 'Invalid callback signature' };

  if (!body.startsWith(`${PREFIX}.`)) return { ok: false, error: 'Unknown callback prefix' };
  const qualificationId = body.slice(PREFIX.length + 1);
  if (!qualificationId) return { ok: false, error: 'Incomplete callback payload' };

  return { ok: true, qualificationId };
}
