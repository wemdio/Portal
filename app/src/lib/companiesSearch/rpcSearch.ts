import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getRegionByCode } from '@/lib/companiesSearch/regions';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';

function filtersToRpcParams(body: CompaniesSearchFilters) {
  let regionTokens: string[] | null = null;
  if (body.regionCodes && body.regionCodes.length > 0) {
    const tokens: string[] = [];
    for (const code of body.regionCodes) {
      const r = getRegionByCode(code);
      if (r) for (const t of r.matchTokens) tokens.push(t);
    }
    if (tokens.length > 0) regionTokens = tokens;
  }

  return {
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
  };
}

export async function searchCount(
  body: CompaniesSearchFilters,
): Promise<{ count: number; error?: string }> {
  const admin = supabaseAdmin!;
  const params = filtersToRpcParams(body);
  const { data, error } = await admin.rpc('companies_directory_count_rpc', params);
  if (error) return { count: 0, error: error.message };
  return { count: Number(data) ?? 0 };
}

export async function searchRows(
  body: CompaniesSearchFilters,
  limit: number,
  offset: number = 0,
): Promise<{ rows: Record<string, unknown>[]; error?: string }> {
  const admin = supabaseAdmin!;
  const params = filtersToRpcParams(body);
  const { data, error } = await admin.rpc('companies_directory_fetch_rpc', {
    ...params,
    p_limit: limit,
    p_offset: offset,
  });
  if (error) return { rows: [], error: error.message };
  return { rows: (data as unknown as Record<string, unknown>[]) ?? [] };
}
