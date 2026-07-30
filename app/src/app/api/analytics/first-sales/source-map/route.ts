import 'server-only';
import { NextRequest, NextResponse } from 'next/server';
import { requireFirstSalesAccess } from '@/lib/firstSales/access';
import { normalizeSource, type FirstSalesChannel } from '@/lib/firstSales/sourceChannels';

const CHANNELS: FirstSalesChannel[] = [
  'marketing', 'smm', 'outreach', 'partners',
  'tg_outreach', 'inbound', 'referral', 'events', 'unassigned',
];

export async function GET(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const { data, error } = await gate.supabaseAdmin
    .from('lead_source_channels')
    .select('id, source, channel, display_name, sort_order, updated_at')
    .order('sort_order');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ rows: data ?? [] });
}

export async function PUT(req: NextRequest) {
  const gate = await requireFirstSalesAccess(req);
  if ('error' in gate) return gate.error;

  const body = (await req.json().catch(() => null)) as
    | { source?: unknown; channel?: unknown; display_name?: unknown }
    | null;
  const source = normalizeSource(typeof body?.source === 'string' ? body.source : null);
  const channel = body?.channel;

  if (!source) return NextResponse.json({ error: 'Пустой source' }, { status: 400 });
  if (typeof channel !== 'string' || !CHANNELS.includes(channel as FirstSalesChannel)) {
    return NextResponse.json({ error: `Недопустимый channel: ${String(channel)}` }, { status: 400 });
  }

  const { error } = await gate.supabaseAdmin
    .from('lead_source_channels')
    .upsert(
      {
        source,
        channel,
        display_name: typeof body?.display_name === 'string' ? body.display_name : null,
        updated_by: gate.user.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'source' },
    );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
