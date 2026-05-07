import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getRegionByCode } from '@/lib/companiesSearch/regions';
import type { CompaniesSearchFilters } from '@/app/api/client/companies-search/route';

export const dynamic = 'force-dynamic';

const admin = supabaseAdmin!;

async function getUser(req: NextRequest) {
  const token = req.headers.get('authorization')?.replace('Bearer ', '');
  if (!token) return null;
  const { data } = await admin.auth.getUser(token);
  return data.user;
}

const MAX_LIMIT = 200;

export async function POST(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  let body: CompaniesSearchFilters;
  try {
    body = (await req.json()) as CompaniesSearchFilters;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const wantCount = body.countOnly === true;
  const limit = Math.min(Math.max(Number(body.limit) || 25, 1), MAX_LIMIT);

  const buildQuery = (mode: 'count' | 'rows') => {
    let q = admin
      .from('companies_directory')
      .select(
        mode === 'count'
          ? 'id'
          : 'id, name, inn, kpp, address, phones, email, employees_count, revenue, cost, activity_type, website, edo_id, egais, ogrn',
        mode === 'count' ? { count: 'exact', head: true } : undefined,
      );

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

    if (body.activityTypes && body.activityTypes.length > 0) {
      q = q.in('activity_type', body.activityTypes);
    }

    if (body.hasPhone) q = q.not('phones', 'is', null);
    if (body.hasEmail) q = q.not('email', 'is', null);

    if (body.legalForms && body.legalForms.length > 0) {
      const orClause = body.legalForms
        .map((f) => `name.ilike.${f.replace(/[%,]/g, '')}%`)
        .join(',');
      q = q.or(orClause);
    }

    if (body.hasWebsite) q = q.not('website', 'is', null);
    if (body.hasEdo) q = q.not('edo_id', 'is', null);
    if (body.hasEgais) q = q.not('egais', 'is', null);

    if (body.includeIp === false) {
      q = q.not('name', 'ilike', 'ИП %');
    }

    if (typeof body.revenueFrom === 'number') q = q.gte('revenue', body.revenueFrom);
    if (typeof body.revenueTo === 'number') q = q.lte('revenue', body.revenueTo);
    if (typeof body.costFrom === 'number') q = q.gte('cost', body.costFrom);
    if (typeof body.costTo === 'number') q = q.lte('cost', body.costTo);

    if (typeof body.employeesFrom === 'number') q = q.gte('employees_count', body.employeesFrom);
    if (typeof body.employeesTo === 'number') q = q.lte('employees_count', body.employeesTo);

    if (body.innList && body.innList.length > 0) {
      q = q.in('inn', body.innList);
    }

    return q;
  };

  try {
    const { count, error: countErr } = await buildQuery('count');
    if (countErr) return NextResponse.json({ error: countErr.message }, { status: 500 });

    const response: { count: number; rows?: Array<Record<string, unknown>> } = { count: count ?? 0 };

    if (!wantCount && (count ?? 0) > 0) {
      const { data, error } = await buildQuery('rows').limit(limit);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      response.rows = (data as unknown as Record<string, unknown>[]) ?? [];
    }

    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
