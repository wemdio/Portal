import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { safeEqual } from '@/lib/crypto/safeEqual';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listInstantlyAccounts, resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { mskDayWindowUtc, toMskIso } from '@/lib/instantly/activity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Partner pull-API: email activity (opens + replies) for a given day.
 *
 *   GET /api/partner/activity?date=YYYY-MM-DD            (MSK calendar day)
 *   GET /api/partner/activity?from=YYYY-MM-DD&to=YYYY-MM-DD
 *   Authorization: Bearer <PARTNER_API_KEY>   (or header  X-Api-Key: <key>)
 *
 *   Optional: &type=opened|replied   &distinct=1   (unique active emails only)
 *
 * Serves entirely from instantly_activity_events (populated by the webhook
 * receiver) → zero Instantly API calls. Scoped to a single account via
 * PARTNER_ACTIVITY_ACCOUNT_ID (defaults to the first non-main account), so the
 * partner can only ever see their own workspace's activity.
 *
 * Timestamps (`at`) are returned in MSK (+03:00); the `date` filter is a MSK day.
 */

const MAX_ROWS = 50_000;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function resolvePartnerAccountId(): string {
  const env = (process.env.PARTNER_ACTIVITY_ACCOUNT_ID || '').trim();
  if (env) return resolveInstantlyAccountId(env);
  const accounts = listInstantlyAccounts();
  const nonDefault = accounts.find((a) => !a.isDefault);
  return nonDefault?.id ?? 'main';
}

export async function GET(req: NextRequest) {
  if (!supabaseAdmin) return jsonError('Server misconfigured', 503);

  const expected = (process.env.PARTNER_API_KEY || '').trim();
  if (!expected) return jsonError('Partner API not configured', 503);

  const auth = req.headers.get('authorization') || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  const key = bearer || (req.headers.get('x-api-key') || '').trim();
  if (!key || !safeEqual(key, expected)) return jsonError('Unauthorized', 401);

  const sp = req.nextUrl.searchParams;
  const dateParam = sp.get('date')?.trim();
  const fromParam = sp.get('from')?.trim();
  const toParam = sp.get('to')?.trim();
  const typeParam = sp.get('type')?.trim().toLowerCase();
  const distinct = sp.get('distinct') === '1' || sp.get('distinct') === 'true';

  let startUtc: string;
  let endUtc: string;
  let label: Record<string, string>;

  if (dateParam) {
    const w = mskDayWindowUtc(dateParam);
    if (!w) return jsonError('Параметр date должен быть в формате YYYY-MM-DD', 400);
    startUtc = w.startUtc;
    endUtc = w.endUtc;
    label = { date: dateParam };
  } else if (fromParam && toParam) {
    const a = mskDayWindowUtc(fromParam);
    const b = mskDayWindowUtc(toParam);
    if (!a || !b) return jsonError('from/to должны быть в формате YYYY-MM-DD', 400);
    if (a.startUtc > b.startUtc) return jsonError('from не может быть позже to', 400);
    startUtc = a.startUtc;
    endUtc = b.endUtc;
    label = { from: fromParam, to: toParam };
  } else {
    return jsonError('Укажите ?date=YYYY-MM-DD (МСК) или ?from=YYYY-MM-DD&to=YYYY-MM-DD', 400);
  }

  const accountId = resolvePartnerAccountId();

  let query = supabaseAdmin
    .from('instantly_activity_events')
    .select('lead_email,event_type,occurred_at')
    .eq('instantly_account_id', accountId)
    .gte('occurred_at', startUtc)
    .lt('occurred_at', endUtc)
    .order('occurred_at', { ascending: true })
    .limit(MAX_ROWS);

  if (typeParam === 'opened' || typeParam === 'replied') {
    query = query.eq('event_type', typeParam);
  }

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  const rows = (data ?? []) as Array<{ lead_email: string; event_type: string; occurred_at: string }>;
  const truncated = rows.length >= MAX_ROWS;

  if (distinct) {
    const emails = [...new Set(rows.map((r) => r.lead_email))];
    return NextResponse.json({ account: accountId, ...label, count: emails.length, truncated, emails });
  }

  const events = rows.map((r) => ({
    email: r.lead_email,
    type: r.event_type,
    at: toMskIso(r.occurred_at),
  }));
  return NextResponse.json({ account: accountId, ...label, count: events.length, truncated, events });
}
