import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin, jsonError } from '@/lib/adminAuth';
import { resolveEnvPath } from '@/lib/envPath';
import { config as dotenvConfig } from 'dotenv';

export const dynamic = 'force-dynamic';

/**
 * In dev mode (no cluster), re-read .env into process.env directly.
 * In production cluster mode, IPC tells the master to do a rolling restart.
 */
export async function POST(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  try {
    const envPath = await resolveEnvPath();

    if (typeof process.send === 'function') {
      process.send({ type: 'reload-env' });
      return NextResponse.json({
        ok: true,
        mode: 'cluster',
        message: 'Rolling restart initiated',
      });
    }

    dotenvConfig({ path: envPath, override: true });
    return NextResponse.json({
      ok: true,
      mode: 'dev',
      message: 'Environment reloaded in current process',
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to reload environment';
    return jsonError(msg, 500);
  }
}
