import { NextRequest, NextResponse } from 'next/server';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { randomUUID } from 'crypto';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

type PendingAuth = {
  client: TelegramClient;
  userId: string;
  apiId: number;
  apiHash: string;
  phone: string;
  name: string;
  proxyUrl: string;
  phoneCodeHash: string;
  createdAt: number;
};

const pendingAuths = new Map<string, PendingAuth>();

const TTL_MS = 5 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [id, entry] of pendingAuths) {
    if (now - entry.createdAt > TTL_MS) {
      entry.client.disconnect().catch(() => {});
      pendingAuths.delete(id);
    }
  }
}

function parseProxyUrl(proxyUrl: string) {
  if (!proxyUrl) return undefined;
  try {
    const u = new URL(proxyUrl);
    const protocol = u.protocol.replace(':', '').toLowerCase();
    return {
      ip: u.hostname,
      port: Number(u.port) || 1080,
      username: u.username || undefined,
      password: u.password || undefined,
      socksType: (protocol === 'socks4' ? 4 : 5) as 4 | 5,
    };
  } catch {
    return undefined;
  }
}

async function saveAccount(
  token: string,
  entry: PendingAuth,
  sessionStr: string,
) {
  const supabase = createAuthedSupabaseClient(token);
  const { data, error } = await supabase
    .from('tg_parser_accounts')
    .insert({
      user_id: entry.userId,
      name: entry.name || `Account ${entry.apiId}`,
      api_id: entry.apiId,
      api_hash: entry.apiHash,
      phone: entry.phone,
      session_data: sessionStr,
      proxy_url: entry.proxyUrl,
      is_active: true,
    })
    .select('id, name, api_id, api_hash, phone, proxy_url, is_active, created_at')
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function POST(req: NextRequest) {
  return withToolTrace(
    { request: req, operation: 'tools.tg-parser.accounts.auth.post' },
    async () => {
      
        cleanup();
      
        const token = getBearerToken(req.headers.get('authorization'));
        if (!token) return jsonError('Unauthorized', 401);
      
        const supabase = createAuthedSupabaseClient(token);
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) return jsonError('Unauthorized', 401);
      
        let body: Record<string, unknown>;
        try {
          body = await req.json();
        } catch {
          return jsonError('Invalid JSON body', 400);
        }
      
        const step = body.step as string;
      
        // ─── Step 1: send_code ────────────────────────────────────────────
        if (step === 'send_code') {
          const apiId = Number(body.api_id);
          const apiHash = (body.api_hash as string)?.trim();
          const phone = (body.phone as string)?.trim();
          if (!apiId || !apiHash || !phone) {
            return jsonError('api_id, api_hash и phone обязательны', 400);
          }
      
          const proxyUrl = process.env.TGPARS_PROXY?.trim() ?? '';
          const name = (body.name as string)?.trim() ?? '';
          const proxy = parseProxyUrl(proxyUrl);
      
          const session = new StringSession('');
          const client = new TelegramClient(session, apiId, apiHash, {
            connectionRetries: 3,
            ...(proxy ? { proxy } : {}),
          });
      
          try {
            await client.connect();
      
            const result = await client.invoke(
              new Api.auth.SendCode({
                phoneNumber: phone,
                apiId,
                apiHash,
                settings: new Api.CodeSettings({}),
              }),
            );
      
            const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;
      
            const authId = randomUUID();
            pendingAuths.set(authId, {
              client,
              userId: user.id,
              apiId,
              apiHash,
              phone,
              name,
              proxyUrl,
              phoneCodeHash,
              createdAt: Date.now(),
            });
      
            return NextResponse.json({
              step: 'code_needed',
              auth_id: authId,
              phone_code_hash: phoneCodeHash,
            });
          } catch (e) {
            await client.disconnect().catch(() => {});
            const msg = e instanceof Error ? e.message : String(e);
            return jsonError(`Ошибка отправки кода: ${msg}`, 400);
          }
        }
      
        // ─── Step 2: sign_in ──────────────────────────────────────────────
        if (step === 'sign_in') {
          const authId = body.auth_id as string;
          const code = (body.code as string)?.trim();
          if (!authId || !code) return jsonError('auth_id и code обязательны', 400);
      
          const entry = pendingAuths.get(authId);
          if (!entry) return jsonError('Сессия авторизации не найдена или истекла', 404);
          if (entry.userId !== user.id) return jsonError('Unauthorized', 401);
      
          try {
            await entry.client.invoke(
              new Api.auth.SignIn({
                phoneNumber: entry.phone,
                phoneCodeHash: entry.phoneCodeHash,
                phoneCode: code,
              }),
            );
      
            const sessionStr = (entry.client.session as StringSession).save();
            const account = await saveAccount(token, entry, sessionStr);
            await entry.client.disconnect().catch(() => {});
            pendingAuths.delete(authId);
      
            return NextResponse.json({ step: 'done', account });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('SESSION_PASSWORD_NEEDED')) {
              return NextResponse.json({ step: 'password_needed', auth_id: authId });
            }
            await entry.client.disconnect().catch(() => {});
            pendingAuths.delete(authId);
            return jsonError(`Ошибка входа: ${msg}`, 400);
          }
        }
      
        // ─── Step 3: check_password (2FA) ─────────────────────────────────
        if (step === 'check_password') {
          const authId = body.auth_id as string;
          const password = (body.password as string) ?? '';
          if (!authId || !password) return jsonError('auth_id и password обязательны', 400);
      
          const entry = pendingAuths.get(authId);
          if (!entry) return jsonError('Сессия авторизации не найдена или истекла', 404);
          if (entry.userId !== user.id) return jsonError('Unauthorized', 401);
      
          try {
            const passwordSrp = await entry.client.invoke(new Api.account.GetPassword());
            const srpResult = await computeCheck(passwordSrp, password);
      
            await entry.client.invoke(new Api.auth.CheckPassword({ password: srpResult }));
      
            const sessionStr = (entry.client.session as StringSession).save();
            const account = await saveAccount(token, entry, sessionStr);
            await entry.client.disconnect().catch(() => {});
            pendingAuths.delete(authId);
      
            return NextResponse.json({ step: 'done', account });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('PASSWORD_HASH_INVALID')) {
              return jsonError('Неверный пароль 2FA', 400);
            }
            await entry.client.disconnect().catch(() => {});
            pendingAuths.delete(authId);
            return jsonError(`Ошибка 2FA: ${msg}`, 400);
          }
        }
      
        return jsonError('Неизвестный step. Ожидается: send_code, sign_in, check_password', 400);
    },
  );
}
