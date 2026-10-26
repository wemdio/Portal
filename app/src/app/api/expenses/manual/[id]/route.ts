import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { checkManualOwner, humanizeManualError } from '@/lib/expenses/manual';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  isUuid,
  parseAmount,
  parseCurrency,
  parseLinks,
  parseOccurredOn,
  readJsonBody,
} from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

/** Правка и удаление ручной траты — только автор или админ (см. checkManualOwner). */
export async function PATCH(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const denied = await checkManualOwner('manual_expenses', id, guard.userId, guard.role);
  if (denied) return denied;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  /** undefined — вендор не трогаем, null — снять разметку, строка — разметить. */
  let vendorId: string | null | undefined;
  try {
    const body = await readJsonBody<{
      occurredOn?: string;
      amount?: number;
      currency?: string;
      payer?: string;
      comment?: string;
      vendorId?: string | null;
      projectId?: string | null;
      amoDealId?: number | null;
    }>(req);

    if (body.occurredOn !== undefined) patch.occurred_on = parseOccurredOn(body.occurredOn);
    if (body.amount !== undefined) patch.amount = parseAmount(body.amount);
    if (body.currency !== undefined) patch.currency = parseCurrency(body.currency);
    // Пустой плательщик не сохраняем: колонка NOT NULL, а дефолт подставляет
    // только вставка.
    if (body.payer !== undefined && body.payer.trim()) patch.payer = body.payer.trim();
    if (body.comment !== undefined) patch.comment = body.comment.trim() || null;
    const links = parseLinks(body);
    if (links.projectId !== undefined) patch.project_id = links.projectId;
    if (links.amoDealId !== undefined) patch.amo_deal_id = links.amoDealId;
    if (body.vendorId !== undefined) {
      if (body.vendorId !== null && body.vendorId !== '' && !isUuid(body.vendorId)) {
        throw new Error('vendorId: ожидается UUID');
      }
      vendorId = body.vendorId || null;
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { error } = await supabaseAdmin.from('manual_expenses').update(patch).eq('id', id);
  if (error) return NextResponse.json({ error: humanizeManualError(error.message) }, { status: 500 });

  // Вендор ручной траты — это её разметка, как у банковской операции. Снятый
  // вендор возвращает трату в очередь разметки.
  if (vendorId !== undefined) {
    const { error: classifyError } = vendorId
      ? await supabaseAdmin.from('expense_classifications').upsert(
          {
            source: 'manual',
            source_ref: id,
            vendor_id: vendorId,
            method: 'manual',
            classified_by: guard.userId,
          },
          { onConflict: 'source,source_ref' },
        )
      : await supabaseAdmin.from('expense_classifications').delete().eq('source', 'manual').eq('source_ref', id);
    if (classifyError) {
      return NextResponse.json(
        { error: `Трата сохранена, но вендор не обновился: ${classifyError.message}` },
        { status: 500 },
      );
    }
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest, ctx: Ctx) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });

  const { id } = await ctx.params;
  const denied = await checkManualOwner('manual_expenses', id, guard.userId, guard.role);
  if (denied) return denied;
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { error } = await supabaseAdmin.from('manual_expenses').delete().eq('id', id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
