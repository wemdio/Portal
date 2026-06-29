import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { listInstantlyAccounts, resolveInstantlyAccountId } from '@/lib/instantly/accounts';
import { normalizeActivityEvent } from '@/lib/instantly/activity';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Instantly activity webhook receiver (push → our DB).
 *
 * POST /api/instantly/webhook/<accountId>?token=<INSTANTLY_WEBHOOK_SECRET>
 *
 * Registered once via /api/instantly/activity/register for events
 * email_opened + reply_received. Each delivered event is normalized and upserted
 * into instantly_activity_events; the partner API reads from there. No auth
 * signing exists on Instantly's side, so the shared secret lives in the URL.
 *
 * Idempotent: upsert on dedup_key. Instantly retries on non-2xx, so we return
 * 500 on a transient DB error (safe — retry re-upserts) and 200 once stored.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ account: string }> },
) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const secret = (process.env.INSTANTLY_WEBHOOK_SECRET || '').trim();
  if (!secret) {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }
  const token =
    req.nextUrl.searchParams.get('token') || req.headers.get('x-webhook-token') || '';
  if (token !== secret) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { account } = await ctx.params;
  const accountId = resolveInstantlyAccountId(account);
  if (!listInstantlyAccounts().some((a) => a.id === accountId)) {
    return NextResponse.json({ error: 'Unknown account' }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  // Instantly delivers one event per call, but accept a batch defensively.
  const items = Array.isArray(body) ? body : [body];
  const receivedAtIso = new Date().toISOString();

  const rows: Array<Record<string, unknown>> = [];
  // Real-time квалификация (additive, флаг INSTANTLY_WEBHOOK_DRAIN_ENABLED): для
  // reply-событий ДОПОЛНИТЕЛЬНО кладём строку в очередь instantly_webhook_events
  // (instantly-БД) — её разгребает drainWebhookQueue. Аналитический upsert ниже
  // не меняется; enqueue — отдельная независимая запись со своим try/catch.
  const replyQueueRows: Array<Record<string, unknown>> = [];
  const probe = (raw: Record<string, unknown>, k: string): string | null => {
    const v = raw[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    const nested = raw.data as Record<string, unknown> | undefined;
    const nv = nested?.[k];
    return typeof nv === 'string' && nv.trim() ? nv.trim() : null;
  };
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const norm = normalizeActivityEvent(item as Record<string, unknown>, accountId, receivedAtIso);
    if (!norm) continue; // irrelevant event (sent/clicked/…) or no lead email → ack, store nothing
    rows.push({
      instantly_account_id: accountId,
      event_type: norm.eventType,
      lead_email: norm.leadEmail,
      campaign_id: norm.campaignId,
      occurred_at: norm.occurredAt,
      dedup_key: norm.dedupKey,
      raw: item,
    });
    if (norm.eventType === 'replied' && norm.campaignId) {
      const raw = item as Record<string, unknown>;
      replyQueueRows.push({
        event_type: 'reply_received',
        campaign_id: norm.campaignId,
        lead_email: norm.leadEmail,
        thread_id: probe(raw, 'thread_id'),
        email_id: probe(raw, 'email_id'),
        payload: item,
        processed: false,
      });
    }
  }

  if (rows.length > 0) {
    const { error } = await supabaseAdmin
      .from('instantly_activity_events')
      .upsert(rows, { onConflict: 'dedup_key', ignoreDuplicates: true });
    if (error) {
      console.error(`[instantly-activity] upsert failed (account=${accountId}):`, error.message);
      // Non-2xx → Instantly retries; upsert is idempotent so the retry is safe.
      return NextResponse.json({ error: 'Storage error' }, { status: 500 });
    }
  }

  // Флаг-gated enqueue для real-time-разгребателя. Свой try/catch + отдельный
  // клиент (instantly-БД), чтобы НИКОГДА не менять 200/500-контракт аналитического
  // пути (он управляет retry-семантикой Instantly). Off by default.
  if (
    replyQueueRows.length > 0 &&
    supabaseInstantly &&
    ['1', 'true', 'yes', 'on'].includes((process.env.INSTANTLY_WEBHOOK_DRAIN_ENABLED ?? '').toLowerCase())
  ) {
    try {
      await supabaseInstantly.from('instantly_webhook_events').insert(replyQueueRows);
    } catch (err) {
      console.error(`[instantly-activity] queue enqueue failed (account=${accountId}):`, err);
    }
  }

  return NextResponse.json({ ok: true, stored: rows.length });
}
