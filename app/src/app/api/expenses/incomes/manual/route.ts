import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import { attachLinks, humanizeManualError, MANUAL_INCOME_FIELDS } from '@/lib/expenses/manual';
import { parseRange } from '@/lib/expenses/period';
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

/**
 * Ручной доход: деньги из источников, которые не синкаются (наличные, личная
 * карта и т.п.). В витрину `incomes_v` попадает с source=manual и всегда как
 * выручка — см. 20261026_0100_manual_incomes.sql.
 */

const LIST_LIMIT = 500;

interface ManualIncomeBody {
  occurredOn?: string;
  amount?: number;
  currency?: string;
  payer?: string;
  channel?: string;
  comment?: string;
  projectId?: string | null;
  amoDealId?: number | null;
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
    .from('manual_incomes')
    .select(MANUAL_INCOME_FIELDS)
    .gte('occurred_on', range.from)
    .lte('occurred_on', range.to)
    .order('occurred_on', { ascending: false })
    .limit(LIST_LIMIT);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  try {
    return NextResponse.json({ items: await attachLinks(data ?? []) });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  let row: Record<string, unknown>;
  try {
    const body = await readJsonBody<ManualIncomeBody>(req);
    const links = parseLinks(body);
    row = {
      occurred_on: parseOccurredOn(body.occurredOn),
      amount: parseAmount(body.amount),
      currency: parseCurrency(body.currency ?? 'RUB'),
      payer: parseIncomePayer(body.payer),
      channel: parseChannel(body.channel),
      comment: parseIncomeComment(body.comment),
      project_id: links.projectId ?? null,
      amo_deal_id: links.amoDealId ?? null,
      created_by: guard.userId,
    };
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from('manual_incomes')
    .insert(row)
    .select(MANUAL_INCOME_FIELDS)
    .single();

  if (error) return NextResponse.json({ error: humanizeManualError(error.message) }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
