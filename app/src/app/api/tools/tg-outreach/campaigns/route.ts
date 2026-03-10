import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';
import { DEFAULT_OPENAI_SETTINGS, DEFAULT_TELEGRAM_SETTINGS } from '@/lib/tgOutreach/types';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;
  const { supabase } = auth;

  const { data, error } = await supabase
    .from('tg_outreach_campaigns')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;
  const { supabase, user } = auth;

  let body: { name?: string; openai_settings?: Record<string, unknown>; telegram_settings?: Record<string, unknown> };
  try {
    body = await req.json();
  } catch {
    return jsonError('Неверный JSON', 400);
  }

  const name = body.name?.trim();
  if (!name) return jsonError('Название кампании обязательно', 400);

  const { data, error } = await supabase
    .from('tg_outreach_campaigns')
    .insert({
      user_id: user.id,
      name,
      status: 'stopped',
      openai_settings: body.openai_settings ?? DEFAULT_OPENAI_SETTINGS,
      telegram_settings: body.telegram_settings ?? DEFAULT_TELEGRAM_SETTINGS,
    })
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data, { status: 201 });
}
