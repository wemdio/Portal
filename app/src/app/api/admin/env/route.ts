import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireAdmin, jsonError } from '@/lib/adminAuth';
import { resolveEnvPath } from '@/lib/envPath';
import fs from 'fs/promises';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const envPath = await resolveEnvPath();
  try {
    const content = await fs.readFile(envPath, 'utf-8');
    return NextResponse.json({ content, path: envPath });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to read .env';
    return jsonError(msg, 500);
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  const envPath = await resolveEnvPath();
  try {
    const body = await req.json() as { content?: string };
    if (typeof body.content !== 'string') {
      return jsonError('Missing content field', 400);
    }

    const normalized = body.content.replace(/\r\n/g, '\n');

    await fs.writeFile(envPath, normalized, 'utf-8');
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to write .env';
    return jsonError(msg, 500);
  }
}
