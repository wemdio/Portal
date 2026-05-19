import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { ALL_TOOL_IDS, DEFAULT_OFF_TOOL_IDS, DEFAULT_ON_TOOL_IDS_BY_ROLE } from '@/lib/toolsRegistry';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const [{ data: rows }, { data: profile }] = await Promise.all([
    supabase.from('user_tool_visibility').select('tool_id, enabled').eq('user_id', user.id),
    supabase.from('profiles').select('role').eq('id', user.id).single(),
  ]);

  const role = (profile?.role ?? null) as UserRole | null;
  const defaultOffSet = new Set<string>(DEFAULT_OFF_TOOL_IDS);
  // Инструменты, включённые по умолчанию для роли пользователя, несмотря на DEFAULT_OFF.
  const roleOnSet = new Set<string>(role ? (DEFAULT_ON_TOOL_IDS_BY_ROLE[role] ?? []) : []);

  // Дефолтная видимость инструмента (без явной per-user записи).
  const isDefaultOn = (id: string): boolean =>
    !defaultOffSet.has(id) || roleOnSet.has(id);

  if (!rows || rows.length === 0) {
    const toolIds = ALL_TOOL_IDS.filter(isDefaultOn);
    return NextResponse.json({ toolIds });
  }

  const visibilityByTool = Object.fromEntries(rows.map((r) => [r.tool_id, r.enabled]));
  const toolIds = ALL_TOOL_IDS.filter((id) => {
    if (id in visibilityByTool) return visibilityByTool[id] !== false;
    return isDefaultOn(id);
  });
  return NextResponse.json({ toolIds });
}
