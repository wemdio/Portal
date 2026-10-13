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
 *
 * Optional campaign attribution rides along as extra fields (the outreachos.xyz form
 * sends them): utm_source/utm_medium/utm_campaign/utm_term/utm_content, `referrer`
 * (the site the visitor came from before the landing), `landing` (the URL they
 * arrived on) and `ts` — sent only when the utm_* values come from an earlier visit
 * (the landing's 30-day oos_utm cookie), the time of that visit. They go to
 * demo_leads.utm and the Telegram alert. The Referer header is still stored in
 * demo_leads.referrer as before — the landing's Referrer-Policy cuts it to the
 * origin, which is why the query string has to be sent explicitly.
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
// eng_pilot — форма «Check my niche» английского лендинга outreachos.xyz
// (deploy/static/outreachos.xyz); name там — сайт компании.
const ALLOWED_SOURCES = new Set(['hero', 'demo', 'eng_pilot']);

interface LeadFields {
  name: string;
  email: string;
  phone: string;
  telegram: string;
  company: string;
  message: string;
  source: string;
  utm: Record<string, string> | null;
}

// Attribution fields a form may send. Only these keys are kept; anything else in the
// body is ignored. Values are cleaned and capped rather than rejected, so a bad tag
// never costs the lead.
const UTM_TEXT_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'] as const;
const UTM_TEXT_MAX = 200;
const UTM_URL_MAX = 500;
// The outside referrer may also be an app: Chrome on Android reports a link opened
// from an app as android-app://<package>/ (LinkedIn, Gmail). The landing URL is ours,
// so it stays http(s). Both are only ever shown escaped.
const REFERRER_PROTOCOLS = new Set(['http:', 'https:', 'android-app:', 'ios-app:']);
const LANDING_PROTOCOLS = new Set(['http:', 'https:']);
// `ts` as the landing writes it (Date.toISOString, 24 characters); stored
// re-serialized from the parsed date.
const VISIT_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const VISIT_TS_MAX = 24;
// Control characters and lone UTF-16 surrogates: Postgres rejects \u0000 and an
// unpaired surrogate inside jsonb, which would fail the whole insert.
const UNSAFE_CHARS = /[\p{Cc}\p{Cs}]/gu;

// Caps of the lead fields as the validation in POST enforces them. `source` has no
// length check — only the ALLOWED_SOURCES names pass, and they are far shorter.
const FIELD_MAX = { name: 200, email: 320, phone: 50, telegram: 100, company: 200, message: 2000, source: 32 };

/**
 * Every untrusted body field is cut to four times its cap before any per-character
 * work (trim, regex, Array.from), so an oversized field costs one slice instead of
 * seconds of event loop: EMAIL_RE alone backtracks quadratically, and nginx and
 * Next.js admit bodies of up to 600 MB. Four times leaves room for two-unit code
 * points and for the edge whitespace and control characters that cleaning removes;
 * only a value padded with more than that comes out different. A surrogate pair cut
 * at the boundary becomes a lone surrogate, which UNSAFE_CHARS strips from the
 * attribution values.
 */
function bounded(value: string, max: number): string {
  return value.length > max * 4 ? value.slice(0, max * 4) : value;
}

function cleanUtmText(value: string, max: number): string {
  // Cap by code points, so a cut never splits an emoji into a lone surrogate.
  return Array.from(bounded(value, max).replace(UNSAFE_CHARS, '').trim()).slice(0, max).join('').trim();
}

function cleanUtmUrl(value: string, protocols: Set<string>): string {
  const url = cleanUtmText(value, UTM_URL_MAX);
  if (!url) return '';
  try {
    return protocols.has(new URL(url).protocol) ? url : '';
  } catch {
    return '';
  }
}

function cleanVisitTs(value: string): string {
  const ts = bounded(value, VISIT_TS_MAX).trim();
  if (!VISIT_TS_RE.test(ts)) return '';
  const time = Date.parse(ts);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function readUtm(get: (key: string) => string): Record<string, string> | null {
  const utm: Record<string, string> = {};
  for (const key of UTM_TEXT_KEYS) {
    const value = cleanUtmText(get(key), UTM_TEXT_MAX);
    if (value) utm[key] = value;
  }
  // The visit time belongs to the utm_* values; without them it has nothing to date.
  const ts = Object.keys(utm).length ? cleanVisitTs(get('ts')) : '';
  const referrer = cleanUtmUrl(get('referrer'), REFERRER_PROTOCOLS);
  if (referrer) utm.referrer = referrer;
  const landing = cleanUtmUrl(get('landing'), LANDING_PROTOCOLS);
  if (landing) utm.landing = landing;
  if (ts) utm.ts = ts;
  return Object.keys(utm).length ? utm : null;
}

async function readFields(req: NextRequest): Promise<LeadFields> {
  const ct = req.headers.get('content-type') ?? '';
  const get = (v: unknown) => (typeof v === 'string' ? v : '');
  let raw: Record<string, string>;
  let utm: Record<string, string> | null;
  if (ct.includes('application/json')) {
    const b = (await req.json()) as Record<string, unknown>;
    raw = {
      name: get(b.name), email: get(b.email), phone: get(b.phone), telegram: get(b.telegram),
      company: get(b.company), message: get(b.message), source: get(b.source),
    };
    utm = readUtm((k) => get(b[k]));
  } else {
    const fd = await req.formData();
    const f = (k: string) => String(fd.get(k) ?? '');
    raw = {
      name: f('name'), email: f('email'), phone: f('phone'), telegram: f('telegram'),
      company: f('company'), message: f('message'), source: f('source'),
    };
    utm = readUtm((k) => get(fd.get(k)));
  }
  const field = (k: keyof typeof FIELD_MAX) => bounded(raw[k], FIELD_MAX[k]).trim();
  const source = ALLOWED_SOURCES.has(field('source')) ? field('source') : 'unknown';
  return {
    name: field('name'),
    email: field('email').toLowerCase(),
    phone: field('phone'),
    telegram: field('telegram'),
    company: field('company'),
    message: field('message'),
    source,
    utm,
  };
}

// The app can roll out before migration 20261013_0001 adds demo_leads.utm. Then the
// insert is retried without utm so the lead is still stored; warn once per process.
let utmColumnMissingWarned = false;
function isMissingUtmColumn(error: { code?: string; message?: string }): boolean {
  return (error.code === 'PGRST204' || error.code === '42703') && /\butm\b/.test(error.message ?? '');
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
  const { name, email, phone, telegram, company, message, source, utm } = fields;

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
    const row = {
      name,
      email,
      phone: phone || null,
      telegram: telegram || null,
      company: company || null,
      message: message || null,
      source,
      referrer,
      user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
    };
    const rowWithUtm: typeof row & { utm?: Record<string, string> } = utm ? { ...row, utm } : row;
    let { error } = await supabaseAdmin.from('demo_leads').insert(rowWithUtm);
    if (error && utm && isMissingUtmColumn(error)) {
      if (!utmColumnMissingWarned) {
        utmColumnMissingWarned = true;
        console.warn(
          '[demo-lead] demo_leads.utm is missing (migration 20261013_0001_demo_leads_utm.sql not applied) — ' +
            'storing leads without utm; the Telegram alert still shows it',
        );
      }
      ({ error } = await supabaseAdmin.from('demo_leads').insert(row));
    }
    if (error) console.error('[demo-lead] insert failed:', error.message);
  } else {
    console.error('[demo-lead] supabaseAdmin not configured — lead not stored');
  }

  // Awaited best-effort (never throws) — serverless can freeze after the response,
  // so don't fire-and-forget the notify.
  await sendDemoLeadTelegramAlert({
    name, email, phone: phone || null, telegram: telegram || null,
    company: company || null, message: message || null, source, referrer,
    ...(utm
      ? {
          utm,
          outsideReferrer: utm.referrer ?? null,
          landingUrl: utm.landing ?? null,
          utmEarlierVisitAt: utm.ts ?? null,
        }
      : {}),
  });

  return NextResponse.json({ ok: true });
}
