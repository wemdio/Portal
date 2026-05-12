import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { searchCount, searchRows } from '@/lib/companiesSearch/rpcSearch';

export const dynamic = 'force-dynamic';

export interface CompaniesSearchFilters {
  regionCodes?: string[];
  activityTypes?: string[];
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
}

const MAX_LIMIT = 200;

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;

  let body: CompaniesSearchFilters;
  try {
    body = (await req.json()) as CompaniesSearchFilters;
  } catch {
    return jsonError('Invalid JSON', 400);
  }

  const wantCount = body.countOnly === true;
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), MAX_LIMIT);

  try {
    const { count, error: countErr } = await searchCount(body);
    if (countErr) return jsonError(countErr, 500);

    const response: SearchResponse = { count };

    if (!wantCount && count > 0) {
      const { rows, error } = await searchRows(body, limit);
      if (error) return jsonError(error, 500);
      response.rows = rows;
    }

    return NextResponse.json(response);
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Unknown error', 500);
  }
}
