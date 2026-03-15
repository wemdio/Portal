import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { getBotByIdOrContainerName } from '@/lib/adminBots/config';
import { containerStop } from '@/lib/adminBots/docker';
import { setInAppBotEnabled } from '@/lib/adminBots/inAppState';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdmin(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };
  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };
  const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).single();
  if (!profile || profile.role !== 'admin') return { error: jsonError('Forbidden', 403) };
  return { user, profile };
}

/**
 * POST /api/admin/bots/[id]/stop
 * Stop a container bot. Admin only. In-app bots cannot be stopped.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(_req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const bot = getBotByIdOrContainerName(id);
  if (!bot) return jsonError('Bot not found', 404);
  if (bot.kind === 'in-app') {
    const result = await setInAppBotEnabled(bot.id, false);
    if (!result.ok) {
      return NextResponse.json({ error: result.error ?? 'Failed to stop' }, { status: 500 });
    }
    return NextResponse.json({ ok: true });
  }
  if (!bot.containerName) {
    return jsonError('Container name is missing', 400);
  }

  const result = await containerStop(bot.containerName);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Failed to stop' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
