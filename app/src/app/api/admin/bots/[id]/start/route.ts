import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { getBotByIdOrContainerName } from '@/lib/adminBots/config';
import { containerStart } from '@/lib/adminBots/docker';

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
 * POST /api/admin/bots/[id]/start
 * Start a container bot. Admin only. In-app bots are always running.
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
  if (bot.kind !== 'container' || !bot.containerName) {
    return jsonError('This bot cannot be started via API (in-app)', 400);
  }

  const result = await containerStart(bot.containerName);
  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? 'Failed to start' }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
