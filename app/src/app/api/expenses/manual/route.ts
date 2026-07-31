import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { parseRange } from '@/lib/expenses/period';
import {
  isUuid,
  parseAmount,
  parseCurrency,
  parseOccurredOn,
  readJsonBody,
} from '@/lib/expenses/request';

export const dynamic = 'force-dynamic';

const LIST_LIMIT = 500;
const DEFAULT_PAYER = 'ceo_personal_card';

const MANUAL_FIELDS = 'id, occurred_on, amount, currency, payer, comment, created_by, created_at';

interface ManualBody {
  occurredOn?: string;
  amount?: number;
  currency?: string;
  payer?: string;
  comment?: string;
  vendorId?: string | null;
}

export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const params = req.nextUrl.searchParams;
  let range: { from: string; to: string };
  try {
    range = parseRange(params.get('from') ?? '', params.get('to') ?? '');
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('manual_expenses')
    .select(MANUAL_FIELDS)
    .gte('occurred_on', range.from)
    .lte('occurred_on', range.to)
    .order('occurred_on', { ascending: false })
    .limit(LIST_LIMIT);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ items: data ?? [] });
}

export async function POST(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let body: ManualBody;
  let occurredOn: string;
  let amount: number;
  let currency: string;
  try {
    body = await readJsonBody<ManualBody>(req);
    occurredOn = parseOccurredOn(body.occurredOn);
    amount = parseAmount(body.amount);
    currency = parseCurrency(body.currency ?? 'RUB');
    if (body.vendorId != null && !isUuid(body.vendorId)) {
      throw new Error('vendorId: ожидается UUID');
    }
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('manual_expenses')
    .insert({
      occurred_on: occurredOn,
      amount,
      currency,
      payer: body.payer?.trim() || DEFAULT_PAYER,
      comment: body.comment?.trim() || null,
      created_by: guard.userId,
    })
    .select(MANUAL_FIELDS)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Вендор выбирается прямо в форме, поэтому запись приходит уже размеченной
  // и в очередь разметки не попадает. Если разметка не проставилась, трата
  // всё равно сохранена и просто окажется в очереди — терять её нельзя.
  if (body.vendorId) {
    const { error: classifyError } = await supabaseAdmin.from('expense_classifications').upsert(
      {
        source: 'manual',
        source_ref: data.id,
        vendor_id: body.vendorId,
        method: 'manual',
        classified_by: guard.userId,
      },
      { onConflict: 'source,source_ref' },
    );
    if (classifyError) {
      console.warn(`[expenses] ручная трата ${data.id} сохранена, но не размечена: ${classifyError.message}`);
    }
  }

  return NextResponse.json(data, { status: 201 });
}
