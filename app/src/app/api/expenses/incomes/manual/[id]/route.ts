import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { checkManualOwner, humanizeManualError } from '@/lib/expenses/manual';
import {
  parseAmount,
  parseChannel,
  parseCurrency,
  parseIncomeComment,
  parseIncomePayer,
  parseLinks,
  parseOccurredOn,
  readJsonBody,
} from '@/lib/expenses/request';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Правка и удаление ручного дохода — только автор или админ (см. checkManualOwner). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const denied = await checkManualOwner('manual_incomes', id, guard.userId, guard.role);
  if (denied) return denied;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  try {
    const body = await readJsonBody<{
      occurredOn?: string;
      amount?: number;
      currency?: string;
      payer?: string;
      channel?: string;
      comment?: string;
      projectId?: string | null;
      amoDealId?: number | null;
    }>(req);

    if (body.occurredOn !== undefined) patch.occurred_on = parseOccurredOn(body.occurredOn);
    if (body.amount !== undefined) patch.amount = parseAmount(body.amount);
    if (body.currency !== undefined) patch.currency = parseCurrency(body.currency);
    if (body.payer !== undefined) patch.payer = parseIncomePayer(body.payer);
    if (body.channel !== undefined) patch.channel = parseChannel(body.channel);
    if (body.comment !== undefined) patch.comment = parseIncomeComment(body.comment);
    const links = parseLinks(body);
    if (links.projectId !== undefined) patch.project_id = links.projectId;
    if (links.amoDealId !== undefined) patch.amo_deal_id = links.amoDealId;
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('manual_incomes').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: humanizeManualError(error.message) }, { status: 500 });

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const denied = await checkManualOwner('manual_incomes', id, guard.userId, guard.role);
  if (denied) return denied;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { error } = await supabaseAdmin.from('manual_incomes').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
