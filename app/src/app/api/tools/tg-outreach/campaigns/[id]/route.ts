import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/tgOutreach/apiHelpers';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await authenticateRequest(req.headers.get('authorization'));
  if ('error' in auth) return auth.error;
  const { id } = await ctx.params;

  const { data, error } = await auth.supabase
    .from('tg_outreach_campaigns')
    .select('*')
    .eq('id', id)
    .single();

  if (error) return jsonError(error.code === 'PGRST116' ? 'Кампания не найдена' : error.message, error.code === 'PGRST116' ? 404 : 500);
  return NextResponse.json(data);
}

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

  const allowed = ['name', 'openai_settings', 'telegram_settings'] as const;
  const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
  for (const key of allowed) {
    if (body[key] !== undefined) update[key] = body[key];
  }

  const { data, error } = await auth.supabase
    .from('tg_outreach_campaigns')
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

  const { error } = await auth.supabase
    .from('tg_outreach_campaigns')
    .delete()
    .eq('id', id);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
