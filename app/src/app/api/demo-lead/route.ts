import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendDemoLeadTelegramAlert } from '@/lib/demoLead/notify';

export const dynamic = 'force-dynamic';

/**
 * POST /api/demo-lead — public landing demo-gate: a visitor submits name (req) +
 * email (req) + phone (optional) before being redirected into /demo. We persist
 * the lead (demo_leads) and ping the team on Telegram. Public (allowlisted in
 * middleware, like /api/signup). The landing posts cross-origin in `no-cors`
 * mode with application/x-www-form-urlencoded (no preflight, opaque response) and
 * redirects to /demo regardless, so this is best-effort capture — it must never
 * be the thing that stops a visitor reaching the demo.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort per-instance rate limit (public, unauthenticated endpoint).
const WINDOW_MS = 60_000;
const MAX_HITS = 20;
const hits = new Map<string, number[]>();
function rateLimited(ip: string): boolean {
  const now = Date.now();
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_HITS;
}

async function readFields(req: NextRequest): Promise<{ name: string; email: string; phone: string; telegram: string }> {
  const ct = req.headers.get('content-type') ?? '';
  let name = '';
  let email = '';
  let phone = '';
  let telegram = '';
  if (ct.includes('application/json')) {
    const b = (await req.json()) as { name?: unknown; email?: unknown; phone?: unknown; telegram?: unknown };
    name = typeof b.name === 'string' ? b.name : '';
    email = typeof b.email === 'string' ? b.email : '';
    phone = typeof b.phone === 'string' ? b.phone : '';
    telegram = typeof b.telegram === 'string' ? b.telegram : '';
  } else {
    const fd = await req.formData();
    name = String(fd.get('name') ?? '');
    email = String(fd.get('email') ?? '');
    phone = String(fd.get('phone') ?? '');
    telegram = String(fd.get('telegram') ?? '');
  }
  return { name: name.trim(), email: email.trim().toLowerCase(), phone: phone.trim(), telegram: telegram.trim() };
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 });

  let fields: { name: string; email: string; phone: string; telegram: string };
  try {
    fields = await readFields(req);
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const { name, email, phone, telegram } = fields;

  if (!name || name.length > 200) return NextResponse.json({ error: 'Укажите имя' }, { status: 400 });
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ error: 'Укажите корректный email' }, { status: 400 });
  }
  if (phone.length > 50) return NextResponse.json({ error: 'Слишком длинный телефон' }, { status: 400 });
  if (telegram.length > 100) return NextResponse.json({ error: 'Слишком длинный telegram' }, { status: 400 });

  const referrer = req.headers.get('referer') ?? null;

  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from('demo_leads').insert({
      name,
      email,
      phone: phone || null,
      telegram: telegram || null,
      referrer,
      user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
    });
    if (error) console.error('[demo-lead] insert failed:', error.message);
  } else {
    console.error('[demo-lead] supabaseAdmin not configured — lead not stored');
  }

  // Awaited best-effort (never throws) — serverless can freeze after the response,
  // so don't fire-and-forget the notify.
  await sendDemoLeadTelegramAlert({ name, email, phone: phone || null, telegram: telegram || null, referrer });

  return NextResponse.json({ ok: true });
}
