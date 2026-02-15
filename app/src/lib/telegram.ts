import { createHmac, timingSafeEqual } from 'crypto';

export type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  allows_write_to_pm?: boolean;
  photo_url?: string;
};

export type TelegramInitDataCheckResult =
  | {
      ok: true;
      authDate: number;
      user: TelegramUser | null;
    }
  | {
      ok: false;
      error: string;
    };

export type TelegramLinkPayload = {
  telegram_id: string;
  auth_date: number;
  exp: number;
};

const DEFAULT_INITDATA_MAX_AGE_SECONDS = 300;
const LINK_TOKEN_TTL_SECONDS = 300;
const ALLOWED_CLOCK_SKEW_SECONDS = 60;

function safeEqualHex(a: string, b: string) {
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a, 'hex');
  const bBuf = Buffer.from(b, 'hex');
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function safeEqualString(a: string, b: string) {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function buildDataCheckString(params: URLSearchParams) {
  const entries: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    entries.push(`${key}=${value}`);
  }
  entries.sort();
  return entries.join('\n');
}

export function verifyTelegramInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds: number = DEFAULT_INITDATA_MAX_AGE_SECONDS,
): TelegramInitDataCheckResult {
  if (!initData) return { ok: false, error: 'Missing initData' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, error: 'Missing hash' };

  const authDateValue = params.get('auth_date');
  const authDate = authDateValue ? Number(authDateValue) : NaN;
  if (!Number.isFinite(authDate)) return { ok: false, error: 'Invalid auth_date' };

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (authDate > nowSeconds + ALLOWED_CLOCK_SKEW_SECONDS) {
    return { ok: false, error: 'auth_date is in the future' };
  }
  if (nowSeconds - authDate > maxAgeSeconds) {
    return { ok: false, error: 'initData expired' };
  }

  const dataCheckString = buildDataCheckString(params);
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computedHash = createHmac('sha256', secret).update(dataCheckString).digest('hex');
  if (!safeEqualHex(computedHash, hash)) {
    return { ok: false, error: 'Hash mismatch' };
  }

  const userRaw = params.get('user');
  let user: TelegramUser | null = null;
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramUser;
    } catch {
      return { ok: false, error: 'Invalid user payload' };
    }
  }

  return { ok: true, authDate, user };
}

export function createTelegramLinkToken(telegramId: string, authDate: number, botToken: string) {
  const exp = Date.now() + LINK_TOKEN_TTL_SECONDS * 1000;
  const payload: TelegramLinkPayload = {
    telegram_id: telegramId,
    auth_date: authDate,
    exp,
  };
  const payloadJson = JSON.stringify(payload);
  const payloadB64 = Buffer.from(payloadJson).toString('base64url');
  const signature = createHmac('sha256', botToken).update(payloadB64).digest('base64url');
  return { token: `${payloadB64}.${signature}`, expiresAt: new Date(exp).toISOString() };
}

export function verifyTelegramLinkToken(token: string, botToken: string) {
  const [payloadB64, signature] = token.split('.');
  if (!payloadB64 || !signature) {
    return { ok: false, error: 'Invalid token format' } as const;
  }

  const expectedSignature = createHmac('sha256', botToken).update(payloadB64).digest('base64url');
  if (!safeEqualString(signature, expectedSignature)) {
    return { ok: false, error: 'Invalid token signature' } as const;
  }

  let payload: TelegramLinkPayload;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    payload = JSON.parse(json) as TelegramLinkPayload;
  } catch {
    return { ok: false, error: 'Invalid token payload' } as const;
  }

  if (!payload?.telegram_id || !payload?.exp) {
    return { ok: false, error: 'Invalid token payload' } as const;
  }
  if (Date.now() > payload.exp) {
    return { ok: false, error: 'Token expired' } as const;
  }

  return { ok: true, payload } as const;
}
