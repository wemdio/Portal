import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyTelegramLinkToken } from '@/lib/telegram';
import { TELEGRAM_BOT_TOKEN } from '@/lib/constants';
import { isInternalRole } from '@/lib/roles';
import type { UserRole } from '@/types';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  let body: { link_token?: string };
  try {
    body = (await req.json()) as { link_token?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  if (!body?.link_token || typeof body.link_token !== 'string') {
    return jsonError('Missing link_token', 400);
  }

  if (!TELEGRAM_BOT_TOKEN) return jsonError('Telegram bot token is not configured', 500);

  const verified = verifyTelegramLinkToken(body.link_token, TELEGRAM_BOT_TOKEN);
  if (!verified.ok) return jsonError(verified.error, 401);

  if (!supabaseAdmin) return jsonError('Linking is not configured', 500);

  // telegram_links feeds the Telegram agent, which runs service-role SQL over every
  // table. Only internal non-demo staff may link (same rule as the middleware staff
  // API gate). LoginForm only logs a failed link, so a client's Mini App login goes on.
  const { data: actor, error: actorError } = await supabaseAdmin
    .from('profiles')
    .select('role, is_demo')
    .eq('id', user.id)
    .maybeSingle();
  if (actorError) return jsonError(actorError.message, 500);
  const actorRole = (actor?.role ?? null) as UserRole | null;
  if (!actor || !isInternalRole(actorRole) || actor.is_demo === true) {
    return jsonError('Telegram linking is available to staff only', 403);
  }

  const telegramId = verified.payload.telegram_id;

  const { data: existingByTelegram, error: byTelegramError } = await supabaseAdmin
    .from('telegram_links')
    .select('user_id, telegram_id')
    .eq('telegram_id', telegramId)
    .maybeSingle();
  if (byTelegramError) return jsonError(byTelegramError.message, 500);
  if (existingByTelegram && existingByTelegram.user_id !== user.id) {
    return jsonError('Telegram account already linked to another user', 409);
  }

  const { data: existingByUser, error: byUserError } = await supabaseAdmin
    .from('telegram_links')
    .select('user_id, telegram_id')
    .eq('user_id', user.id)
    .maybeSingle();
  if (byUserError) return jsonError(byUserError.message, 500);
  if (existingByUser && String(existingByUser.telegram_id) !== telegramId) {
    return jsonError('User already linked to another Telegram account', 409);
  }

  if (!existingByUser) {
    const { error: insertError } = await supabaseAdmin
      .from('telegram_links')
      .insert({ user_id: user.id, telegram_id: telegramId });
    if (insertError) return jsonError(insertError.message, 500);
  }

  return NextResponse.json({ ok: true, linked: true, telegram_id: telegramId });
}
