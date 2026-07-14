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
    .select('telegram_username, enabled, leads_only')
    .eq('client_user_id', result.auth.userId)
    .maybeSingle();

  return NextResponse.json({
    bot_configured: botConfigured,
    linked: !!data,
    enabled: data?.enabled ?? false,
    leads_only: (data as { leads_only?: boolean | null } | null)?.leads_only ?? false,
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

/** Toggle notification settings (on/off, «только лиды») without losing the binding. */
export async function PATCH(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseInstantly) return NextResponse.json({ error: 'Not configured' }, { status: 500 });

  let body: { enabled?: boolean; leads_only?: boolean };
  try {
    body = (await req.json()) as { enabled?: boolean; leads_only?: boolean };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
  if (typeof body.leads_only === 'boolean') patch.leads_only = body.leads_only;
  if (!('enabled' in patch) && !('leads_only' in patch)) {
    return NextResponse.json({ error: 'enabled или leads_only (boolean) обязателен' }, { status: 400 });
  }

  const { error } = await supabaseInstantly
    .from('client_reply_telegram_links')
    .update(patch)
    .eq('client_user_id', result.auth.userId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true, ...('enabled' in patch ? { enabled: body.enabled } : {}), ...('leads_only' in patch ? { leads_only: body.leads_only } : {}) });
}
