import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { searchCount, searchRows } from '@/lib/companiesSearch/rpcSearch';
import {
  getClientTariffRow,
  resolveEffectiveLimits,
  getBillingPeriodStart,
  countClientRows,
} from '@/lib/tariffs';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export interface CompaniesSearchFilters {
  regionCodes?: string[];
  activityTypes?: string[];
  /**
   * Выбранные узлы дерева ОКВЭД-2 (любого уровня — раздел/класс/подкласс/группа/...).
   * На бэке схлопывается до минимального набора префиксов и матчится через
   * `okved_code LIKE 'X%'` в companies_directory.
   */
  okvedCodes?: string[];
  hasPhone?: boolean;
  hasEmail?: boolean;
  legalForms?: string[];
  hasWebsite?: boolean;
  hasEdo?: boolean;
  hasEgais?: boolean;
  revenueFrom?: number | null;
  revenueTo?: number | null;
  costFrom?: number | null;
  costTo?: number | null;
  employeesFrom?: number | null;
  employeesTo?: number | null;
  includeIp?: boolean;
  innList?: string[];
  countOnly?: boolean;
  limit?: number;
}

interface SearchResponse {
  count: number;
  rows?: Array<Record<string, unknown>>;
  remaining?: number;
}

const MAX_LIMIT = 200;

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);

  let body: CompaniesSearchFilters;
  try {
    body = (await req.json()) as CompaniesSearchFilters;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const wantCount = body.countOnly === true;
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), MAX_LIMIT);

  const tariffRow = await getClientTariffRow(result.auth.userId);
  const limits = resolveEffectiveLimits(tariffRow);
  const periodStart = getBillingPeriodStart(tariffRow);
  const usedRows = await countClientRows(result.auth.userId, periodStart);
  const remaining = Math.max(0, limits.max_rows - usedRows);

  if (!wantCount && remaining <= 0) {
    return jsonError(
      `Лимит запросов по тарифу исчерпан. Доступно 0 из ${limits.max_rows.toLocaleString('ru-RU')} запросов.`,
      429,
    );
  }

  try {
    const { count, error: countErr } = await searchCount(body);
    if (countErr) return jsonError(countErr, 500);

    const response: SearchResponse = { count, remaining };

    if (!wantCount && count > 0) {
      const { rows, error } = await searchRows(body, limit);
      if (error) return jsonError(error, 500);
      response.rows = rows;

      const exportedCount = rows?.length ?? 0;
      if (exportedCount > 0 && supabaseAdmin) {
        await supabaseAdmin
          .from('client_companies_search_exports')
          .insert({ user_id: result.auth.userId, row_count: exportedCount });
      }
    }

    return NextResponse.json(response);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
