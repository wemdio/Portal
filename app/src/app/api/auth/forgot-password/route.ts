import { after, NextResponse, type NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendTransactionalEmail } from '@/lib/email/smtpClient';
import { renderPasswordResetLinkEmail } from '@/lib/email/templates/passwordReset';
import { logAudit, logError } from '@/lib/loggerServer';
import {
  engResetClientIp,
  engResetPageResponse,
  engResetSubmitResponse,
  isEngResetFormRequest,
  resolveEngResetAccount,
  sendEngResetLink,
} from './_engReset';
import {
  createRuResetLink,
  formatMoscowTime,
  isRuResetRequest,
  ruResetOrigin,
  ruResetPageResponse,
  ruResetSubmitResponse,
} from './_ruReset';

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
 * GET /api/auth/forgot-password?token=… — ENG: the page of the reset link
 * (a form for the new password). Does not use the link up. See _engReset.ts.
 * GET ?rt=… — RU: the confirm page with a button (_ruReset.ts).
 */
export async function GET(req: NextRequest) {
  if (isRuResetRequest(req)) return ruResetPageResponse(req);
  return engResetPageResponse(req);
}

/**
 * POST /api/auth/forgot-password
 *
 * Public endpoint (no auth). Body: { email: string }.
 *
 * Flow:
 *   1. Validate input shape (don't bother the DB / SMTP with garbage).
 *   2. Throttle by email — see RECENT_RESETS above.
 *   3. ENG account whose SIGN-IN address is this email (_engReset.ts,
 *      resolveEngResetAccount): a signed one-time reset link to that address;
 *      the password is NOT changed here. Never a password in an email. The
 *      link work (rate limits, block check, GoTrue, SMTP) runs AFTER the
 *      {ok:true} response, so the response time does not tell an ENG
 *      customer's address from an unknown one.
 *   4. RU: look up profiles.email → auth user id. Silent success on miss to
 *      avoid leaking which emails are registered.
 *   5. RU (since 24.10.2026): email a signed confirm link to profiles.email —
 *      the password is NOT changed here. Before, it was rotated right away, so
 *      anyone who knew a staff address could lock that person out every minute.
 *      The link's button (POST ?rt=…) rotates it and mails it (_ruReset.ts).
 *   6. Return the same {ok:true} response either way.
 *
 * A form post (urlencoded) is the ENG reset page saving the new password
 * (_engReset.ts, engResetSubmitResponse); the RU form and «Forgot password?»
 * send JSON and never reach it.
 */
export async function POST(req: NextRequest) {
  // RU confirm button (a form post with ?rt=…) — before the ENG form check.
  if (isRuResetRequest(req)) return ruResetSubmitResponse(req);
  if (isEngResetFormRequest(req)) return engResetSubmitResponse(req);

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

  // ENG account (its sign-in address is this email): a reset link, not a new
  // password (_engReset.ts). A failed lookup does not stop the RU path below;
  // an ENG profile it finds gets no password either (see below).
  const engAccount = await resolveEngResetAccount(supabaseAdmin, emailRaw);
  if (engAccount.kind === 'eng') {
    // After the response (see 3. above). after() is the Next way to run work
    // past the response; outside a request scope it throws — then the promise
    // just runs on (sendEngResetLink never throws).
    const ip = engResetClientIp(req);
    const run = () => sendEngResetLink(ip, engAccount, logMeta);
    try {
      after(run);
    } catch {
      void run();
    }
    return jsonOk();
  }
  if (engAccount.kind === 'unread') {
    await logError('auth.forgot.eng_lookup.failed', null, { detail: engAccount.detail.slice(0, 300) }, logMeta);
  }

  // Resolve userId via profiles. supabase-js admin client doesn't have a
  // "get user by email" yet (would need listUsers + filter); profiles already
  // mirrors email through the auth trigger.
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

  // ENG profile matched here only by profiles.email (its sign-in address is
  // different, or the lookup above failed): an ENG account never gets a new
  // password by email — no change, no letter. RU: unchanged.
  if (profile.market === 'eng') {
    await logAudit(
      'auth.forgot.eng_unresolved',
      'Forgot-password: ENG profile matched by profile email only — no password change, no email',
      { lookup: engAccount.kind },
      logMeta,
    );
    return jsonOk();
  }

  // RU: a confirm link, not a new password (_ruReset.ts).
  const link = await createRuResetLink(ruResetOrigin(req), profile.id as string, Date.now());
  if (!link) {
    await logError('auth.forgot.ru_link.create_failed', null, {}, logMeta);
    return jsonOk();
  }

  const { subject, html, text } = renderPasswordResetLinkEmail({
    link,
    requestedAtMsk: formatMoscowTime(new Date()),
  });

  try {
    await sendTransactionalEmail({
      to: profile.email as string,
      subject,
      html,
      text,
    });
    await logAudit('auth.forgot.ru_link_sent', 'Password reset confirm link sent', { to: profile.email }, logMeta);
  } catch (err) {
    // Nothing changed yet: the user can ask again after RESET_COOLDOWN_MS.
    await logError('auth.forgot.email.failed', err, { to: profile.email }, logMeta);
  }

  return jsonOk();
}
