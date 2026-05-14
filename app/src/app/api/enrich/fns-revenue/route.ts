import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET — возвращает список доступных report_year в БД для рендера селектора
 * в UI. Один запрос, кешируемый на стороне фронта.
 */
export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  const authed = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await authed.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  // DISTINCT report_year — на 2M записей через индекс idx_fns_revenue_year
  // занимает миллисекунды (index-only scan).
  const { data, error } = await supabaseAdmin
    .from('fns_revenue')
    .select('report_year')
    .order('report_year', { ascending: false })
    .limit(50); // годы редко выйдут за 5-10, 50 — sane cap

  if (error) return jsonError(`Database error: ${error.message}`, 500);
  const years = Array.from(new Set((data ?? []).map((r) => r.report_year as number))).sort(
    (a, b) => b - a,
  );
  return NextResponse.json({ years });
}

/**
 * POST — обогащение списка ИНН ФНС-данными.
 *
 * Запрос:
 *   { inns: string[], years?: number[] }
 *
 * Поведение по `years`:
 *   - undefined / empty → все доступные годы для запрошенных ИНН.
 *   - [year] → один год (старое поведение, обратная совместимость).
 *   - [year1, year2, ...] → несколько лет.
 *
 * Ответ:
 *   {
 *     results: { [inn]: { [year]: { org_name, income, expense } } },
 *     found: <число ИНН найденных хоть в одном году>,
 *     total: <число запрошенных ИНН>,
 *     years_returned: number[]   // какие года реально вернули
 *   }
 *
 * Старый формат `{ org_name, income, expense, report_year }` per inn
 * больше не возвращается — клиенты должны мигрировать на новый. UI
 * обновлён в этом же коммите.
 */
export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const authed = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await authed.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  let body: { inns?: string[]; years?: number[] };
  try {
    body = (await req.json()) as { inns?: string[]; years?: number[] };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const inns = body.inns ?? [];
  if (!Array.isArray(inns) || inns.length === 0) {
    return jsonError('No INNs provided', 400);
  }
  if (inns.length > 1000) {
    return jsonError('Too many INNs per batch (max 1000)', 400);
  }

  const cleanedInns = inns.map((inn) => String(inn).trim()).filter(Boolean);

  // Validate years[] если передан: только целые 2000..2100, иначе игнор.
  let yearsFilter: number[] | null = null;
  if (Array.isArray(body.years) && body.years.length > 0) {
    yearsFilter = body.years.filter(
      (y): y is number => typeof y === 'number' && Number.isInteger(y) && y >= 2000 && y <= 2100,
    );
    if (yearsFilter.length === 0) yearsFilter = null;
  }

  let query = supabaseAdmin
    .from('fns_revenue')
    .select('inn, org_name, income, expense, report_year')
    .in('inn', cleanedInns);
  if (yearsFilter) query = query.in('report_year', yearsFilter);

  const { data, error } = await query;
  if (error) return jsonError(`Database error: ${error.message}`, 500);

  const results: Record<
    string,
    Record<number, { org_name: string; income: number; expense: number }>
  > = {};
  const yearsSeen = new Set<number>();
  for (const row of data ?? []) {
    const inn = row.inn as string;
    const year = row.report_year as number;
    yearsSeen.add(year);
    if (!results[inn]) results[inn] = {};
    results[inn][year] = {
      org_name: row.org_name as string,
      income: Number(row.income),
      expense: Number(row.expense),
    };
  }

  return NextResponse.json({
    results,
    found: Object.keys(results).length,
    total: cleanedInns.length,
    years_returned: [...yearsSeen].sort((a, b) => b - a),
  });
}
