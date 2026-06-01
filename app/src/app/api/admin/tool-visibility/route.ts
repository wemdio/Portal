/**
 * Глобальная видимость инструментов — админский «выключатель» инструмента
 * сразу для всех (включая самого админа). См. миграцию
 * `20260601_0023_global_tool_visibility.sql`.
 *
 * GET  — текущая карта { tool_id: enabled } по ВСЕМ инструментам из реестра
 *        (для тулов без записи в global_tool_visibility — enabled=true).
 * POST — массовое обновление: тело `{ visibility: { tool_id: boolean, ... } }`.
 *        Перезаписывает строки только для ключей из payload — остальные не
 *        трогает. Достаточно для UI с одним тумблером за клик.
 */
import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import { logError } from '@/lib/loggerServer';
import { ALL_TOOL_IDS, type ToolId } from '@/lib/toolsRegistry';
import type { UserRole } from '@/types';

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
    .select('tool_id, enabled');
  if (error) {
    await logError('admin.tool-visibility.get.failed', error);
    return jsonError(error.message, 500);
  }

  const byTool = new Map<string, boolean>((rows ?? []).map((r) => [r.tool_id, r.enabled]));
  const visibility: Record<string, boolean> = {};
  for (const id of ALL_TOOL_IDS) {
    visibility[id] = byTool.get(id) ?? true; // missing row = enabled by default
  }
  return NextResponse.json({ visibility });
}

export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const text = await req.text().catch(() => '');
  const body = safeJsonParse<{ visibility?: Record<string, unknown> }>(text);
  const incoming = body?.visibility;
  if (!incoming || typeof incoming !== 'object') {
    return jsonError('Missing visibility object', 400);
  }

  const allowed = new Set<string>(ALL_TOOL_IDS);
  const rowsToUpsert: { tool_id: ToolId; enabled: boolean; updated_by: string; updated_at: string }[] = [];
  for (const [toolId, raw] of Object.entries(incoming)) {
    if (!allowed.has(toolId)) continue; // молча игнорим неизвестные
    rowsToUpsert.push({
      tool_id: toolId as ToolId,
      enabled: raw !== false,
      updated_by: auth.user.id,
      updated_at: new Date().toISOString(),
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
