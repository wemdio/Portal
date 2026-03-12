import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getBotById } from '@/lib/adminBots/config';
import { containerLogs } from '@/lib/adminBots/docker';

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

const TG_AGENT_LOG_EVENT_PREFIX = 'telegram-agent';

/**
 * GET /api/admin/bots/[id]/logs
 * Get logs for a bot. For container bots uses Docker logs; for tg-agent uses application_logs.
 * Query: tail (number, optional) — limit lines for container logs.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const { id } = await params;
  const bot = getBotById(id);
  if (!bot) return jsonError('Bot not found', 404);

  const url = req.nextUrl;
  const tail = Math.min(5000, Math.max(100, Number(url.searchParams.get('tail') ?? '1000')));

  if (bot.kind === 'in-app' && bot.id === 'tg-agent') {
    if (!supabaseAdmin) return jsonError('Logs not configured', 500);
    const { data: rows, error } = await supabaseAdmin
      .from('application_logs')
      .select('id, created_at, level, event, message, context')
      .ilike('event', `${TG_AGENT_LOG_EVENT_PREFIX}%`)
      .order('created_at', { ascending: false })
      .limit(500);
    if (error) return jsonError(error.message, 500);
    const lines = (rows ?? []).reverse().map((r) => {
      const ts = r.created_at ? new Date(r.created_at).toISOString() : '';
      const ctx = r.context && typeof r.context === 'object' ? JSON.stringify(r.context) : '';
      return `[${ts}] [${r.level}] ${r.event}: ${r.message}${ctx ? ' ' + ctx : ''}`;
    });
    return NextResponse.json({ logs: lines.join('\n'), source: 'application_logs' });
  }

  if (bot.kind === 'container' && bot.containerName) {
    const result = await containerLogs(bot.containerName, { tail });
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: 500 });
    }
    return NextResponse.json({ logs: result.logs, source: 'docker' });
  }

  return jsonError('Logs not available for this bot', 400);
}
