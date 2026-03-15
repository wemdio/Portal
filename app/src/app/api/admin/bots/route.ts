import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { BOTS, CONTAINER_BOT_PREFIX, getContainerBots } from '@/lib/adminBots/config';
import {
  listContainersByNames,
  listContainersWithPrefix,
  isDockerAvailable,
  getDockerUnavailableReason,
  type ContainerInfo,
} from '@/lib/adminBots/docker';
import { isInAppBotEnabled } from '@/lib/adminBots/inAppState';

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
  /** True if bot was auto-discovered (container name starts with portal-). */
  autoDiscovered?: boolean;
}

/**
 * GET /api/admin/bots
 * List all bots with status. Admin only.
 */
export async function GET(_req: NextRequest) {
  const auth = await requireAdmin(_req);
  if ('error' in auth) return auth.error;

  const dockerInitiallyAvailable = isDockerAvailable();
  let dockerError: string | undefined;

  const knownContainerNames = getContainerBots()
    .map((b) => b.containerName)
    .filter((n): n is string => n != null);

  let containerInfos: ContainerInfo[] = [];
  let discoveredContainers: ContainerInfo[] = [];

  if (dockerInitiallyAvailable) {
    if (knownContainerNames.length > 0) {
      const result = await listContainersByNames(knownContainerNames);
      containerInfos = result.containers;
      if (result.error) dockerError = result.error;
    }
    const byPrefix = await listContainersWithPrefix(CONTAINER_BOT_PREFIX);
    discoveredContainers = byPrefix.containers;
    if (byPrefix.error && !dockerError) dockerError = byPrefix.error;
  }

  const dockerAvailable = dockerError ? false : isDockerAvailable();

  const byContainerName = new Map(containerInfos.map((c) => [c.name, c]));
  const knownSet = new Set(knownContainerNames);

  const items: BotListItem[] = [];

  for (const bot of BOTS) {
    if (bot.kind === 'in-app') {
      const enabled = await isInAppBotEnabled(bot.id);
      items.push({
        id: bot.id,
        name: bot.name,
        description: bot.description,
        kind: 'in-app',
        status: (enabled ? 'running' : 'exited') as BotStatus,
        statusDetail: enabled ? 'работает в процессе портала' : 'остановлен через Bot Manager',
        canStop: enabled,
        canStart: !enabled,
        canLogs: true,
      });
      continue;
    }
    const info = bot.containerName ? byContainerName.get(bot.containerName) : undefined;
    const status: BotStatus = info ? info.state : 'unknown';
    items.push({
      id: bot.id,
      name: bot.name,
      description: bot.description,
      kind: 'container',
      status,
      statusDetail: info?.status,
      canStop: dockerAvailable && status === 'running',
      canStart: dockerAvailable && (status === 'exited' || status === 'paused'),
      canLogs: true,
    });
  }

  for (const c of discoveredContainers) {
    if (knownSet.has(c.name)) continue;
    items.push({
      id: c.name,
      name: c.name,
      description: 'Контейнерный бот',
      kind: 'container',
      status: c.state,
      statusDetail: c.status,
      canStop: dockerAvailable && c.state === 'running',
      canStart: dockerAvailable && (c.state === 'exited' || c.state === 'paused'),
      canLogs: true,
      autoDiscovered: true,
    });
  }

  return NextResponse.json({
    bots: items,
    dockerAvailable,
    dockerUnavailableReason: dockerAvailable ? null : getDockerUnavailableReason(),
    dockerError: dockerError ?? null,
  });
}
