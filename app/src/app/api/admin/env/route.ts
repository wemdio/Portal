import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';

const ENV_PATH = path.resolve(process.cwd(), '..', '.env');

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdmin(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  if (!supabaseAdmin) return { error: jsonError('Server misconfigured', 500) };

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  const role = (profile?.role ?? null) as UserRole | null;
  if (!isAdmin(role)) return { error: jsonError('Forbidden', 403) };

  return { user };
}

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  try {
    const content = await fs.readFile(ENV_PATH, 'utf-8');
    return NextResponse.json({ content, path: ENV_PATH });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to read .env';
    return jsonError(msg, 500);
  }
}

export async function PUT(req: NextRequest) {
  const auth = await requireAdmin(req);
  if ('error' in auth) return auth.error;

  try {
    const body = await req.json() as { content?: string };
    if (typeof body.content !== 'string') {
      return jsonError('Missing content field', 400);
    }

    const normalized = body.content.replace(/\r\n/g, '\n');

    await fs.writeFile(ENV_PATH, normalized, 'utf-8');
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to write .env';
    return jsonError(msg, 500);
  }
}
