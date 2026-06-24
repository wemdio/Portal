/**
 * SMTP email verifier for the CIS lead pipeline.
 *
 * Delegates to the shared email-validation engine (lib/emailValidation), which
 * performs the SMTP RCPT-callout through the smtp-proxy on the dedicated VPS
 * (144) — NEVER directly from this (app/prod) host. `smtpVerify` throws when no
 * proxy is configured, so port-25 probes can never egress from the app server's
 * IP. This also lets cisLeads inherit the engine's fixes (RFC 5321 null sender,
 * transient-DNS handling, catch-all detection) instead of a frozen fork.
 *
 * Previously this file opened a raw `net.createConnection(host, 25)` straight
 * from the Next.js process with a non-deliverable `verify@portal-check.ru`
 * sender — both removed.
 */
import 'server-only';

import { validateEmail } from '@/lib/emailValidation/validator';
import type { DomainInfo } from '@/lib/emailValidation/shared';

export type VerifyResult = 'valid' | 'invalid' | 'catch_all' | 'unknown';

function toVerifyResult(result: string): VerifyResult {
  switch (result) {
    case 'ok':
      return 'valid';
    case 'catch_all':
      return 'catch_all';
    case 'invalid':
    case 'disposable':
      return 'invalid';
    default:
      // 'unknown' or anything unexpected → couldn't verify (never assume valid).
      return 'unknown';
  }
}

export async function verifyEmail(
  email: string,
  domainCache?: Map<string, DomainInfo>,
): Promise<VerifyResult> {
  const parts = email.split('@');
  if (parts.length !== 2 || !parts[1]) return 'invalid';
  try {
    const result = await validateEmail(email, domainCache ?? new Map());
    return toVerifyResult(result.result);
  } catch {
    // Proxy not configured / transport error. The engine never falls back to a
    // direct connection, so we simply cannot verify → 'unknown' (callers skip
    // rather than write a wrong email).
    return 'unknown';
  }
}

export async function verifyEmailBatch(
  emails: string[],
  concurrency = 3,
): Promise<Map<string, VerifyResult>> {
  const results = new Map<string, VerifyResult>();
  // Shared per-batch domain cache: MX + catch-all are resolved once per domain.
  const domainCache = new Map<string, DomainInfo>();
  let idx = 0;

  const run = async () => {
    while (idx < emails.length) {
      const i = idx++;
      const email = emails[i]!;
      results.set(email, await verifyEmail(email, domainCache));
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, emails.length) }, () => run()),
  );

  return results;
}
