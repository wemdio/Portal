import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError } from '@/lib/loggerServer';
import { isAdmin } from '@/lib/roles';
import type { UserRole } from '@/types';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function isUserExistsError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; message?: unknown; status?: unknown };
  const code = typeof e.code === 'string' ? e.code.toLowerCase() : '';
  const message = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  const status = typeof e.status === 'number' ? e.status : null;

  // Supabase Auth (GoTrue) commonly uses code `user_exists`.
  if (code === 'user_exists') return true;

  // Fallbacks across versions/messages.
  if (message.includes('already') || message.includes('exists') || message.includes('registered')) return true;
  if (status === 409) return true;

  return false;
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

  const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: {
      full_name: fullName,
      role,
    },
  });

  if (createErr) {
    if (isUserExistsError(createErr)) {
      await logAudit('admin.users.create.conflict', 'User already exists', { email, role }, logMeta);
      return jsonError('Пользователь с таким email уже существует', 409);
    }

    const msg = createErr.message || 'Failed to create user';
    await logError('admin.users.create.failed', createErr, { email, role }, logMeta);
    return jsonError(msg, 500);
  }

  const newUserId = created.user?.id;
  if (!newUserId) {
    await logError('admin.users.create.failed', 'Missing created user id', { email, role }, logMeta);
    return jsonError('Не удалось создать пользователя', 500);
  }

  const { error: upsertErr } = await supabaseAdmin
    .from('profiles')
    .upsert({
      id: newUserId,
      email,
      role,
      full_name: fullName,
    });

  if (upsertErr) {
    await logError('admin.users.create.profile.upsert.failed', upsertErr, { targetUserId: newUserId, email, role }, logMeta);
    return jsonError('User created but failed to update profile', 500);
  }

  await logAudit('admin.users.create.success', 'User created', { targetUserId: newUserId, email, role }, logMeta);
  return NextResponse.json({ ok: true, user: { id: newUserId, email, role, full_name: fullName } });
}

