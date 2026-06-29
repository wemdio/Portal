import { NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderPasswordResetEmail } from '@/lib/email/templates/passwordReset';
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
  // mirrors email through the auth trigger.
  const { data: profile, error: profileErr } = await supabaseAdmin
    .from('profiles')
    .select('id, email')
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

  const newPassword = generateStrongPassword(14);
  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
    profile.id as string,
    { password: newPassword },
  );
  if (updateErr) {
    await logError('auth.forgot.update.failed', updateErr, {}, logMeta);
    return jsonOk();
  }

  const resetAtMsk = formatMoscowTime(new Date());
  const { subject, html, text } = renderPasswordResetEmail({
    password: newPassword,
    resetAtMsk,
  });

  try {
    await sendTransactionalEmail({
      to: profile.email as string,
      subject,
      html,
      text,
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
