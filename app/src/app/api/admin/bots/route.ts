import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { BOTS, getBotById, getContainerBots } from '@/lib/adminBots/config';
import {
  listContainersByNames,
  isDockerAvailable,
  getDockerUnavailableReason,
  type ContainerInfo,
} from '@/lib/adminBots/docker';

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

export type BotStatus = 'running' | 'exited' | 'paused' | 'unknown' | 'in-app';

export interface BotListItem {
  id: string;
  name: string;
  description: string;
  kind: 'container' | 'in-app';
  status: BotStatus;
  statusDetail?: string;
  canStop: boolean;
  canStart: boolean;
  canLogs: boolean;
}

/**
 * GET /api/admin/bots
 * List all bots with status. Admin only.
 */
export async function GET(_req: NextRequest) {
  const auth = await requireAdmin(_req);
  if ('error' in auth) return auth.error;

  const containerNames = getContainerBots()
    .map((b) => b.containerName)
    .filter((n): n is string => n != null);

  let containerInfos: ContainerInfo[] = [];
  let dockerError: string | undefined;
  const dockerAvailable = isDockerAvailable();

  if (dockerAvailable && containerNames.length > 0) {
    const result = await listContainersByNames(containerNames);
    containerInfos = result.containers;
    if (result.error) dockerError = result.error;
  }

  const byContainerName = new Map(containerInfos.map((c) => [c.name, c]));

  const items: BotListItem[] = BOTS.map((bot) => {
    if (bot.kind === 'in-app') {
      return {
        id: bot.id,
        name: bot.name,
        description: bot.description,
        kind: 'in-app',
        status: 'in-app' as BotStatus,
        statusDetail: 'работает в процессе портала',
        canStop: false,
        canStart: false,
        canLogs: true,
      };
    }
    const info = bot.containerName ? byContainerName.get(bot.containerName) : undefined;
    const status: BotStatus = info ? info.state : 'unknown';
    return {
      id: bot.id,
      name: bot.name,
      description: bot.description,
      kind: 'container',
      status,
      statusDetail: info?.status,
      canStop: dockerAvailable && status === 'running',
      canStart: dockerAvailable && (status === 'exited' || status === 'paused'),
      canLogs: true,
    };
  });

  return NextResponse.json({
    bots: items,
    dockerAvailable,
    dockerUnavailableReason: dockerAvailable ? null : getDockerUnavailableReason(),
    dockerError: dockerError ?? null,
  });
}
