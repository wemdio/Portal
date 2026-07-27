import { createHmac, timingSafeEqual, randomBytes } from 'crypto';

/**
 * Постоянный capability-токен гостевой таблицы лидов проекта (/leads-board/<token>).
 *
 * Формат: lb_<base64url({pid, nonce})>.<hmac-sha256>. Без exp — ссылка вечная,
 * печатается в каждой TG-карточке лида; отзыв = регенерация (новый nonce →
 * старые ссылки умирают). Хранится целиком в project_lead_boards.token: в отличие
 * от review-ссылок (показали один раз), эту ссылку надо рендерить повторно.
 *
 * Секрет — как у database-review guestToken: GUEST_TOKEN_SECRET →
 * fallback SUPABASE_SERVICE_ROLE_KEY.
 */
export function boardTokenSecret(): string {
  return process.env.GUEST_TOKEN_SECRET ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';
}

export function createBoardToken(projectId: string, secret: string): string {
  const payload = { pid: projectId, nonce: randomBytes(12).toString('hex') };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `lb_${payloadB64}.${signature}`;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Валидный токен → projectId; любая порча/чужая подпись → null. */
export function verifyBoardToken(token: string, secret: string): string | null {
  if (!token || typeof token !== 'string' || !token.startsWith('lb_')) return null;
  const body = token.slice(3);
  const dot = body.lastIndexOf('.');
  if (dot <= 0 || dot === body.length - 1) return null;
  const payloadB64 = body.slice(0, dot);
  const signature = body.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as {
      pid?: unknown;
    };
    return typeof payload?.pid === 'string' && payload.pid.length > 0 ? payload.pid : null;
  } catch {
    return null;
  }
}

/** Публичная ссылка на таблицу. Base URL — как в остальных TG-ссылках на портал. */
export function boardUrl(token: string): string {
  const base = (process.env.PORTAL_PUBLIC_URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? '').replace(/\/$/, '');
  return `${base}/leads-board/${token}`;
}
