import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getRegionByCode } from '@/lib/companiesSearch/regions';

export const dynamic = 'force-dynamic';

// Все поддерживаемые фильтры — только те, что соответствуют колонкам
// таблицы public.companies_directory (формат xlsx из PortalBazaBaz).
export interface CompaniesSearchFilters {
  // По регионам — массив кодов субъектов РФ.
  regionCodes?: string[];

  // По activity_type (текстовая категория из xlsx).
  activityTypes?: string[];

  // Контакты.
  hasPhone?: boolean;
  hasEmail?: boolean;

  // ОПФ — список префиксов name (например 'ООО', 'АО', 'ИП').
  legalForms?: string[];

  // Дополнительные данные.
  hasWebsite?: boolean;
  hasEdo?: boolean;
  hasEgais?: boolean;

  // Финансы.
  revenueFrom?: number | null;
  revenueTo?: number | null;
  costFrom?: number | null;
  costTo?: number | null;

  // Численность.
  employeesFrom?: number | null;
  employeesTo?: number | null;

  // Включить ИП (по префиксу name 'ИП ').
  includeIp?: boolean;

  // Поиск по списку ИНН.
  innList?: string[];

  // Только preview — не возвращать данные, только count.
  countOnly?: boolean;
  limit?: number;
}

interface SearchResponse {
  count: number;
  rows?: Array<Record<string, unknown>>;
}

const MAX_LIMIT = 200;

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  let body: CompaniesSearchFilters;
  try {
    body = (await req.json()) as CompaniesSearchFilters;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const wantCount = body.countOnly === true;
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), MAX_LIMIT);

  const buildQuery = (mode: 'count' | 'rows') => {
    let q = supabaseAdmin!
      .from('companies_directory')
      .select(
        mode === 'count'
          ? 'id'
          : 'id, name, inn, kpp, address, phones, email, employees_count, revenue, cost, activity_type, website, edo_id, egais, ogrn',
        mode === 'count' ? { count: 'exact', head: true } : undefined,
      );

    // Регионы — OR по подстрокам в address.
    if (body.regionCodes && body.regionCodes.length > 0) {
      const tokens: string[] = [];
      for (const code of body.regionCodes) {
        const r = getRegionByCode(code);
        if (r) for (const t of r.matchTokens) tokens.push(t);
      }
      if (tokens.length > 0) {
        const orClause = tokens
          .map((t) => `address.ilike.%${t.replace(/[%,]/g, '')}%`)
          .join(',');
        q = q.or(orClause);
      }
    }

    // Виды деятельности.
    if (body.activityTypes && body.activityTypes.length > 0) {
      q = q.in('activity_type', body.activityTypes);
    }

    // Контакты.
    if (body.hasPhone) q = q.not('phones', 'is', null);
    if (body.hasEmail) q = q.not('email', 'is', null);

    // ОПФ — name начинается с префикса.
    if (body.legalForms && body.legalForms.length > 0) {
      const orClause = body.legalForms
        .map((f) => `name.ilike.${f.replace(/[%,]/g, '')}%`)
        .join(',');
      q = q.or(orClause);
    }

    // Дополнительные поля.
    if (body.hasWebsite) q = q.not('website', 'is', null);
    if (body.hasEdo) q = q.not('edo_id', 'is', null);
    if (body.hasEgais) q = q.not('egais', 'is', null);

    // ИП — исключаем, если флаг false (по умолчанию false → исключаем).
    if (body.includeIp === false) {
      q = q.not('name', 'ilike', 'ИП %');
    }

    // Финансы.
    if (typeof body.revenueFrom === 'number') q = q.gte('revenue', body.revenueFrom);
    if (typeof body.revenueTo === 'number') q = q.lte('revenue', body.revenueTo);
    if (typeof body.costFrom === 'number') q = q.gte('cost', body.costFrom);
    if (typeof body.costTo === 'number') q = q.lte('cost', body.costTo);

    // Численность.
    if (typeof body.employeesFrom === 'number') q = q.gte('employees_count', body.employeesFrom);
    if (typeof body.employeesTo === 'number') q = q.lte('employees_count', body.employeesTo);

    // По списку ИНН.
    if (body.innList && body.innList.length > 0) {
      q = q.in('inn', body.innList);
    }

    return q;
  };

  try {
    const { count, error: countErr } = await buildQuery('count');
    if (countErr) return jsonError(countErr.message, 500);

    const response: SearchResponse = { count: count ?? 0 };

    if (!wantCount && (count ?? 0) > 0) {
      const { data, error } = await buildQuery('rows').limit(limit);
      if (error) return jsonError(error.message, 500);
      response.rows = data ?? [];
    }

    return NextResponse.json(response);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
