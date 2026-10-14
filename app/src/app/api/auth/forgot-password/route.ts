import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderPasswordResetEmail } from '@/lib/email/templates/passwordReset';
import { formatEngEmailUtc, renderEngPasswordResetEmail } from '@/lib/email/templates/engPasswordReset';
import { heEngAppOrigin, HE_ENG_VERIFY_FROM_NAME } from '@/lib/hypothesisEngine/engEmailVerificationMail';
import { readHeEngAccountBlock } from '@/lib/hypothesisEngine/engAccountBlockMarker';
import { generateStrongPassword } from '@/lib/passwordGenerator';
import { logAudit, logError } from '@/lib/loggerServer';

export const dynamic = 'force-dynamic';

interface Body {
  email?: unknown;
}

/**
 * Per-email rate-limit window. Two goals:
 *   1. Cap SMTP cost / spam exposure from an attacker scripting the endpoint.
 *   2. Stop an honest double-click from rolling two passwords in a row, where
 *      the user's inbox would show two emails with different passwords and
 *      only the second one actually works.
 *
 * In-memory Map is per-instance — not perfect across a multi-replica fleet,
 * but the throttle stays effective in aggregate because hitting the same
 * email through a sticky session lands on the same process. If we ever scale
 * past a couple instances, promote this to Redis.
 */
const RECENT_RESETS = new Map<string, number>();
const RESET_COOLDOWN_MS = 60_000;

function formatMoscowTime(d: Date): string {
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(d);
  const map: Record<string, string> = {};
  for (const p of parts) map[p.type] = p.value;
  return `${map.day}.${map.month}.${map.year}, ${map.hour}:${map.minute} МСК`;
}

/**
 * Constant success response. The endpoint NEVER reveals whether the email is
 * registered — every input that survives basic shape validation returns the
 * same body. Account enumeration is a real problem on B2B portals where
 * customer lists are sensitive.
 */
function jsonOk() {
  return NextResponse.json({ ok: true });
}

/**
 * A blocked ENG account (S3b, owner decision 2026-10-12: a block stops
 * everything): the ENG client card's block marker (he_eng_account_blocks) or a
 * Supabase ban that has not expired yet — including a ban set outside the card.
 * Without this check a reset would rotate the blocked account's password and
 * email it. The caller still answers {ok:true}: like whether an email is
 * registered, a block is never revealed. 'unread' — something could not be
 * read: no password change and no email (the user can try again after
 * RESET_COOLDOWN_MS). Marker table missing (migration 20261013_0001 not
 * applied) — the ban alone decides.
 */
async function engResetRefusal(
  userId: string,
): Promise<{ kind: 'blocked'; source: 'marker' | 'ban' } | { kind: 'unread'; detail: string } | null> {
  if (!supabaseAdmin) return { kind: 'unread', detail: 'no supabaseAdmin' };
  const marker = await readHeEngAccountBlock(supabaseAdmin, userId);
  if (marker.state === 'blocked') return { kind: 'blocked', source: 'marker' };
  if (marker.state === 'error') return { kind: 'unread', detail: marker.detail };
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !data?.user) return { kind: 'unread', detail: `auth user read: ${error?.message ?? 'no user'}` };
    const bannedUntil = typeof data.user.banned_until === 'string' ? data.user.banned_until.trim() : '';
    if (!bannedUntil) return null;
    // An unparseable ban end counts as banned, as in the auto-launch (fail-closed).
    const until = Date.parse(bannedUntil);
    return !Number.isFinite(until) || until > Date.now() ? { kind: 'blocked', source: 'ban' } : null;
  } catch (e) {
    return { kind: 'unread', detail: `auth user read threw: ${e instanceof Error ? e.message : 'unknown'}` };
  }
}

/**
 * POST /api/auth/forgot-password
 *
 * Public endpoint (no auth). Body: { email: string }.
 *
 * Flow:
 *   1. Validate input shape (don't bother the DB / SMTP with garbage).
 *   2. Throttle by email — see RECENT_RESETS above.
 *   3. Look up profiles.email → auth user id. Silent success on miss to
 *      avoid leaking which emails are registered.
 *   4. Generate a strong password, write it to auth.users via admin update.
 *   5. Email the new password to profiles.email (never to the input email
 *      directly — they're equal here, but the indirection makes the security
 *      property explicit and refactor-resistant).
 *   6. Return the same {ok:true} response either way.
 */
export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const emailRaw = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!emailRaw || !emailRaw.includes('@') || emailRaw.length > 200) {
    // Bad-shape input still gets a 200 so attackers can't probe what is
    // "well-formed" vs "registered".
    return jsonOk();
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const logMeta = { email: emailRaw, requestId, ip, route: '/api/auth/forgot-password' };

  const now = Date.now();
  const last = RECENT_RESETS.get(emailRaw) ?? 0;
  if (now - last < RESET_COOLDOWN_MS) {
    await logAudit('auth.forgot.throttled', `Throttled forgot-password for ${emailRaw}`, {}, logMeta);
    return jsonOk();
  }
  RECENT_RESETS.set(emailRaw, now);

  if (!supabaseAdmin) {
    await logError('auth.forgot.no_admin', null, {}, logMeta);
    return jsonOk();
  }

  // Resolve userId via profiles. supabase-js admin client doesn't have a
  // "get user by email" yet (would need listUsers + filter); profiles already
  // mirrors email through the auth trigger. `market` picks the email language:
  // an ENG-cabinet account (profiles.market = 'eng') gets the English letter.
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('id, email, market')
    .eq('email', emailRaw)
    .maybeSingle();

  if (profileErr) {
    await logError('auth.forgot.profile_lookup.failed', profileErr, {}, logMeta);
    return jsonOk();
  }
  if (!profile || !profile.email) {
    await logAudit('auth.forgot.no_match', `Forgot-password for unknown email ${emailRaw}`, {}, logMeta);
    return jsonOk();
  }

  // ENG: a blocked account gets no new password and no email (see
  // engResetRefusal). RU: unchanged, no such check.
  if (profile.market === 'eng') {
    const refusal = await engResetRefusal(profile.id as string);
    if (refusal?.kind === 'blocked') {
      await logAudit(
        'auth.forgot.eng_blocked',
        'Forgot-password refused: ENG account is blocked',
        { source: refusal.source },
        logMeta,
      );
      return jsonOk();
    }
    if (refusal?.kind === 'unread') {
      await logError('auth.forgot.eng_block_read.failed', null, { detail: refusal.detail.slice(0, 300) }, logMeta);
      return jsonOk();
    }
  }

  const newPassword = generateStrongPassword(14);
  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
    profile.id as string,
    { password: newPassword },
  );
  if (updateErr) {
    await logError('auth.forgot.update.failed', updateErr, {}, logMeta);
    return jsonOk();
  }

  // ENG: English letter, the reset time in UTC (the reader's zone is unknown),
  // a link to the cabinet's account page and the same sender name as the
  // other ENG letters. RU: the letter and the call exactly as before.
  // The link goes through sign-in (`/login?next=`, app/login/page.tsx accepts
  // exactly this next on the ENG host), so after signing in the reader lands
  // on the password form, not on the dashboard. A reader who is still signed
  // in is sent from this /login straight to the account page by middleware.
  const eng = profile.market === 'eng';
  const { subject, html, text } = eng
    ? renderEngPasswordResetEmail({
        password: newPassword,
        resetAtUtc: formatEngEmailUtc(new Date()),
        accountUrl: `${heEngAppOrigin()}/login?next=/client/eng/account`,
      })
    : renderPasswordResetEmail({
        password: newPassword,
        resetAtMsk: formatMoscowTime(new Date()),
      });

  try {
    await sendTransactionalEmail({
      to: profile.email as string,
      subject,
      html,
      text,
      ...(eng ? { fromName: HE_ENG_VERIFY_FROM_NAME } : {}),
    });
    await logAudit('auth.forgot.success', `Password reset email sent`, { to: profile.email }, logMeta);
  } catch (err) {
    // Password is already rotated. Surface the failure in logs; user can hit
    // reset again after RESET_COOLDOWN_MS — the next attempt will generate
    // and try to send a fresh password.
    await logError('auth.forgot.email.failed', err, { to: profile.email }, logMeta);
  }

  return jsonOk();
}
