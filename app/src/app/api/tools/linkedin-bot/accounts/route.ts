import { NextRequest, NextResponse } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { encryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function getEncryptionKey(): string | null {
  const key = process.env.LINKEDIN_CREDS_ENCRYPTION_KEY?.trim();
  return key || null;
}

export async function GET(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.linkedin-bot.accounts.get' },
    async () => {
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);

        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);

        const { data, error } = await supabase
          .from('linkedin_accounts')
          .select('id, name, login, is_active, created_at')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true });

        if (error) return jsonError(error.message, 500);
        return NextResponse.json({ items: data ?? [] });
    },
  );
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.linkedin-bot.accounts.post' },
    async () => {
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);

        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);

        const encKey = getEncryptionKey();
        if (!encKey) return jsonError('LINKEDIN_CREDS_ENCRYPTION_KEY not configured', 500);

        let body: { name?: string; login?: string; password?: string };
        try {
          body = await req.json();
        } catch {
          return jsonError('Invalid JSON body', 400);
        }

        const login = (body.login as string)?.trim();
        const password = (body.password as string)?.trim();
        if (!login || !password) {
          return jsonError('login и password обязательны', 400);
        }

        const name = (body.name as string)?.trim() || login;

        const passwordEncrypted = encryptJsonAes256Gcm({ password }, encKey);

        const { data, error } = await supabase
          .from('linkedin_accounts')
          .insert({
            user_id: user.id,
            name,
            login,
            password_encrypted: passwordEncrypted,
            is_active: true,
          })
          .select('id, name, login, is_active, created_at')
          .single();

        if (error) return jsonError(error.message, 500);
        return NextResponse.json(data, { status: 201 });
    },
  );
}
