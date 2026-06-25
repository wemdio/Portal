import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendDemoLeadTelegramAlert } from '@/lib/demoLead/notify';

export const dynamic = 'force-dynamic';

/**
 * POST /api/demo-lead — public lead capture. A visitor submits name (req) + email
 * (req) + optional phone/telegram/company/message from a landing contact form (the
 * hero "Обсудить задачу" form; `source` discriminates the surface). We persist the
 * lead (demo_leads) and ping the team on Telegram with a source-labeled title.
 * Public (allowlisted in middleware, like /api/signup). The landing posts
 * cross-origin in `no-cors` mode with application/x-www-form-urlencoded (no
 * preflight, opaque response), so this is best-effort capture — it must never throw
 * back at the visitor.
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

// Lead surfaces allowed to label themselves; anything else is stored as 'unknown'
// so a client can't inject arbitrary text into the Telegram alert title.
const ALLOWED_SOURCES = new Set(['hero', 'demo']);

interface LeadFields {
  name: string;
  email: string;
  phone: string;
  telegram: string;
  company: string;
  message: string;
  source: string;
}

async function readFields(req: NextRequest): Promise<LeadFields> {
  const ct = req.headers.get('content-type') ?? '';
  const get = (v: unknown) => (typeof v === 'string' ? v : '');
  let raw: Record<string, string>;
  if (ct.includes('application/json')) {
    const b = (await req.json()) as Record<string, unknown>;
    raw = {
      name: get(b.name), email: get(b.email), phone: get(b.phone), telegram: get(b.telegram),
      company: get(b.company), message: get(b.message), source: get(b.source),
    };
  } else {
    const fd = await req.formData();
    const f = (k: string) => String(fd.get(k) ?? '');
    raw = {
      name: f('name'), email: f('email'), phone: f('phone'), telegram: f('telegram'),
      company: f('company'), message: f('message'), source: f('source'),
    };
  }
  const source = ALLOWED_SOURCES.has(raw.source.trim()) ? raw.source.trim() : 'unknown';
  return {
    name: raw.name.trim(),
    email: raw.email.trim().toLowerCase(),
    phone: raw.phone.trim(),
    telegram: raw.telegram.trim(),
    company: raw.company.trim(),
    message: raw.message.trim(),
    source,
  };
}

export async function POST(req: NextRequest) {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (rateLimited(ip)) return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 });

  let fields: LeadFields;
  try {
    fields = await readFields(req);
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const { name, email, phone, telegram, company, message, source } = fields;

  if (!name || name.length > 200) return NextResponse.json({ error: 'Укажите имя' }, { status: 400 });
  if (!EMAIL_RE.test(email) || email.length > 320) {
    return NextResponse.json({ error: 'Укажите корректный email' }, { status: 400 });
  }
  if (phone.length > 50) return NextResponse.json({ error: 'Слишком длинный телефон' }, { status: 400 });
  if (telegram.length > 100) return NextResponse.json({ error: 'Слишком длинный telegram' }, { status: 400 });
  if (company.length > 200) return NextResponse.json({ error: 'Слишком длинное название компании' }, { status: 400 });
  if (message.length > 2000) return NextResponse.json({ error: 'Слишком длинное сообщение' }, { status: 400 });

  const referrer = req.headers.get('referer') ?? null;

  if (supabaseAdmin) {
    const { error } = await supabaseAdmin.from('demo_leads').insert({
      name,
      email,
      phone: phone || null,
      telegram: telegram || null,
      company: company || null,
      message: message || null,
      source,
      referrer,
      user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
    });
    if (error) console.error('[demo-lead] insert failed:', error.message);
  } else {
    console.error('[demo-lead] supabaseAdmin not configured — lead not stored');
  }

  // Awaited best-effort (never throws) — serverless can freeze after the response,
  // so don't fire-and-forget the notify.
  await sendDemoLeadTelegramAlert({
    name, email, phone: phone || null, telegram: telegram || null,
    company: company || null, message: message || null, source, referrer,
  });

  return NextResponse.json({ ok: true });
}
