import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

const GUEST_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type GuestTokenPayload = {
  rid: string;   // review request id
  exp: number;   // expiry timestamp ms
  nonce: string;
};

export function createGuestToken(
  reviewRequestId: string,
  secret: string,
  ttlMs: number = GUEST_TOKEN_TTL_MS,
): { token: string; expiresAt: string; hash: string } {
  const exp = Date.now() + ttlMs;
  const nonce = randomBytes(8).toString('hex');
  const payload: GuestTokenPayload = { rid: reviewRequestId, exp, nonce };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const token = `${payloadB64}.${signature}`;
  const hash = createHmac('sha256', secret).update(token).digest('hex');
  return { token, expiresAt: new Date(exp).toISOString(), hash };
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export type GuestTokenVerifyResult =
  | { ok: true; payload: GuestTokenPayload }
  | { ok: false; error: string };

export function verifyGuestToken(token: string, secret: string): GuestTokenVerifyResult {
  if (!token || typeof token !== 'string') {
    return { ok: false, error: 'Missing token' };
  }

  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    return { ok: false, error: 'Invalid token format' };
  }

  const expectedSignature = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (!safeEqual(signature, expectedSignature)) {
    return { ok: false, error: 'Invalid token signature' };
  }

  let payload: GuestTokenPayload;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    payload = JSON.parse(json) as GuestTokenPayload;
  } catch {
    return { ok: false, error: 'Invalid token payload' };
  }

  if (!payload?.rid || !payload?.exp) {
    return { ok: false, error: 'Incomplete token payload' };
  }

  if (Date.now() > payload.exp) {
    return { ok: false, error: 'Token expired' };
  }

  return { ok: true, payload };
}

export function hashGuestToken(token: string, secret: string): string {
  return createHmac('sha256', secret).update(token).digest('hex');
}
