import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth } from '@/lib/clientApiHelper';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { isClientRepliesBotConfigured } from '@/lib/clientReplyBot/bot';

export const dynamic = 'force-dynamic';

/** Current connection status for the client's replies-Telegram binding. */
export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  const botConfigured = isClientRepliesBotConfigured();
  if (!supabaseInstantly) {
    return NextResponse.json({ bot_configured: botConfigured, linked: false, enabled: false });
  }

  const { data } = await supabaseInstantly
    .from('client_reply_telegram_links')
    .select('telegram_username, enabled')
    .eq('client_user_id', result.auth.userId)
    .maybeSingle();

  return NextResponse.json({
    bot_configured: botConfigured,
    linked: !!data,
    enabled: data?.enabled ?? false,
    telegram_username: data?.telegram_username ?? null,
  });
}

/** Disconnect: drop the binding entirely (client stops receiving reply DMs). */
export async function DELETE(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return NextResponse.json({ error: 'Not configured' }, { status: 500 });

  const { error } = await supabaseInstantly
    .from('client_reply_telegram_links')
    .delete()
    .eq('client_user_id', result.auth.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, linked: false });
}

/** Toggle notifications on/off without losing the binding. */
export async function PATCH(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return NextResponse.json({ error: 'Not configured' }, { status: 500 });

  let body: { enabled?: boolean };
  try {
    body = (await req.json()) as { enabled?: boolean };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled (boolean) required' }, { status: 400 });
  }

  const { error } = await supabaseInstantly
    .from('client_reply_telegram_links')
    .update({ enabled: body.enabled, updated_at: new Date().toISOString() })
    .eq('client_user_id', result.auth.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, enabled: body.enabled });
}
