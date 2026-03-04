import { createHmac, timingSafeEqual } from 'crypto';

export type CallbackAction = 'approve' | 'request_changes';

const ACTION_CHAR: Record<CallbackAction, string> = { approve: 'a', request_changes: 'r' };
const CHAR_ACTION: Record<string, CallbackAction> = { a: 'approve', r: 'request_changes' };

const SIG_LEN = 25;

export type CallbackPayload = {
  rid: string;
  act: CallbackAction;
};

/**
 * Compact format: `{a|r}.{uuid}.{sig25}` — fits in Telegram's 64-byte callback_data limit.
 * a.xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx.SSSSSSSSSSSSSSSSSSSSSSSSS = 63 chars
 */
export function signCallbackData(
  requestId: string,
  action: CallbackAction,
  secret: string,
): string {
  const act = ACTION_CHAR[action];
  const body = `${act}.${requestId}`;
  const sig = createHmac('sha256', secret).update(body).digest('base64url').slice(0, SIG_LEN);
  return `${body}.${sig}`;
}

function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

export type CallbackVerifyResult =
  | { ok: true; payload: CallbackPayload }
  | { ok: false; error: string };

export function verifyCallbackData(data: string, secret: string): CallbackVerifyResult {
  if (!data || typeof data !== 'string') {
    return { ok: false, error: 'Missing callback data' };
  }

  const lastDot = data.lastIndexOf('.');
  if (lastDot < 2) {
    return { ok: false, error: 'Invalid callback format' };
  }

  const body = data.slice(0, lastDot);
  const sig = data.slice(lastDot + 1);
  if (!body || !sig) {
    return { ok: false, error: 'Invalid callback format' };
  }

  const expectedSig = createHmac('sha256', secret).update(body).digest('base64url').slice(0, SIG_LEN);
  if (!safeEqual(sig, expectedSig)) {
    return { ok: false, error: 'Invalid callback signature' };
  }

  const firstDot = body.indexOf('.');
  if (firstDot < 0) {
    return { ok: false, error: 'Invalid callback format' };
  }

  const actChar = body.slice(0, firstDot);
  const rid = body.slice(firstDot + 1);
  const act = CHAR_ACTION[actChar];

  if (!act) {
    return { ok: false, error: 'Unknown callback action' };
  }
  if (!rid) {
    return { ok: false, error: 'Incomplete callback payload' };
  }

  return { ok: true, payload: { rid, act } };
}
