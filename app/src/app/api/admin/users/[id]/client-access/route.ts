import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function requireAdminAuth(req: NextRequest) {
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

  if (!isAdmin((profile?.role ?? null) as UserRole | null)) {
    return { error: jsonError('Forbidden', 403) };
  }

  return { user };
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { id: targetUserId } = await ctx.params;

  const { data: rows, error } = await supabaseInstantly
    .from('client_instantly_access')
    .select('id, resource_type, resource_id, created_at')
    .eq('client_user_id', targetUserId)
    .order('created_at', { ascending: false });

  if (error) {
    await logError('admin.client-access.get.failed', error, { targetUserId });
    return jsonError('Failed to load client access', 500);
  }

  return NextResponse.json({ rows: rows ?? [] });
}

type SetAccessBody = {
  campaigns?: string[];
};

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireAdminAuth(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);
  if (!supabaseInstantly) return jsonError('Server misconfigured', 500);

  const { user } = auth;
  const { id: targetUserId } = await ctx.params;
  const logMeta = { userId: user.id, targetUserId };

  let body: SetAccessBody;
  try {
    body = (await req.json()) as SetAccessBody;
  } catch {
    return jsonError('Invalid body', 400);
  }

  const campaigns = Array.isArray(body.campaigns) ? body.campaigns.filter((s): s is string => typeof s === 'string' && s.trim().length > 0) : [];

  const { error: delErr } = await supabaseInstantly
    .from('client_instantly_access')
    .delete()
    .eq('client_user_id', targetUserId);

  if (delErr) {
    await logError('admin.client-access.put.delete.failed', delErr, {}, logMeta);
    return jsonError('Failed to update client access', 500);
  }

  const newRows = campaigns.map((id) => ({
    client_user_id: targetUserId,
    resource_type: 'campaign' as const,
    resource_id: id.trim(),
    created_by: user.id,
  }));

  if (newRows.length > 0) {
    const { error: insErr } = await supabaseInstantly
      .from('client_instantly_access')
      .insert(newRows);

    if (insErr) {
      await logError('admin.client-access.put.insert.failed', insErr, { count: newRows.length }, logMeta);
      return jsonError('Failed to save client access', 500);
    }
  }

  await logAudit(
    'admin.client-access.put.success',
    'Client access updated',
    { campaigns: campaigns.length },
    logMeta,
  );

  return NextResponse.json({ ok: true, campaigns: campaigns.length });
}
