/**
 * Глобальная видимость и статусы инструментов — админский «выключатель»
 * сразу для всех (включая самого админа). См. миграции:
 *   20260601_0023_global_tool_visibility.sql — boolean enabled (deprecated)
 *   20260601_0024_tool_status_states.sql     — multi-status (active/new/beta/in_development/disabled)
 *
 * GET  — карта { tool_id: { status, new_since } } по ВСЕМ инструментам.
 *        Для тулов без записи в global_tool_visibility — status='active'.
 *        Effective-статус (с учётом 7-дневного истечения 'new') рассчитывается
 *        отдельно — у самого DB-значения должна оставаться правда.
 * POST — массовое обновление: тело `{ updates: { tool_id: { status }, ... } }`.
 *        Перезаписывает строки только для ключей из payload. Если status='new',
 *        new_since выставляется в now() — каждый раз когда админ ставит 'new',
 *        счётчик 7 дней начинается заново. На других статусах new_since
 *        сбрасывается в null.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import { logError } from '@/lib/loggerServer';
import { ALL_TOOL_IDS, type ToolId } from '@/lib/toolsRegistry';
import { TOOL_STATUSES, type ToolStatus } from '@/lib/toolStatus';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

interface ToolStatusRow {
  tool_id: string;
  status: ToolStatus;
  new_since: string | null;
}

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
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();
  const role = (profile?.role ?? null) as UserRole | null;
  if (!isAdmin(role)) return { error: jsonError('Forbidden', 403) };

  return { user, supabaseAdmin };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const { data: rows, error } = await auth.supabaseAdmin
    .from('global_tool_visibility')
    .select('tool_id, status, new_since');
  if (error) {
    await logError('admin.tool-visibility.get.failed', error);
    return jsonError(error.message, 500);
  }

  const byTool = new Map<string, ToolStatusRow>(
    ((rows ?? []) as ToolStatusRow[]).map((r) => [r.tool_id, r]),
  );

  const states: Record<string, { status: ToolStatus; new_since: string | null }> = {};
  for (const id of ALL_TOOL_IDS) {
    const row = byTool.get(id);
    states[id] = {
      status: row?.status ?? 'active',
      new_since: row?.new_since ?? null,
    };
  }
  return NextResponse.json({ states });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const text = await req.text().catch(() => '');
  const body = safeJsonParse<{ updates?: Record<string, { status?: string }> }>(text);
  const incoming = body?.updates;
  if (!incoming || typeof incoming !== 'object') {
    return jsonError('Missing updates object', 400);
  }

  const allowedTools = new Set<string>(ALL_TOOL_IDS);
  const allowedStatuses = new Set<string>(TOOL_STATUSES);

  const rowsToUpsert: Array<{
    tool_id: ToolId;
    status: ToolStatus;
    new_since: string | null;
    updated_by: string;
    updated_at: string;
  }> = [];
  const now = new Date().toISOString();
  for (const [toolId, payload] of Object.entries(incoming)) {
    if (!allowedTools.has(toolId)) continue;
    const status = payload?.status;
    if (typeof status !== 'string' || !allowedStatuses.has(status)) continue;
    rowsToUpsert.push({
      tool_id: toolId as ToolId,
      status: status as ToolStatus,
      // Каждый set 'new' = заново сбрасываем 7-дневный счётчик.
      new_since: status === 'new' ? now : null,
      updated_by: auth.user.id,
      updated_at: now,
    });
  }

  if (rowsToUpsert.length === 0) {
    return NextResponse.json({ ok: true, updated: 0 });
  }

  const { error } = await auth.supabaseAdmin
    .from('global_tool_visibility')
    .upsert(rowsToUpsert, { onConflict: 'tool_id' });
  if (error) {
    await logError('admin.tool-visibility.post.failed', error, { count: rowsToUpsert.length });
    return jsonError(error.message, 500);
  }

  return NextResponse.json({ ok: true, updated: rowsToUpsert.length });
}
