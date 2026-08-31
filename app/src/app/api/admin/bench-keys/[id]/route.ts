import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { revokeBenchKey } from '@/lib/bench/issueKey';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const LOG_LIMIT = 200;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdmin(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  if (!isAdmin((profile?.role ?? null) as UserRole | null)) {
    return { error: jsonError('Forbidden', 403) };
  }
  return { user, admin: supabaseAdmin };
}

type Ctx = { params: Promise<{ id: string }> };

/** Журнал обращений по ключу — по нему разбирают, что происходило. */
export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const { data, error } = await auth.admin
    .from('bench_api_requests')
    .select('id, tool, action, status_code, rows_returned, duration_ms, created_at')
    .eq('key_id', id)
    .order('created_at', { ascending: false })
    .limit(LOG_LIMIT);

  if (error) {
    await logError('admin.bench-keys.log.failed', error);
    return jsonError(error.message, 500);
  }
  return NextResponse.json({ entries: data ?? [], limit: LOG_LIMIT });
}

/**
 * Отзыв ключа. Единственное изменяющее действие над ключом — редактировать
 * выданный ключ нельзя: если нужны другие права или лимиты, выдаётся новый,
 * а старый отзывается. Так в журнале всегда видно, под какими правами что
 * происходило.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== 'revoke') {
    return jsonError('Поддерживается только action=revoke', 400);
  }

  const result = await revokeBenchKey(id);
  if (!result.ok) {
    await logError('admin.bench-keys.revoke.failed', new Error(result.error ?? 'unknown'));
    return jsonError(result.error ?? 'Не удалось отозвать ключ', 500);
  }

  await logAudit('admin.bench-keys.revoked', 'Отозван ключ Bench API', { keyId: id }, {
    userId: auth.user.id,
  });

  return NextResponse.json({ ok: true });
}
