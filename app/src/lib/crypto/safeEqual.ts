import { timingSafeEqual } from 'crypto';

/**
 * Constant-time string equality. Use for comparing secrets / API keys / webhook
 * tokens so an attacker can't recover them byte-by-byte via response timing.
 *
 * Length is compared first (and short-circuits) — that leaks only the length,
 * which is not the secret, and is required because timingSafeEqual throws on
 * unequal-length buffers.
 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
