import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

/**
 * Inbound webhook receiver for Instantly events (reply_received, etc.).
 * No Bearer auth — Instantly sends events to a public URL.
 * Validation is done via the shared INSTANTLY_WEBHOOK_SECRET query param.
 */
export async function POST(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const secret = process.env.INSTANTLY_WEBHOOK_SECRET ?? '';
  if (secret) {
    const url = new URL(req.url);
    const provided = url.searchParams.get('secret') ?? '';
    if (provided !== secret) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const eventType = String(
    payload.event_type ?? payload.event ?? payload.type ?? 'unknown',
  );

  const campaignId = extractString(payload, ['campaign_id', 'campaign']);
  const leadEmail = extractString(payload, ['lead_email', 'email', 'to_address_email']);
  const threadId = extractString(payload, ['thread_id']);
  const emailId = extractString(payload, ['email_id', 'id']);

  await supabaseAdmin.from('instantly_webhook_events').insert({
    event_type: eventType,
    campaign_id: campaignId,
    lead_email: leadEmail,
    thread_id: threadId,
    email_id: emailId,
    payload,
    processed: false,
  });

  return NextResponse.json({ ok: true });
}

function extractString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === 'string' && val.trim()) return val.trim();
    const nested = (obj.data ?? obj) as Record<string, unknown>;
    if (nested !== obj) {
      const nestedVal = nested[key];
      if (typeof nestedVal === 'string' && nestedVal.trim()) return nestedVal.trim();
    }
  }
  return null;
}
