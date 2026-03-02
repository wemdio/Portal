import { createHmac, timingSafeEqual } from 'crypto';

export type CallbackAction = 'approve' | 'request_changes';

const CALLBACK_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export type CallbackPayload = {
  rid: string;
  act: CallbackAction;
  exp: number;
};

export function signCallbackData(
  requestId: string,
  action: CallbackAction,
  secret: string,
  ttlMs: number = CALLBACK_TTL_MS,
): string {
  const payload: CallbackPayload = {
    rid: requestId,
    act: action,
    exp: Date.now() + ttlMs,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  return `${payloadB64}.${sig}`;
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

  const [payloadB64, sig] = data.split('.');
  if (!payloadB64 || !sig) {
    return { ok: false, error: 'Invalid callback format' };
  }

  const expectedSig = createHmac('sha256', secret).update(payloadB64).digest('base64url');
  if (!safeEqual(sig, expectedSig)) {
    return { ok: false, error: 'Invalid callback signature' };
  }

  let payload: CallbackPayload;
  try {
    const json = Buffer.from(payloadB64, 'base64url').toString('utf8');
    payload = JSON.parse(json) as CallbackPayload;
  } catch {
    return { ok: false, error: 'Invalid callback payload' };
  }

  if (!payload?.rid || !payload?.act || !payload?.exp) {
    return { ok: false, error: 'Incomplete callback payload' };
  }

  if (payload.act !== 'approve' && payload.act !== 'request_changes') {
    return { ok: false, error: 'Unknown callback action' };
  }

  if (Date.now() > payload.exp) {
    return { ok: false, error: 'Callback expired' };
  }

  return { ok: true, payload };
}
