import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { loadBenchHistory } from '@/lib/bench/usage';
import { logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Расход ключа по дням. Нужен, чтобы понять не «упёрся ли он в потолок прямо
 * сейчас», а как он расходует норму вообще: ровно каждый день, рывками или
 * не пользуется вовсе. По этому решают, поднимать лимит или он избыточен.
 */

const DEFAULT_DAYS = 10;
const MAX_DAYS = 60;

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

export async function GET(req: NextRequest, ctx: Ctx) {
  const auth = await requireAdmin(req);
  if (auth.error) return auth.error;

  const { id } = await ctx.params;
  const requested = Number(req.nextUrl.searchParams.get('days'));
  const days = Math.max(1, Math.min(MAX_DAYS, requested || DEFAULT_DAYS));

  try {
    // Лимиты отдаём вместе с историей: без них столбики не с чем сравнить —
    // «300 строк» это много или пусто, зависит от потолка.
    const [history, keyRow] = await Promise.all([
      loadBenchHistory(auth.admin, id, days),
      auth.admin
        .from('bench_api_keys')
        .select('daily_jobs_limit, daily_rows_limit')
        .eq('id', id)
        .maybeSingle(),
    ]);

    if (!keyRow.data) return jsonError('Ключ не найден', 404);

    return NextResponse.json({
      days: history,
      limits: {
        daily_jobs_limit: keyRow.data.daily_jobs_limit,
        daily_rows_limit: keyRow.data.daily_rows_limit,
      },
    });
  } catch (e) {
    await logError('admin.bench-keys.history.failed', e);
    return jsonError(e instanceof Error ? e.message : 'Не удалось загрузить историю', 500);
  }
}
