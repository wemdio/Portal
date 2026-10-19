import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { sendDemoLeadTelegramAlert, type DemoLeadAgentHints, type DemoLeadPageLang } from '@/lib/demoLead/notify';

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
 *
 * `lang` — the language version of the landing the form was sent from
 * (outreachos.xyz /en/ or /ru/). Only "en" and "ru" are kept, anything else is
 * ignored; it is stored in demo_leads.utm as key `lang` (no column of its own) and
 * shown in the Telegram alert as «🌐 Язык страницы». Callers that do not send it are
 * unchanged.
 *
 * So a non-null demo_leads.utm no longer means the lead came with attribution: every
 * lead from the /en/ and /ru/ pages has at least {"lang": "en"|"ru"}. The column
 * comment written by 20261013_0001 («Null for leads without attribution») predates
 * this. To count leads with campaign tags, test the keys, not the null:
 * `utm ?| array['utm_source','utm_medium','utm_campaign','utm_term','utm_content']`;
 * with any attribution: `utm - 'lang' <> '{}'::jsonb`. Until 20261013_0001 is applied,
 * these leads take the insert retry without utm below, and their language stays only
 * in the Telegram alert.
 *
 * The outreachos.xyz form also works as a plain HTML form (method="post" with
 * hidden source/lang): with no page script — or when a buyer's AI agent submits the
 * form as it reads it — the browser posts the form's own names website/email/goal,
 * which are read as name+company/email/message when those are empty. A top-level
 * form navigation gets a 303 back to the page (FORM_RETURN_URL); fetch() and HTTP
 * clients keep getting JSON. Signs that an AI agent sent the lead (agentHints) go to
 * the Telegram alert only; demo_leads does not store them.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Best-effort per-instance rate limit (public, unauthenticated endpoint).
const WINDOW_MS = 60_000;
const MAX_HITS = 20;
// Past this many tracked addresses, idle ones are dropped before the next count.
const HITS_PRUNE_AT = 5_000;
const hits = new Map<string, number[]>();

// The rate-limit key. nginx sets X-Real-IP from $remote_addr (deploy/nginx/*.conf);
// the FIRST X-Forwarded-For entry is whatever the client sent, so a random value there
// used to give every request a fresh bucket. Same rule as /api/signup (signupClientIp).
function clientIp(req: NextRequest): string {
  const real = req.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const hops = (req.headers.get('x-forwarded-for') ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  return hops[hops.length - 1] || 'unknown';
}

function rateLimited(ip: string): boolean {
  const now = Date.now();
  if (hits.size > HITS_PRUNE_AT) {
    for (const [key, times] of hits) if (now - times[times.length - 1] >= WINDOW_MS) hits.delete(key);
  }
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  return recent.length > MAX_HITS;
}

// Lead surfaces allowed to label themselves; anything else is stored as 'unknown'
// so a client can't inject arbitrary text into the Telegram alert title.
// eng_pilot — форма «Check my niche» / «Проверить нишу» лендинга outreachos.xyz, одна и
// та же на страницах /en/ и /ru/ (deploy/static/outreachos.xyz); какая из них, говорит
// поле lang. name там — сайт компании.
const ALLOWED_SOURCES = new Set(['hero', 'demo', 'eng_pilot']);

interface LeadFields {
  name: string;
  email: string;
  phone: string;
  telegram: string;
  company: string;
  message: string;
  source: string;
  /** Attribution for demo_leads.utm, `lang` included when the form sent one. */
  utm: Record<string, string> | null;
  lang: DemoLeadPageLang | null;
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
// Lead fields come from strangers (and now from their AI agents) and go to the
// Telegram alert. Invisible marks — bidi controls (text that reads in a misleading
// order), zero-width characters, BOM — and lone surrogates are deleted from every
// field, so 'ivan<U+200B>@mail.ru' pasted from a page still validates as an email.
// In one-line fields the remaining control characters and line separators, newlines
// included (they could fake extra alert lines), become one space; the message keeps
// its line breaks (\r\n -> \n) and tabs and loses the rest. NUL is gone either way,
// so it can no longer fail the insert and leave the lead only in Telegram.
const INVISIBLE_MARKS = /[\p{Cs}\u061C\u200B\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/gu;
const LINE_BREAKS = /[\p{Cc}\u2028\u2029]+/gu;
const MESSAGE_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/gu;

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

// Language versions of the landing. The landing sends exactly "en" or "ru"; case and
// edge whitespace are forgiven, any other value is dropped and the lead goes on as one
// without a language.
const PAGE_LANG_MAX = 2;
function readLang(value: string): DemoLeadPageLang | null {
  const lang = bounded(value, PAGE_LANG_MAX).trim().toLowerCase();
  return lang === 'en' || lang === 'ru' ? lang : null;
}

async function readFields(req: NextRequest): Promise<LeadFields> {
  const ct = req.headers.get('content-type') ?? '';
  const get = (v: unknown) => (typeof v === 'string' ? v : '');
  let raw: Record<string, string>;
  let utm: Record<string, string> | null;
  let lang: DemoLeadPageLang | null;
  // website/goal are the outreachos.xyz form's own field names, which is what a plain
  // HTML post of it (no page script, or an agent submitting the form as it reads it)
  // sends. The page script maps them to name/company/message itself, so those win.
  if (ct.includes('application/json')) {
    const b = (await req.json()) as Record<string, unknown>;
    raw = {
      name: get(b.name) || get(b.website), email: get(b.email), phone: get(b.phone), telegram: get(b.telegram),
      company: get(b.company) || get(b.website), message: get(b.message) || get(b.goal), source: get(b.source),
    };
    utm = readUtm((k) => get(b[k]));
    lang = readLang(get(b.lang));
  } else {
    const fd = await req.formData();
    const f = (k: string) => String(fd.get(k) ?? '');
    raw = {
      name: f('name') || f('website'), email: f('email'), phone: f('phone'), telegram: f('telegram'),
      company: f('company') || f('website'), message: f('message') || f('goal'), source: f('source'),
    };
    utm = readUtm((k) => get(fd.get(k)));
    lang = readLang(get(fd.get('lang')));
  }
  // Stored with the attribution (demo_leads.utm.lang), so a lead without utm_* values
  // still keeps its page language — and its utm is then non-null (see the header).
  if (lang) utm = { ...utm, lang };
  const field = (k: keyof typeof FIELD_MAX) => {
    const value = bounded(raw[k], FIELD_MAX[k]);
    return (k === 'message'
      ? value.replace(INVISIBLE_MARKS, '').replace(/\r\n?/g, '\n').replace(MESSAGE_CONTROLS, '')
      : value.replace(INVISIBLE_MARKS, '').replace(LINE_BREAKS, ' ')
    ).trim();
  };
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
    lang,
  };
}

// After a plain HTML form post (the landing without its script) the browser goes back
// to the page: a fixed address per page language, never one taken from the request, so
// this is no open redirect. The fragment never reaches a server or the access log.
const FORM_RETURN_URL: Record<DemoLeadPageLang, string> = {
  en: 'https://outreachos.xyz/en/#sent',
  ru: 'https://outreachos.xyz/ru/#sent',
};
const LANDING_ORIGIN = 'https://outreachos.xyz';

/** A top-level browser form submission — not fetch(), XHR, curl or an agent's HTTP call. */
function isFormNavigation(req: NextRequest): boolean {
  const mode = req.headers.get('sec-fetch-mode');
  if (mode) return mode === 'navigate' && req.headers.get('sec-fetch-dest') === 'document';
  // No Fetch Metadata (Safari before 16.4): a browser navigation asks for HTML first and
  // always sends Origin on POST; HTTP clients that copy a browser Accept header do not.
  return req.headers.get('origin') === LANDING_ORIGIN && /^\s*text\/html/i.test(req.headers.get('accept') ?? '');
}

// Mailbox services that give AI agents their own address (2026-10). An alert-only hint
// for the team: a reply to such a lead goes to the agent, so ask for the person's email.
const AGENT_MAIL_DOMAINS = ['mail.grokbot.com', 'agentmail.to', 'mail.manus.ai', 'manus.bot', 'inbox.ai', 'nylas.email'];
const AGENT_UA_RE = /\b(GrokAgent|ChatGPT-User|Claude-User)\//;

/**
 * Signs that an AI agent sent the lead, for one line in the Telegram alert. Every one of
 * them can be faked (Web Bot Auth signatures included), so this labels and never gates,
 * and none of it is written to demo_leads: demo_leads.utm keeps its meaning (see the header).
 */
function agentHints(req: NextRequest, email: string): DemoLeadAgentHints | null {
  const hints: DemoLeadAgentHints = {};
  // Web Bot Auth: Signature-Agent names the signer's key directory, e.g. "https://chatgpt.com"
  // (ChatGPT agent) or "https://cursorusercontent.com" (Grok Bot). Not verified here.
  const signer = (req.headers.get('signature-agent') ?? '').slice(0, 300).match(/https:\/\/[^"\s,;]+/);
  if (signer) {
    try {
      const host = new URL(signer[0]).hostname.toLowerCase();
      if (/^[a-z0-9.-]{1,253}$/.test(host)) hints.signer = host;
    } catch { /* not a URL — no hint */ }
  }
  const domain = email.slice(email.lastIndexOf('@') + 1);
  const mail = AGENT_MAIL_DOMAINS.find((d) => domain === d || domain.endsWith(`.${d}`));
  if (mail) hints.mailbox = mail;
  const ua = (req.headers.get('user-agent') ?? '').slice(0, 500).match(AGENT_UA_RE);
  if (ua) hints.userAgent = ua[1];
  // Browsers always send Origin on POST: none and no Fetch Metadata means a direct HTTP client.
  if (!req.headers.get('origin') && !req.headers.get('sec-fetch-mode')) hints.httpClient = true;
  return Object.keys(hints).length ? hints : null;
}

// The app can roll out before migration 20261013_0001 adds demo_leads.utm. Then the
// insert is retried without utm so the lead is still stored; warn once per process.
// Every lead from the /en/ and /ru/ pages carries utm (at least lang), so all of them
// take this retry then, and the database loses their attribution and page language.
let utmColumnMissingWarned = false;
function isMissingUtmColumn(error: { code?: string; message?: string }): boolean {
  return (error.code === 'PGRST204' || error.code === '42703') && /\butm\b/.test(error.message ?? '');
}

export async function POST(req: NextRequest) {
  if (rateLimited(clientIp(req))) return NextResponse.json({ error: 'Too Many Requests' }, { status: 429 });

  let fields: LeadFields;
  try {
    fields = await readFields(req);
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }
  const { name, email, phone, telegram, company, message, source, utm, lang } = fields;

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
            'storing leads without utm (attribution and page language); the Telegram alert still shows them',
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
  const agent = agentHints(req, email);
  await sendDemoLeadTelegramAlert({
    name, email, phone: phone || null, telegram: telegram || null,
    company: company || null, message: message || null, source, referrer,
    ...(lang ? { pageLang: lang } : {}),
    ...(agent ? { agentHints: agent } : {}),
    ...(utm
      ? {
          utm,
          outsideReferrer: utm.referrer ?? null,
          landingUrl: utm.landing ?? null,
          utmEarlierVisitAt: utm.ts ?? null,
        }
      : {}),
  });

  if (isFormNavigation(req)) return NextResponse.redirect(FORM_RETURN_URL[lang ?? 'en'], 303);
  return NextResponse.json({ ok: true });
}
