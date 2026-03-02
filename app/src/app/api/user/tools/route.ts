import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { ALL_TOOL_IDS, DEFAULT_OFF_TOOL_IDS } from '@/lib/toolsRegistry';

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

  const { data: rows } = await supabase
    .from('user_tool_visibility')
    .select('tool_id, enabled')
    .eq('user_id', user.id);

  const defaultOffSet = new Set<string>(DEFAULT_OFF_TOOL_IDS);

  if (!rows || rows.length === 0) {
    const toolIds = ALL_TOOL_IDS.filter((id) => !defaultOffSet.has(id));
    return NextResponse.json({ toolIds });
  }

  const visibilityByTool = Object.fromEntries(rows.map((r) => [r.tool_id, r.enabled]));
  const toolIds = ALL_TOOL_IDS.filter((id) => {
    if (id in visibilityByTool) return visibilityByTool[id] !== false;
    return !defaultOffSet.has(id);
  });
  return NextResponse.json({ toolIds });
}
