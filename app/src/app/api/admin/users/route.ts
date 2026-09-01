import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import { createManagedPortalUser } from '@/lib/auth/managedUserProvisioning';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function getUserFromRequest(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) };

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) };

  return { user };
}

type CreateUserBody = {
  email?: unknown;
  password?: unknown;
  role?: unknown;
  full_name?: unknown;
};

export async function POST(req: NextRequest) {
  const auth = await getUserFromRequest(req);
  if ('error' in auth) return auth.error;
  if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

  const { user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  const { data: profile, error: profileError } = await supabaseAdmin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .single();

  if (profileError) {
    await logError('admin.users.create.role.fetch.failed', profileError, {}, logMeta);
    return jsonError('Не удалось проверить права пользователя', 500);
  }

  const actorRole = (profile?.role ?? null) as UserRole | null;
  if (!isAdmin(actorRole)) {
    await logError('admin.users.create.forbidden', 'Forbidden', { actorRole }, logMeta);
    return jsonError('Forbidden', 403);
  }

  const text = await req.text().catch(() => '');
  const body = safeJsonParse<CreateUserBody>(text);

  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password.trim() : '';
  const role = typeof body?.role === 'string' ? (body.role as UserRole) : null;
  const fullNameRaw = typeof body?.full_name === 'string' ? body.full_name.trim() : '';

  if (!email) return jsonError('Missing email', 400);
  if (!password) return jsonError('Missing password', 400);
  if (password.length < 8) return jsonError('Password must be at least 8 characters', 400);
  if (password.length > 72) return jsonError('Password must be at most 72 characters', 400);
  if (!role) return jsonError('Missing role', 400);

  const fullName = fullNameRaw || email.split('@')[0] || '';

  const created = await createManagedPortalUser({
    email,
    password,
    fullName,
    role,
  });

  if (!created.ok) {
    if (created.kind === 'duplicate') {
      await logAudit('admin.users.create.conflict', 'User already exists', { email, role }, logMeta);
      return jsonError('Пользователь с таким email уже существует', 409);
    }

    const event = created.kind === 'profile'
      ? 'admin.users.create.profile.upsert.failed'
      : 'admin.users.create.failed';
    await logError(event, created.error, { email, role }, logMeta);
    if (created.cleanupError) {
      await logError('admin.users.create.cleanup.failed', created.cleanupError, { email, role }, logMeta);
    }
    if (created.kind === 'profile') {
      if (created.cleanupError) {
        return jsonError(
          'Failed to create user profile; account rollback could not be confirmed',
          500,
        );
      }
      return jsonError('Failed to create user profile; account creation was rolled back', 500);
    }
    const message =
      created.error && typeof created.error === 'object' && 'message' in created.error
        ? String(created.error.message || 'Failed to create user')
        : 'Failed to create user';
    return jsonError(message, 500);
  }

  const newUserId = created.user.id;
  await logAudit('admin.users.create.success', 'User created', { targetUserId: newUserId, email, role }, logMeta);
  return NextResponse.json({ ok: true, user: { id: newUserId, email, role, full_name: fullName } });
}

