import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getRegionByCode } from '@/lib/companiesSearch/regions';
import { reduceToTopCodes } from '@/lib/companiesSearch/okved2';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';

function filtersToRpcParams(body: CompaniesSearchFilters) {
  let regionCodes: string[] | null = null;
  let regionTokens: string[] | null = null;
  if (body.regionCodes && body.regionCodes.length > 0) {
    regionCodes = body.regionCodes;
    const tokens: string[] = [];
    for (const code of body.regionCodes) {
      const r = getRegionByCode(code);
      if (r) for (const t of r.matchTokens) tokens.push(t);
    }
    if (tokens.length > 0) regionTokens = tokens;
  }

  // Из дерева ОКВЭД пользователь выбирает узлы — сужаем до «топовых», чтобы
  // один префикс заменял всех потомков. Например, выбраны 24, 24.10, 24.10.2 →
  // на сервер уходит только ['24']: SQL фильтрует через LIKE '24.%', что
  // покрывает все вложенные коды.
  let okvedPrefixes: string[] | null = null;
  if (body.okvedCodes && body.okvedCodes.length > 0) {
    okvedPrefixes = reduceToTopCodes(new Set(body.okvedCodes));
    if (okvedPrefixes.length === 0) okvedPrefixes = null;
  }

  return {
    p_region_codes: regionCodes,
    p_region_tokens: regionTokens,
    p_activity_types: body.activityTypes?.length ? body.activityTypes : null,
    p_has_phone: body.hasPhone ?? false,
    p_has_email: body.hasEmail ?? false,
    p_legal_forms: body.legalForms?.length ? body.legalForms : null,
    p_has_website: body.hasWebsite ?? false,
    p_has_edo: body.hasEdo ?? false,
    p_has_egais: body.hasEgais ?? false,
    p_include_ip: body.includeIp !== false,
    p_revenue_from: typeof body.revenueFrom === 'number' ? body.revenueFrom : null,
    p_revenue_to: typeof body.revenueTo === 'number' ? body.revenueTo : null,
    p_cost_from: typeof body.costFrom === 'number' ? body.costFrom : null,
    p_cost_to: typeof body.costTo === 'number' ? body.costTo : null,
    p_employees_from: typeof body.employeesFrom === 'number' ? body.employeesFrom : null,
    p_employees_to: typeof body.employeesTo === 'number' ? body.employeesTo : null,
    p_inn_list: body.innList?.length ? body.innList : null,
    p_okved_prefixes: okvedPrefixes,
  };
}

const SEARCH_TIMEOUT_MS = 180_000;
const TIMEOUT_ERROR = 'Поиск занял слишком много времени — база данных перегружена. Попробуйте повторить через несколько секунд.';

type RpcResult<T> = { data: T; error: null } | { data: null; error: { message: string } };

function raceTimeout<T>(p: Promise<RpcResult<T>>): Promise<RpcResult<T>> {
  return Promise.race([
    p,
    new Promise<RpcResult<T>>((_, reject) =>
      setTimeout(() => reject(new Error(TIMEOUT_ERROR)), SEARCH_TIMEOUT_MS),
    ),
  ]);
}

export async function searchCount(
  body: CompaniesSearchFilters,
): Promise<{ count: number; error?: string }> {
  const admin = supabaseAdmin!;
  const params = filtersToRpcParams(body);
  try {
    const result = await raceTimeout<number>(
      Promise.resolve(admin.rpc('companies_directory_count_rpc', params)).then((r) => r as RpcResult<number>),
    );
    if (result.error) return { count: 0, error: result.error.message };
    return { count: Number(result.data) ?? 0 };
  } catch (e) {
    return { count: 0, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function searchRows(
  body: CompaniesSearchFilters,
  limit: number,
  offset: number = 0,
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const admin = supabaseAdmin!;
  const params = filtersToRpcParams(body);
  try {
    const result = await raceTimeout<Record<string, unknown>[]>(
      Promise.resolve(
        admin.rpc('companies_directory_fetch_rpc', { ...params, p_limit: limit, p_offset: offset }),
      ).then((r) => r as RpcResult<Record<string, unknown>[]>),
    );
    if (result.error) return { rows: [], error: result.error.message };
    return { rows: result.data ?? [] };
  } catch (e) {
    return { rows: [], error: e instanceof Error ? e.message : String(e) };
  }
}
