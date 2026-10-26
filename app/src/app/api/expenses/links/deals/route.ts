import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { requireExpensesAccess } from '@/lib/expenses/access';
import type { DealOption } from '@/lib/expenses/types';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const LIMIT = 20;

/**
 * Поиск сделки AMO для привязки ручной записи — по зеркалу `amo_leads`
 * (ночной синк). Число в запросе — это номер сделки из адреса в AMO, текст —
 * часть названия сделки или компании.
 */
export async function GET(req: NextRequest) {
  const guard = await requireExpensesAccess(req);
  if (!guard.ok) return NextResponse.json({ error: guard.error }, { status: guard.status });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  // Символы-разделители фильтра PostgREST (запятая, скобки) и маски ilike
  // ломали бы `or(...)` или искали бы не то — для поиска по названию они не нужны.
  const q = (req.nextUrl.searchParams.get('q') ?? '').replace(/[,()*%_\\]/g, ' ').trim().slice(0, 100);
  if (q.length < 2) return NextResponse.json({ items: [] });

  let query = supabaseAdmin
    .from('amo_leads')
    .select('amo_id, name, company_name, pipeline_name, status_name')
    .order('updated_at', { ascending: false, nullsFirst: false })
    .limit(LIMIT);
  query = /^\d+$/.test(q)
    ? query.eq('amo_id', Number(q))
    : query.or(`name.ilike.*${q}*,company_name.ilike.*${q}*`);

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const items: DealOption[] = (data ?? []).map((d) => ({
    amoId: Number(d.amo_id),
    name: (d.name as string | null) ?? null,
    company: (d.company_name as string | null) ?? null,
    pipeline: (d.pipeline_name as string | null) ?? null,
    status: (d.status_name as string | null) ?? null,
  }));
  return NextResponse.json({ items });
}
