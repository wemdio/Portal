import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { ALL_TOOL_IDS, DEFAULT_OFF_TOOL_IDS, DEFAULT_ON_TOOL_IDS_BY_ROLE } from '@/lib/toolsRegistry';
import { effectiveToolStatus, type ToolStatus } from '@/lib/toolStatus';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

interface GlobalToolRow {
  tool_id: string;
  status: ToolStatus;
  new_since: string | null;
}

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

  const [{ data: userRows }, { data: profile }, { data: globalRows }] = await Promise.all([
    supabase.from('user_tool_visibility').select('tool_id, enabled').eq('user_id', user.id),
    supabase.from('profiles').select('role').eq('id', user.id).single(),
    // Глобальный статус инструмента — побеждает per-user логику если 'disabled',
    // прокидывается в UI как badge/disabled-стейт если 'new'/'beta'/'in_development'.
    supabase.from('global_tool_visibility').select('tool_id, status, new_since'),
  ]);

  const role = (profile?.role ?? null) as UserRole | null;
  const defaultOffSet = new Set<string>(DEFAULT_OFF_TOOL_IDS);
  const roleOnSet = new Set<string>(role ? (DEFAULT_ON_TOOL_IDS_BY_ROLE[role] ?? []) : []);
  const isDefaultOn = (id: string): boolean =>
    !defaultOffSet.has(id) || roleOnSet.has(id);

  const userVisibility = Object.fromEntries((userRows ?? []).map((r) => [r.tool_id, r.enabled]));

  // По каждому инструменту считаем effective-статус (учёт 7-дневного TTL для 'new').
  const effectiveByTool = new Map<string, ToolStatus>();
  for (const row of (globalRows ?? []) as GlobalToolRow[]) {
    effectiveByTool.set(row.tool_id, effectiveToolStatus(row.status, row.new_since));
  }

  const statuses: Record<string, ToolStatus> = {};
  const toolIds = ALL_TOOL_IDS.filter((id) => {
    const effective = effectiveByTool.get(id) ?? 'active';

    // 'disabled' — жёсткое скрытие у всех.
    if (effective === 'disabled') return false;

    // Per-user видимость учитываем только для не-'in_development' тулов:
    // тулы «в разработке» специально показываем всем, чтобы команда знала
    // что готовится. Они и так не кликабельны.
    if (effective !== 'in_development') {
      if (id in userVisibility) {
        if (userVisibility[id] === false) return false;
      } else if (!isDefaultOn(id)) {
        return false;
      }
    }

    // Возвращаем статус в UI только если он не дефолтный.
    if (effective !== 'active') statuses[id] = effective;
    return true;
  });

  return NextResponse.json({ toolIds, statuses });
}
