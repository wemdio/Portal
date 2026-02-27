import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';
import { ALL_TOOL_IDS } from '@/lib/toolsRegistry';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
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

  const { data: profile } = await supabaseAdmin.from('profiles').select('role').eq('id', user.id).single();
  const role = (profile?.role ?? null) as UserRole | null;
  if (!isAdmin(role)) return { error: jsonError('Forbidden', 403) };

  return { user, supabaseAdmin };
}

/** GET: видимость инструментов для пользователя. Нет записей = все включены. */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const { id: targetUserId } = await ctx.params;

  const { data: rows } = await auth.supabaseAdmin
    .from('user_tool_visibility')
    .select('tool_id, enabled')
    .eq('user_id', targetUserId);

  const visibility: Record<string, boolean> = {};
  for (const id of ALL_TOOL_IDS) {
    const row = rows?.find((r) => r.tool_id === id);
    visibility[id] = row?.enabled ?? true;
  }

  return NextResponse.json({ visibility });
}

/** POST: установить видимость инструментов для пользователя. */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const { id: targetUserId } = await ctx.params;
  const text = await req.text().catch(() => '');
  const body = safeJsonParse<{ visibility?: Record<string, unknown> }>(text);
  const visibility = body?.visibility;

  if (!visibility || typeof visibility !== 'object') {
    return jsonError('Missing visibility object', 400);
  }

  const toWrite = ALL_TOOL_IDS.map((toolId) => ({
    user_id: targetUserId,
    tool_id: toolId,
    enabled: visibility[toolId] !== false,
  }));

  const { error: delErr } = await auth.supabaseAdmin
    .from('user_tool_visibility')
    .delete()
    .eq('user_id', targetUserId);

  if (delErr) {
    await logError('admin.users.tools.delete.failed', delErr, { targetUserId });
    return jsonError(delErr.message || 'Failed to update visibility', 500);
  }

  const { error: insErr } = await auth.supabaseAdmin
    .from('user_tool_visibility')
    .insert(toWrite);

  if (insErr) {
    await logError('admin.users.tools.insert.failed', insErr, { targetUserId });
    return jsonError(insErr.message || 'Failed to save visibility', 500);
  }

  return NextResponse.json({ ok: true });
}
