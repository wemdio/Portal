import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * GET — возвращает список доступных report_year в БД для рендера селектора.
 *
 * Через RPC get_fns_revenue_years (миграция 20260514_0003): PostgREST
 * не умеет SELECT DISTINCT, а попытка достать года через select+limit
 * берёт N произвольных строк (на 2M строк одного года → все одинаковые).
 * Функция делает array_agg(distinct ...) на стороне Postgres.
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

  const { data, error } = await supabaseAdmin.rpc('get_fns_revenue_years');
  if (error) return jsonError(`Database error: ${error.message}`, 500);

  // RPC возвращает integer[] уже отсортированный desc. Защищаемся от null.
  const years = Array.isArray(data) ? (data as number[]) : [];
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

  // Запрос разбивается на под-чанки по ИНН: .in('inn', [...]) превращается
  // в GET-фильтр PostgREST (inn=in.(...)). На 500+ ИНН строка запроса
  // вырастает до ~7KB и может упереться в лимит URI у Kong/PostgREST на
  // self-hosted Supabase → 500/414, и колонки в UI останутся пустыми.
  // 200 ИНН на чанк — безопасный размер с большим запасом.
  const IN_CHUNK = 200;
  type FnsRow = {
    inn: string;
    org_name: string;
    income: number;
    expense: number;
    report_year: number;
  };
  const rows: FnsRow[] = [];
  for (let i = 0; i < cleanedInns.length; i += IN_CHUNK) {
    const chunk = cleanedInns.slice(i, i + IN_CHUNK);
    let query = supabaseAdmin
      .from('fns_revenue')
      .select('inn, org_name, income, expense, report_year')
      .in('inn', chunk);
    if (yearsFilter) query = query.in('report_year', yearsFilter);
    const { data, error } = await query;
    if (error) return jsonError(`Database error: ${error.message}`, 500);
    if (data) rows.push(...(data as FnsRow[]));
  }

  const results: Record<
    string,
    Record<number, { org_name: string; income: number; expense: number }>
  > = {};
  const yearsSeen = new Set<number>();
  for (const row of rows) {
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
