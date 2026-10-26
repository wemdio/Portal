import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { revokeBenchKey } from '@/lib/bench/issueKey';
import { benchLimitsSchema } from '@/lib/bench/limitsSchema';
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

const LIMIT_COLUMNS = 'rpm_limit, daily_jobs_limit, daily_rows_limit, max_active_jobs';

/**
 * Новые лимиты выданного ключа. Действуют со следующего запроса: лимиты
 * читаются из строки ключа при каждом обращении. Права (инструменты) так не
 * меняются — для них выдаётся новый ключ. Старые и новые значения уходят в
 * аудит, чтобы по журналу было видно, при каком потолке что происходило.
 */
async function setLimits(
  auth: { user: { id: string }; admin: NonNullable<typeof supabaseAdmin> },
  id: string,
  raw: unknown,
) {
  const parsed = benchLimitsSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Проверьте лимиты', details: parsed.error.issues },
      { status: 400 },
    );
  }

  const { data: before } = await auth.admin
    .from('bench_api_keys')
    .select(LIMIT_COLUMNS)
    .eq('id', id)
    .is('revoked_at', null)
    .maybeSingle();
  if (!before) return jsonError('Ключ не найден или отозван', 404);

  const { error } = await auth.admin
    .from('bench_api_keys')
    .update(parsed.data)
    .eq('id', id)
    .is('revoked_at', null);
  if (error) {
    await logError('admin.bench-keys.limits.failed', error);
    return jsonError(error.message, 500);
  }

  await logAudit(
    'admin.bench-keys.limits-changed',
    'Изменены лимиты ключа Bench API',
    { keyId: id, before, after: parsed.data },
    { userId: auth.user.id },
  );

  return NextResponse.json({ ok: true });
}

/**
 * Действия над ключом: отзыв и правка лимитов. Права (инструменты) у
 * выданного ключа не меняются: нужны другие — выдаётся новый ключ, а старый
 * отзывается.
 */
export async function POST(req: NextRequest, ctx: Ctx) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { action?: string; limits?: unknown } | null;
  if (body?.action === 'set_limits') {
    return setLimits(auth, id, body.limits);
  }
  if (body?.action !== 'revoke') {
    return jsonError('Поддерживаются action=revoke и action=set_limits', 400);
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
