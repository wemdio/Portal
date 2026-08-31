import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { logError } from '@/lib/loggerServer';
import {
  PdlCompanyReadError,
  pdlFiltersFromSearchParams,
  readPdlCompanyPage,
  type PdlRpcClient,
} from '@/lib/companyBase/pdlSearch';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { ok: false as const, response: jsonError('Unauthorized', 401) };
  const supabase = createAuthedSupabaseClient(token);
  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      return { ok: false as const, response: jsonError('Unauthorized', 401) };
    }
    return { ok: true as const, supabase, user: data.user };
  } catch {
    return { ok: false as const, response: jsonError('Unauthorized', 401) };
  }
}

export async function GET(req: NextRequest) {
  const auth = await getSupabase(req);
  if (!auth.ok) return auth.response;
  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();

  const sp = req.nextUrl.searchParams;
  const filters = pdlFiltersFromSearchParams(sp);
  const requestedLimit = Number(sp.get('limit') ?? '100');
  const limit = Math.min(10_000, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100));
  const afterId = (sp.get('after_id') ?? '').trim() || null;

  try {
    const items = await readPdlCompanyPage(
      supabase as unknown as PdlRpcClient,
      { ...filters, afterId, limit },
    );
    const nextCursor = items.length === limit
      ? String(items[items.length - 1]?.id ?? '').trim() || null
      : null;
    return NextResponse.json({ items, limit, next_cursor: nextCursor });
  } catch (error) {
    const readError = error instanceof PdlCompanyReadError ? error : null;
    await logError(
      'company_base.search.failed',
      readError ? new Error(readError.rawMessage) : error,
      { ...filters, after_id: afterId },
      { userId: user.id, requestId },
    );
    return jsonError(
      readError?.message ?? 'Не удалось получить данные базы компаний. Повторите попытку.',
      readError?.retryable ? 503 : 500,
      { request_id: requestId },
    );
  }
}
