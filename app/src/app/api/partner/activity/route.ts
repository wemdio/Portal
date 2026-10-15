import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { safeEqual } from '@/lib/crypto/safeEqual';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { listInstantlyAccounts, resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { mskDayWindowUtc, toMskIso } from '@/lib/instantly/activity';
import { readHeEngCampaignIds } from '@/lib/hypothesisEngine/engCampaignSending';

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
 * PARTNER_ACTIVITY_ACCOUNT_ID (defaults to the first non-main account).
 *
 * The account is a whole Instantly workspace, and that workspace is SHARED:
 * the English cabinet's sending pool (lib/hypothesisEngine/sendingPool.ts,
 * HE_US_POOL_WORKSPACE, default 'account-2') sends from mailboxes in it, and
 * the webhook stores replies to ENG campaigns in the same feed. So the account
 * filter alone does NOT make this the partner's own activity. Events of ENG
 * cabinet campaigns are dropped here (engCampaignSending.readHeEngCampaignIds):
 *  - every campaign id in the launch records (he_templates.launch_info) of
 *    market 'us' projects that belong to the English cabinet — the owner's
 *    profile has market 'eng' (or no longer exists), or the project was given
 *    pool mailboxes. This is the list Pause, staff «turn off sending», Block
 *    and the blocked sweep use;
 *  - campaigns of any other 'us' project launched with a preset that an ENG
 *    project launched with (that preset is the client's pool mailboxes);
 *  - the ENG status cache he_eng_campaign_status.
 * Market 'us' projects that staff run for someone else (not a cabinet
 * account, no pool mailboxes, not an ENG preset) are NOT excluded: their
 * campaigns may be the partner's own. If the list cannot be read, the route
 * answers 503 instead of serving unfiltered rows. Events without a campaign
 * id are served as before. Everything else about the partner's own data is
 * unchanged.
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

  // Кампании ENG-кабинета — до чтения ленты: без полного списка исключений
  // строки не отдаём (см. шапку).
  const engCampaigns = await readHeEngCampaignIds(supabaseAdmin);
  if (!engCampaigns.ok) {
    console.warn(`[partner-activity] ENG campaign ids unreadable — refused: ${engCampaigns.error}`);
    return jsonError('Activity is temporarily unavailable, try again later', 503);
  }

  let query = supabaseAdmin
    .from('instantly_activity_events')
    .select('lead_email,event_type,occurred_at,campaign_id')
    .eq('instantly_account_id', accountId)
    .in('event_type', ['opened', 'replied'])
    .gte('occurred_at', startUtc)
    .lt('occurred_at', endUtc)
    .order('occurred_at', { ascending: true })
    .limit(MAX_ROWS);

  if (typeParam === 'opened' || typeParam === 'replied') {
    query = query.eq('event_type', typeParam);
  }

  const { data, error } = await query;
  if (error) return jsonError(error.message, 500);

  const fetched = (data ?? []) as Array<{
    lead_email: string;
    event_type: string;
    occurred_at: string;
    campaign_id: string | null;
  }>;
  // truncated — по прочитанным строкам: лимит отрезал ленту до фильтра ENG.
  const truncated = fetched.length >= MAX_ROWS;
  const rows = fetched.filter((r) => !(r.campaign_id && engCampaigns.ids.has(r.campaign_id)));

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
