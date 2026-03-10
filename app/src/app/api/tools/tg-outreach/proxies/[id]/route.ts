import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonError('Неверный JSON', 400);
  }

  const update: Record<string, unknown> = {};
  if (body.url !== undefined) update.url = body.url;
  if (body.name !== undefined) update.name = body.name;
  if (body.is_active !== undefined) update.is_active = body.is_active;

  if (Object.keys(update).length === 0) return jsonError('Нет полей для обновления', 400);

  const { data, error } = await auth.supabase
    .from('tg_outreach_proxies')
    .update(update)
    .eq('id', id)
    .select()
    .single();

  if (error) return jsonError(error.message, 500);
  return NextResponse.json(data);
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  await auth.supabase
    .from('tg_outreach_accounts')
    .update({ proxy_id: null })
    .eq('proxy_id', id);

  const { error } = await auth.supabase
    .from('tg_outreach_proxies')
    .delete()
    .eq('id', id);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
