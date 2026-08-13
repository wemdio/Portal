import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireAdmin } from '@/lib/adminAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { ValidationError, parsePatchInput } from '@/lib/techCalendar/validate';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Как в `expenses/manual/[id]/route.ts`: сначала убедиться, что строка есть, потом её менять. */
async function loadExisting(id: string) {
  if (!supabaseAdmin) return { error: NextResponse.json({ error: 'Server misconfigured' }, { status: 500 }) };

  const { data, error } = await supabaseAdmin
    .from('tech_subscriptions')
    .select('id')
    .eq('id', id)
    .maybeSingle();

  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!data) return { error: NextResponse.json({ error: 'Сервис не найден' }, { status: 404 }) };
  return { error: null };
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  const existing = await loadExisting(id);
  if (existing.error) return existing.error;

  let patch;
  try {
    patch = parsePatchInput((await req.json()) as Record<string, unknown>);
  } catch (e) {
    if (e instanceof ValidationError) return NextResponse.json({ error: e.message }, { status: 400 });
    return NextResponse.json({ error: 'Не разобрал тело запроса' }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('tech_subscriptions').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireAdmin(req);
  if ('error' in guard) return guard.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await ctx.params;

  const existing = await loadExisting(id);
  if (existing.error) return existing.error;

  const { error } = await supabaseAdmin.from('tech_subscriptions').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
