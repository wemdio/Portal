import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { parseAmount, parseCurrency, parseOccurredOn, readJsonBody } from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/**
 * Править и удалять может автор записи либо админ. Ручной ввод без правки
 * превращается в append-only свалку: опечатку в сумме иначе можно починить
 * только SQL-запросом, то есть на практике никогда.
 */
async function loadOwned(id: string, userId: string, role: string | null) {
  if (!supabaseAdmin) return { error: NextResponse.json({ error: 'Server misconfigured' }, { status: 500 }) };

  const { data, error } = await supabaseAdmin
    .from('manual_expenses')
    .select('created_by')
    .eq('id', id)
    .maybeSingle();

  if (error) return { error: NextResponse.json({ error: error.message }, { status: 500 }) };
  if (!data) return { error: NextResponse.json({ error: 'Запись не найдена' }, { status: 404 }) };
  if (data.created_by !== userId && role !== 'admin') {
    return { error: NextResponse.json({ error: 'Можно менять только свои записи' }, { status: 403 }) };
  }
  return { error: null };
}

export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const owned = await loadOwned(id, guard.userId, guard.role);
  if (owned.error) return owned.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  try {
    const body = await readJsonBody<{
      occurredOn?: string;
      amount?: number;
      currency?: string;
      comment?: string;
    }>(req);

    if (body.occurredOn !== undefined) patch.occurred_on = parseOccurredOn(body.occurredOn);
    if (body.amount !== undefined) patch.amount = parseAmount(body.amount);
    if (body.currency !== undefined) patch.currency = parseCurrency(body.currency);
    if (body.comment !== undefined) patch.comment = body.comment.trim() || null;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('manual_expenses').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const owned = await loadOwned(id, guard.userId, guard.role);
  if (owned.error) return owned.error;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { error } = await supabaseAdmin.from('manual_expenses').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
