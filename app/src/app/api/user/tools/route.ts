import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { ALL_TOOL_IDS } from '@/lib/toolsRegistry';

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

  // Нет записей — по умолчанию все инструменты доступны
  if (!rows || rows.length === 0) {
    return NextResponse.json({ toolIds: [...ALL_TOOL_IDS] });
  }

  const visibilityByTool = Object.fromEntries(rows.map((r) => [r.tool_id, r.enabled]));
  const toolIds = ALL_TOOL_IDS.filter((id) => visibilityByTool[id] !== false);
  return NextResponse.json({ toolIds });
}
