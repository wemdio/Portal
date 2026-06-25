import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * GET /demo — public auto-login into the shared, strictly read-only demo account
 * (role=client + is_demo). No password is shipped to the browser: the server uses
 * the service-role admin client to mint a one-time magic-link token, then exchanges
 * it for a session server-side and writes the sb-* cookies onto the redirect to
 * /client. The demo email is fixed in server env (DEMO_ACCOUNT_EMAIL) — visitors
 * can't pick the account.
 *
 * Safety relies on: requireClientAuth blocking all mutations for is_demo accounts,
 * /api/client/* serving fixtures, and internalGuard 403-ing tool routes. See
 * scripts/create-demo-account.mjs.
 */

// Best-effort in-memory rate limit (per server instance) so a public endpoint
// can't be used to hammer the admin generateLink API.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_HITS = 40;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_HITS;
}

function toLogin(reason: string) {
  console.warn(`[demo] -> /login: ${reason}`);
  // Relative Location: the browser resolves it against the public origin. Behind
  // the prod proxy, req.url resolves to the internal bind (0.0.0.0:3000), so an
  // absolute redirect built from req.url would send the browser to a dead address.
  return new NextResponse(null, { status: 303, headers: { Location: '/login' } });
}

export async function GET(req: NextRequest) {
  const email = (process.env.DEMO_ACCOUNT_EMAIL ?? '').trim().toLowerCase();
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!email || !supabaseAdmin || !supabaseUrl || !anonKey) {
    return toLogin('demo not configured (DEMO_ACCOUNT_EMAIL / supabase env)');
  }

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) return new NextResponse('Too Many Requests', { status: 429 });

  // The session cookies must land on the redirect response itself. Relative
  // Location (see toLogin) so the browser lands on the public origin, not the
  // internal 0.0.0.0:3000 that req.url resolves to behind the prod proxy.
  const res = new NextResponse(null, { status: 303, headers: { Location: '/client' } });
  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      get(name: string) {
        return req.cookies.get(name)?.value;
      },
      set(name: string, value: string, options: CookieOptions) {
        res.cookies.set({ name, value, ...options });
      },
      remove(name: string, options: CookieOptions) {
        res.cookies.set({ name, value: '', ...options });
      },
    },
  });

  // GoTrue/supabase-js differ across versions on the OTP `type` for an
  // admin-generated magic link ('magiclink' vs 'email'). A magic-link token is
  // single-use, so mint a FRESH token per attempt to avoid a consume-then-fail.
  const otpTypes = ['magiclink', 'email'] as const;
  let lastErr = 'no token';
  for (const type of otpTypes) {
    const gen = await supabaseAdmin.auth.admin.generateLink({ type: 'magiclink', email });
    const tokenHash = gen.data?.properties?.hashed_token;
    if (gen.error || !tokenHash) {
      lastErr = gen.error?.message ?? 'no token';
      continue;
    }
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return res;
    lastErr = error.message;
  }

  return toLogin(`verifyOtp failed: ${lastErr}`);
}
