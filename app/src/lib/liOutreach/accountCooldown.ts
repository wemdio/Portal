/**
 * LinkedIn account cooldown helpers.
 *
 * When LinkedIn returns an invitation-limit / already-invited / restricted
 * signal via Unipile, we want to park the *whole account* (not just the
 * current campaign) so every campaign + scraper task that uses this LI account
 * stops hammering the API for a while. This module owns:
 *
 *   - error detection from raw thrown values (`detectAccountCooldownError`)
 *   - cooldown durations per signal kind (`COOLDOWN_MINUTES`)
 *   - small helpers used by both the campaign runner and the scraper
 *
 * Kept side-effect-free so it's trivially unit-testable.
 */

import { UnipileError } from './unipileClient';

export type AccountCooldownKind =
  | 'invitation_limit'
  | 'already_invited'
  | 'account_restricted'
  | 'disconnected';

export interface AccountCooldownDetection {
  kind: AccountCooldownKind;
}

/**
 * Default cooldown durations per signal kind, in minutes.
 *
 * - invitation_limit: 60 min — LinkedIn's weekly invite cap won't reset for
 *   ~10–12h, but we re-poll every hour so we pick up the moment it lifts.
 * - already_invited: 15 min — short tap on the brakes; usually means our
 *   lead list has stale duplicates rather than an account-wide problem.
 * - account_restricted: 120 min — LinkedIn explicitly flagged the account
 *   as restricted/spam; back off harder.
 *
 * Each can be overridden via env for ops/testing.
 */
export const COOLDOWN_MINUTES: Record<AccountCooldownKind, number> = {
  invitation_limit: Number(process.env.LI_INVITE_COOLDOWN_MIN ?? '60'),
  already_invited: Number(process.env.LI_ALREADY_INVITED_COOLDOWN_MIN ?? '15'),
  account_restricted: Number(process.env.LI_RESTRICTED_COOLDOWN_MIN ?? '120'),
  disconnected: Number(process.env.LI_DISCONNECTED_COOLDOWN_MIN ?? '60'),
};

/**
 * Classify a thrown value into a cooldown signal, or `null` if it is a normal
 * error that should NOT park the account.
 *
 * Only `UnipileError` is interesting — anything else (network, AbortError,
 * plain Error, primitives) means our local code blew up, not LinkedIn telling
 * us to slow down.
 */
export function detectAccountCooldownError(err: unknown): AccountCooldownDetection | null {
  if (!(err instanceof UnipileError)) return null;

  const status = err.status;
  const body = (err.body || '').toLowerCase();

  // 5xx — transient Unipile/upstream issues, never a LinkedIn-side limit signal.
  if (status >= 500) return null;

  // Restricted account — LinkedIn explicitly disabled or flagged the account.
  // Check this first so a 403 with "restricted" doesn't fall through to the
  // generic 429 handler and get the wrong cooldown duration.
  if (
    body.includes('account_restricted') ||
    body.includes('restricted') ||
    body.includes('spam') ||
    body.includes('account_disabled') ||
    body.includes('account disabled')
  ) {
    return { kind: 'account_restricted' };
  }

  // Already invited / cannot resend — per-lead signal but still worth a short
  // account cooldown: a long burst of these usually means the lead list is
  // stale and we're suspicious to LI.
  if (
    body.includes('already_invited') ||
    body.includes('already sent') ||
    body.includes('cannot_resend_yet') ||
    body.includes('invitation already exists') ||
    body.includes('already invited')
  ) {
    return { kind: 'already_invited' };
  }

  // Invitation limit — both the explicit body markers and the generic 429.
  if (
    status === 429 ||
    body.includes('invitation_limit') ||
    body.includes('invitation limit') ||
    body.includes('weekly invitation') ||
    body.includes('weekly limit') ||
    body.includes('reached your invitation') ||
    body.includes('too many invitations') ||
    body.includes('too many requests')
  ) {
    return { kind: 'invitation_limit' };
  }

  if (
    body.includes('disconnected_account') ||
    body.includes('disconnected') && body.includes('account')
  ) {
    return { kind: 'disconnected' };
  }

  return null;
}

/**
 * Compute the absolute timestamp (ISO string) until which the account should
 * be parked, given the detection kind and an optional "now" override.
 */
export function computeCooldownUntil(kind: AccountCooldownKind, now: Date = new Date()): string {
  const minutes = COOLDOWN_MINUTES[kind];
  return new Date(now.getTime() + minutes * 60_000).toISOString();
}

/**
 * Persist a cooldown to `li_accounts` and return the timestamp that was
 * written. Both the campaign runner and the scraper call this so that *any*
 * write op that hits a LinkedIn limit parks the account for everyone.
 *
 * Returns the cooldown timestamp plus the DB error message (if any) so
 * callers can decide how loudly to complain about a failed write.
 */
// Loose shape to accept either supabaseAdmin (full SupabaseClient) or a
// per-request authed client. We only use the `update().eq()` builder, which
// is thenable (PromiseLike), so we keep the type minimal and unwrap with
// Promise.resolve() to upgrade to a real Promise.
type CooldownDb = {
  from: (table: string) => {
    update: (data: Record<string, unknown>) => {
      eq: (col: string, val: unknown) => PromiseLike<{ error: { message?: string } | null }>;
    };
  };
};

export async function applyCooldownToAccount(
  db: CooldownDb,
  accountId: string,
  kind: AccountCooldownKind,
): Promise<{ cooldownUntil: string; error: string | null }> {
  const cooldownUntil = computeCooldownUntil(kind);
  // Promise.resolve() upgrades the supabase PostgrestBuilder (PromiseLike) to
  // a full Promise so the caller (and our `await`) play well together.
  const { error } = await Promise.resolve(
    db
      .from('li_accounts')
      .update({ cooldown_until: cooldownUntil, cooldown_reason: kind })
      .eq('id', accountId),
  );
  return {
    cooldownUntil,
    error: error?.message ?? null,
  };
}

/**
 * Returns true if the supplied account row is currently inside an active
 * cooldown window.
 */
export function isAccountInCooldown(
  account: { cooldown_until?: string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!account?.cooldown_until) return false;
  return new Date(account.cooldown_until).getTime() > now.getTime();
}

/**
 * Human-readable Russian label used in logs / UI tooltips.
 */
export function describeCooldownReason(kind: AccountCooldownKind): string {
  switch (kind) {
    case 'invitation_limit':
      return 'упёрлись в недельный лимит инвайтов LinkedIn';
    case 'already_invited':
      return 'LinkedIn вернул "уже инвайтили" — даём аккаунту передохнуть';
    case 'account_restricted':
      return 'LinkedIn временно ограничил аккаунт';
    case 'disconnected':
      return 'LinkedIn-аккаунт отключён от Unipile — требуется переподключение';
  }
}
