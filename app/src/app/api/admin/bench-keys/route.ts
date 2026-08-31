import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { z } from 'zod';
import { issueBenchKey } from '@/lib/bench/issueKey';
import { describeBenchTool, listAllBenchTools } from '@/lib/bench/registry';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Управление ключами Bench API. Только админ: ключ открывает доступ к
 * инструментам студии снаружи, и выдавать его — не рядовое действие.
 */

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

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const { data, error } = await auth.admin
    .from('bench_api_keys')
    .select(
      'id, name, key_last4, allowed_tools, rpm_limit, daily_jobs_limit, daily_rows_limit, max_active_jobs, revoked_at, last_used_at, created_at',
    )
    .order('created_at', { ascending: false });

  if (error) {
    await logError('admin.bench-keys.get.failed', error);
    return jsonError(error.message, 500);
  }

  // Ответ собирается перечислением полей, а не отдачей строки как есть.
  // Список колонок в запросе выше уже исключает `key_hash`, но полагаться
  // на одну лишь строку запроса нельзя: `select('*')` вписывается одним
  // движением руки, и отпечатки ключей уехали бы в браузер.
  const keys = (data ?? []).map((row) => ({
    id: String(row.id),
    name: row.name,
    key_last4: row.key_last4,
    allowed_tools: row.allowed_tools ?? [],
    rpm_limit: row.rpm_limit,
    daily_jobs_limit: row.daily_jobs_limit,
    daily_rows_limit: row.daily_rows_limit,
    max_active_jobs: row.max_active_jobs,
    revoked_at: row.revoked_at ?? null,
    last_used_at: row.last_used_at ?? null,
    created_at: row.created_at,
  }));

  return NextResponse.json({
    keys,
    tools: listAllBenchTools().map(describeBenchTool),
  });
}

const issueSchema = z.object({
  name: z.string().min(1).max(200),
  tools: z.array(z.string().min(1).max(64)).min(1),
  rpm_limit: z.number().int().min(1).max(10_000).optional(),
  daily_jobs_limit: z.number().int().min(0).max(100_000).optional(),
  daily_rows_limit: z.number().int().min(0).max(50_000_000).optional(),
  max_active_jobs: z.number().int().min(1).max(50).optional(),
});

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const parsed = issueSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Проверьте поля формы', details: parsed.error.issues },
      { status: 400 },
    );
  }

  // Инструмент, которого нет в реестре, в ключе бесполезен и только вводит в
  // заблуждение: на экране он выглядел бы выданным, а работать бы не стал.
  const known = new Set(listAllBenchTools().map((t) => t.id));
  const unknown = parsed.data.tools.filter((t) => !known.has(t));
  if (unknown.length) {
    return jsonError(`Неизвестные инструменты: ${unknown.join(', ')}`, 400);
  }

  const result = await issueBenchKey({
    name: parsed.data.name,
    tools: parsed.data.tools,
    limits: {
      ...(parsed.data.rpm_limit !== undefined ? { rpm_limit: parsed.data.rpm_limit } : {}),
      ...(parsed.data.daily_jobs_limit !== undefined
        ? { daily_jobs_limit: parsed.data.daily_jobs_limit }
        : {}),
      ...(parsed.data.daily_rows_limit !== undefined
        ? { daily_rows_limit: parsed.data.daily_rows_limit }
        : {}),
      ...(parsed.data.max_active_jobs !== undefined
        ? { max_active_jobs: parsed.data.max_active_jobs }
        : {}),
    },
    createdBy: auth.user.id,
  });

  if (!result.ok) {
    await logError('admin.bench-keys.issue.failed', new Error(result.error));
    return jsonError(result.error, 500);
  }

  // В журнал аудита — кому и на что выдали. Сам ключ туда не пишем.
  await logAudit(
    'admin.bench-keys.issued',
    `Выдан ключ Bench API «${parsed.data.name}»`,
    { keyId: result.issued.id, tools: parsed.data.tools },
    { userId: auth.user.id },
  );

  return NextResponse.json({
    id: result.issued.id,
    // Единственный раз, когда открытый ключ покидает сервер.
    key: result.issued.key,
  });
}
