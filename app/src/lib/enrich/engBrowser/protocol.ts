import http, { type IncomingMessage, type ServerResponse } from 'node:http';

export const RESOURCE_BYTES = 1024 * 1024;
export const SESSION_BYTES = 5 * 1024 * 1024;
export const MAX_RESOURCES = 20;
export const DEFAULT_TIMEOUT = 12_000;
export const MAX_TIMEOUT = 20_000;
export const SOCKET_BODY_MAX = 6 * RESOURCE_BYTES + 16 * 1024;

export class BrowserError extends Error {
  constructor(public readonly code: string) { super(code); }
}

export async function readJson(req: IncomingMessage, limit = 16 * 1024): Promise<Record<string, unknown>> {
  // Absolute body deadline: a slow sender cannot hold a socket indefinitely by trickling bytes.
  const deadline = setTimeout(() => req.destroy(new BrowserError('timeout')), 5_000);
  req.setTimeout(5_000, () => req.destroy(new BrowserError('timeout')));
  try {
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      const data = Buffer.from(chunk); size += data.length;
      if (size > limit) throw new BrowserError('body_limit');
      chunks.push(data);
    }
    try {
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    } catch { throw new BrowserError('bad_request'); }
  } finally { clearTimeout(deadline); if (req.socket) req.setTimeout(0); }
}
export function reply(res: ServerResponse, status: number, value: unknown): void {
  if (!res.destroyed && !res.writableEnded) res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(value));
}
export async function socketJson(socketPath: string, path: string, body: object | null, signal: AbortSignal): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new BrowserError('cancelled')); return; }
    const req = http.request({ socketPath, path, method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : undefined, signal }, res => {
      void readJson(res, SOCKET_BODY_MAX).then(value => {
        if (res.statusCode !== 200) reject(new BrowserError(typeof value.error === 'string' ? value.error : 'unavailable'));
        else resolve(value);
      }, reject);
    });
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
