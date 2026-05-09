import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { searchCount, searchRows } from '@/lib/companiesSearch/rpcSearch';
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

  try {
    const { count, error: countErr } = await searchCount(body);
    if (countErr) return NextResponse.json({ error: countErr }, { status: 500 });

    const response: { count: number; rows?: Array<Record<string, unknown>> } = { count };

    if (!wantCount && count > 0) {
      const { rows, error } = await searchRows(body, limit);
      if (error) return NextResponse.json({ error }, { status: 500 });
      response.rows = rows;
    }

    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 },
    );
  }
}
