import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import {
  COLDY_DEFAULT_URL,
  maskEmail,
  sealColdyCredentials,
} from '@/lib/tools/polzaReports/credentials';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

async function authed(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401) } as const;

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { error: jsonError('Unauthorized', 401) } as const;

  return { supabase, user } as const;
}

export async function GET(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;

  const { data, error } = await auth.supabase
    .from('polza_coldy_credentials')
    .select('email_hint, url, updated_at')
    .eq('user_id', auth.user.id)
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!data) return NextResponse.json({ credentials: null });

  return NextResponse.json({
    credentials: {
      email_hint: data.email_hint,
      url: data.url || COLDY_DEFAULT_URL,
      updated_at: data.updated_at,
    },
  });
}

export async function PUT(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;

  let body: { email?: string; password?: string; url?: string };
  try {
    body = (await req.json()) as { email?: string; password?: string; url?: string };
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const email = (body.email ?? '').trim();
  const password = (body.password ?? '').toString();
  const url = ((body.url ?? '').trim() || COLDY_DEFAULT_URL).replace(/\/+$/, '');

  if (!email || !password) {
    return jsonError('Email и пароль обязательны', 400);
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return jsonError('Невалидный email', 400);
  }
  // URL sanity check — Coldy URLs should be http(s).
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return jsonError('URL Coldy должен начинаться с http:// или https://', 400);
    }
  } catch {
    return jsonError('Невалидный URL Coldy', 400);
  }

  let sealed: string;
  try {
    sealed = sealColdyCredentials({ email, password, url });
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : 'Не удалось зашифровать данные',
      500,
    );
  }

  const { error } = await auth.supabase
    .from('polza_coldy_credentials')
    .upsert(
      {
        user_id: auth.user.id,
        sealed_credentials: sealed,
        email_hint: maskEmail(email),
        url,
      },
      { onConflict: 'user_id' },
    );

  if (error) return jsonError(error.message, 500);

  return NextResponse.json({
    credentials: {
      email_hint: maskEmail(email),
      url,
      updated_at: new Date().toISOString(),
    },
  });
}

export async function DELETE(req: NextRequest) {
  const auth = await authed(req);
  if ('error' in auth) return auth.error;

  const { error } = await auth.supabase
    .from('polza_coldy_credentials')
    .delete()
    .eq('user_id', auth.user.id);

  if (error) return jsonError(error.message, 500);
  return NextResponse.json({ ok: true });
}
