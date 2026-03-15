/**
 * Docker client for Bot Manager. Uses DOCKER_HOST env (e.g. unix:///var/run/docker.sock).
 * When running in container with socket mounted, portal can control sibling containers.
 */

import Docker from 'dockerode';
import { Readable } from 'stream';

let dockerInstance: Docker | null = null;
let dockerUnavailableReason: string | null = null;

function getDocker(): Docker | null {
  if (dockerInstance) return dockerInstance;
  try {
    dockerInstance = new Docker();
    dockerUnavailableReason = null;
    return dockerInstance;
  } catch (e) {
    dockerUnavailableReason = e instanceof Error ? e.message : 'Docker init failed';
    return null;
  }
}

export function isDockerAvailable(): boolean {
  return dockerUnavailableReason === null && getDocker() !== null;
}

export function getDockerUnavailableReason(): string | null {
  getDocker();
  return dockerUnavailableReason;
}

export type ContainerState = 'running' | 'exited' | 'paused' | 'unknown';

export interface ContainerInfo {
  id: string;
  name: string;
  state: ContainerState;
  status: string;
}

/**
 * List all containers whose name (without leading /) starts with prefix.
 * Used to auto-discover portal bots (e.g. prefix "portal-").
 */
export async function listContainersWithPrefix(
  prefix: string
): Promise<{ containers: ContainerInfo[]; error?: string }> {
  const docker = getDocker();
  if (!docker) {
    return { containers: [], error: dockerUnavailableReason ?? 'Docker unavailable' };
  }
  try {
    const list = await docker.listContainers({ all: true });
    const containers: ContainerInfo[] = [];
    for (const c of list) {
      const name = c.Names?.[0]?.replace(/^\//, '') ?? '';
      if (!name.startsWith(prefix)) continue;
      const state = (c.State === 'running'
        ? 'running'
        : c.State === 'exited'
          ? 'exited'
          : c.State === 'paused'
            ? 'paused'
            : 'unknown') as ContainerState;
      containers.push({
        id: c.Id,
        name,
        state,
        status: c.Status ?? c.State ?? 'unknown',
      });
    }
    return { containers };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dockerUnavailableReason = msg;
    dockerInstance = null;
    return { containers: [], error: msg };
  }
}

export async function listContainersByNames(
  names: string[]
): Promise<{ containers: ContainerInfo[]; error?: string }> {
  const docker = getDocker();
  if (!docker) {
    return { containers: [], error: dockerUnavailableReason ?? 'Docker unavailable' };
  }
  try {
    const list = await docker.listContainers({ all: true });
    const byName = new Map<string, (typeof list)[0]>();
    for (const c of list) {
      const name = c.Names?.[0]?.replace(/^\//, '') ?? '';
      byName.set(name, c);
    }
    const containers: ContainerInfo[] = names.map((name) => {
      const c = byName.get(name);
      if (!c) {
        return { id: '', name, state: 'unknown' as ContainerState, status: 'not found' };
      }
      const state = (c.State === 'running'
        ? 'running'
        : c.State === 'exited'
          ? 'exited'
          : c.State === 'paused'
            ? 'paused'
            : 'unknown') as ContainerState;
      return {
        id: c.Id,
        name,
        state,
        status: c.Status ?? c.State ?? 'unknown',
      };
    });
    return { containers };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dockerUnavailableReason = msg;
    dockerInstance = null;
    return { containers: [], error: msg };
  }
}

export async function containerStart(containerName: string): Promise<{ ok: boolean; error?: string }> {
  const docker = getDocker();
  if (!docker) return { ok: false, error: dockerUnavailableReason ?? 'Docker unavailable' };
  try {
    const list = await docker.listContainers({ all: true });
    const c = list.find((x: { Id: string; Names?: string[] }) =>
      x.Names?.some((n: string) => n.replace(/^\//, '') === containerName)
    );
    if (!c) return { ok: false, error: `Container ${containerName} not found` };
    const container = docker.getContainer(c.Id);
    await container.start();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

export async function containerStop(containerName: string): Promise<{ ok: boolean; error?: string }> {
  const docker = getDocker();
  if (!docker) return { ok: false, error: dockerUnavailableReason ?? 'Docker unavailable' };
  try {
    const list = await docker.listContainers({ all: true });
    const c = list.find((x: { Id: string; Names?: string[] }) =>
      x.Names?.some((n: string) => n.replace(/^\//, '') === containerName)
    );
    if (!c) return { ok: false, error: `Container ${containerName} not found` };
    const container = docker.getContainer(c.Id);
    await container.stop();
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/** Get container logs from start. Docker API uses 8-byte header per frame; we strip and concat as text. */
export async function containerLogs(
  containerName: string,
  options?: { tail?: number }
): Promise<{ logs: string; error?: string }> {
  const docker = getDocker();
  if (!docker) return { logs: '', error: dockerUnavailableReason ?? 'Docker unavailable' };
  try {
    const list = await docker.listContainers({ all: true });
    const c = list.find((x: { Id: string; Names?: string[] }) =>
      x.Names?.some((n: string) => n.replace(/^\//, '') === containerName)
    );
    if (!c) return { logs: '', error: `Container ${containerName} not found` };
    const container = docker.getContainer(c.Id);
    const stream = await container.logs({
      follow: false,
      stdout: true,
      stderr: true,
      tail: options?.tail ?? 1000,
    });
    const buf = await streamToBuffer(stream as unknown as Readable);
    // Docker stream: each frame = 8-byte header (1 byte stream type, 3 padding, 4 byte BE size) + payload
    const chunks: string[] = [];
    let i = 0;
    while (i + 8 <= buf.length) {
      const payloadLen = buf.readUInt32BE(i + 4);
      const end = i + 8 + payloadLen;
      if (end > buf.length) break;
      chunks.push(buf.subarray(i + 8, end).toString('utf8'));
      i = end;
    }
    const logs = chunks.join('') || buf.toString('utf8').replace(/\0/g, '');
    return { logs };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { logs: '', error: msg };
  }
}
