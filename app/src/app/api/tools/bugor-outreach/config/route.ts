import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET() {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const { data, error } = await supabaseAdmin
    .from('bugor_outreach_config')
    .select('key, value');

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const config: Record<string, string> = {};
  for (const row of data ?? []) {
    config[row.key] = row.value;
  }

  return NextResponse.json({ config });
}

export async function PATCH(req: NextRequest) {
  if (!supabaseAdmin) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const body = await req.json();
  const updates: Array<{ key: string; value: string }> = [];

  const ALLOWED_KEYS = [
    'instantly_campaign_id',
    'sender_name',
    'sender_calendly',
    'sender_website',
    'auto_upload_enabled',
  ];

  for (const [key, value] of Object.entries(body)) {
    if (ALLOWED_KEYS.includes(key) && typeof value === 'string') {
      updates.push({ key, value });
    }
  }

  if (updates.length === 0) {
    return NextResponse.json({ error: 'No valid keys to update' }, { status: 400 });
  }

  for (const { key, value } of updates) {
    await supabaseAdmin
      .from('bugor_outreach_config')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  }

  return NextResponse.json({ ok: true, updated: updates.map((u) => u.key) });
}
