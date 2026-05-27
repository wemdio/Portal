import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { Api, type TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { encryptJsonAes256Gcm, decryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';
import { createSalesChatClient } from '@/lib/salesChatAnalyzer/gramClient';
import { getSalesChatApiCreds, getSalesChatCipherKey } from '@/lib/salesChatAnalyzer/config';
import { sealSession } from '@/lib/salesChatAnalyzer/session';
import { bigToNum } from '@/lib/salesChatAnalyzer/messageMapper';
import { ACCOUNT_PUBLIC_COLUMNS } from '../route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

// ─── In-memory Map (primary, same-worker) ─────────────────────────────
// Telegram не доставляет код, если запрашивающая сессия отключена.
// Поэтому клиент живёт в памяти до завершения авторизации.
// Для кросс-воркерного fallback (WEB_CONCURRENCY=8) вместе с authId
// возвращаем зашифрованный auth_token с сессией + phoneCodeHash.

type PendingAuth = {
  client: TelegramClient;
  userId: string;
  label: string;
  phone: string;
  phoneCodeHash: string;
  createdAt: number;
};

const pendingAuths = new Map<string, PendingAuth>();
const TTL_MS = 5 * 60 * 1000;

interface AuthTokenPayload {
  session: string;
  phoneCodeHash: string;
  phone: string;
  userId: string;
  label: string;
  createdAt: number;
}

const LOG_PREFIX = '[scA][auth]';
function log(event: string, fields: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.error(
    `${LOG_PREFIX} pid=${process.pid} pending=${pendingAuths.size} event=${event} ${JSON.stringify(fields)}`,
  );
}

function cleanup() {
  const now = Date.now();
  let removed = 0;
  for (const [id, entry] of pendingAuths) {
    if (now - entry.createdAt > TTL_MS) {
      entry.client.disconnect().catch(() => {});
      pendingAuths.delete(id);
      removed += 1;
    }
  }
  if (removed > 0) log('cleanup_expired', { removed });
}

function sealAuth(payload: AuthTokenPayload): string {
  return encryptJsonAes256Gcm(payload, getSalesChatCipherKey());
}

function unsealAuth(token: string): AuthTokenPayload {
  return decryptJsonAes256Gcm<AuthTokenPayload>(token, getSalesChatCipherKey());
}

function sentTypeLabel(className: string | undefined | null): string {
  const name = className?.replace(/^auth\./, '') ?? '';
  switch (name) {
    case 'SentCodeTypeApp':
      return 'app';
    case 'SentCodeTypeSms':
      return 'sms';
    case 'SentCodeTypeCall':
    case 'SentCodeTypeFlashCall':
    case 'SentCodeTypeMissedCall':
      return 'call';
    case 'SentCodeTypeFragmentSms':
      return 'fragment_sms';
    case 'SentCodeTypeEmailCode':
      return 'email';
    case 'SentCodeTypeFirebaseSms':
      return 'firebase_sms';
    case 'SentCodeTypeSetUpEmailRequired':
      return 'email_setup_required';
    default:
      return 'unknown';
  }
}

/** Получает live-клиент из Map или восстанавливает из токена (cross-worker). */
async function resolveAuth(
  authId: string | undefined,
  authTokenStr: string | undefined,
  userId: string,
): Promise<{ entry: PendingAuth; authId: string; fromToken: boolean } | { error: string; status: number }> {
  // 1. Пробуем in-memory (same worker)
  if (authId) {
    const entry = pendingAuths.get(authId);
    if (entry) {
      if (entry.userId !== userId) return { error: 'Unauthorized', status: 401 };
      return { entry, authId, fromToken: false };
    }
  }
  // 2. Fallback: восстанавливаем из токена (cross-worker)
  if (authTokenStr) {
    let payload: AuthTokenPayload;
    try {
      payload = unsealAuth(authTokenStr);
    } catch {
      return { error: 'Невалидный auth_token', status: 400 };
    }
    if (payload.userId !== userId) return { error: 'Unauthorized', status: 401 };
    if (Date.now() - payload.createdAt > TTL_MS) {
      return { error: 'Сессия авторизации истекла. Начните заново.', status: 410 };
    }
    const client = createSalesChatClient(payload.session);
    await client.connect();
    const newId = authId || randomUUID();
    const entry: PendingAuth = {
      client,
      userId: payload.userId,
      label: payload.label,
      phone: payload.phone,
      phoneCodeHash: payload.phoneCodeHash,
      createdAt: payload.createdAt,
    };
    pendingAuths.set(newId, entry);
    log('restored_from_token', { auth_id: newId, user_id: userId });
    return { entry, authId: newId, fromToken: true };
  }
  return { error: 'Сессия авторизации не найдена. Начните заново.', status: 404 };
}

function buildAuthToken(entry: PendingAuth): string {
  return sealAuth({
    session: (entry.client.session as StringSession).save(),
    phoneCodeHash: entry.phoneCodeHash,
    phone: entry.phone,
    userId: entry.userId,
    label: entry.label,
    createdAt: entry.createdAt,
  });
}

/** Сохраняет авторизованный аккаунт. */
async function saveAccount(
  client: TelegramClient,
  userId: string,
  phone: string,
  label: string,
) {
  const sessionStr = (client.session as StringSession).save();
  const sealed = sealSession(sessionStr);

  let tgUserId: number | null = null;
  let username: string | null = null;
  let firstName: string | null = null;
  let lastName: string | null = null;
  try {
    const me = await client.getMe();
    if (me instanceof Api.User) {
      tgUserId = bigToNum(me.id);
      username = me.username ?? null;
      firstName = me.firstName ?? null;
      lastName = me.lastName ?? null;
    }
  } catch {
    // мета не критична
  }

  const displayLabel =
    label || [firstName, lastName].filter(Boolean).join(' ') || username || phone;

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_accounts')
    .insert({
      created_by: userId,
      label: displayLabel,
      phone,
      tg_user_id: tgUserId,
      tg_username: username,
      tg_first_name: firstName,
      tg_last_name: lastName,
      session_sealed: sealed,
      status: 'active',
      backfill_status: 'pending',
    })
    .select(ACCOUNT_PUBLIC_COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function POST(req: NextRequest) {
  cleanup();

  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError('Invalid JSON body', 400);
  }

  const step = body.step as string;

  // ─── Шаг 1: send_code ───────────────────────────────────────────────
  if (step === 'send_code') {
    const phone = (body.phone as string)?.trim();
    if (!phone) return jsonError('Укажите номер телефона', 400);

    let apiId: number;
    let apiHash: string;
    try {
      ({ apiId, apiHash } = getSalesChatApiCreds());
    } catch (e) {
      return jsonError(e instanceof Error ? e.message : 'Нет API-ключей Telegram', 500);
    }

    const label = (body.label as string)?.trim() ?? '';
    const client = createSalesChatClient('');

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
      const sent = result as Api.auth.SentCode;
      const phoneCodeHash = sent.phoneCodeHash;

      const authId = randomUUID();
      const entry: PendingAuth = {
        client,
        userId: guard.userId,
        label,
        phone,
        phoneCodeHash,
        createdAt: Date.now(),
      };
      pendingAuths.set(authId, entry);

      const authToken = buildAuthToken(entry);
      const sentType = sentTypeLabel(sent.type?.className);

      log('send_code_ok', {
        auth_id: authId,
        user_id: guard.userId,
        phone,
        sent_type: sentType,
        sent_type_raw: sent.type?.className ?? null,
        next_type: sent.nextType?.className ?? null,
        timeout: sent.timeout ?? null,
        phone_code_hash_prefix: phoneCodeHash.slice(0, 6),
      });

      return NextResponse.json({
        step: 'code_needed',
        auth_id: authId,
        auth_token: authToken,
        sent_type: sentType,
        next_type: sentTypeLabel(sent.nextType?.className),
        timeout: sent.timeout ?? null,
      });
    } catch (e) {
      await client.disconnect().catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      log('send_code_fail', { phone, error: msg });
      return jsonError(`Не удалось отправить код: ${msg}`, 400);
    }
  }

  // ─── Шаг 2: sign_in ─────────────────────────────────────────────────
  if (step === 'sign_in') {
    const code = (body.code as string)?.trim();
    if (!code) return jsonError('code обязателен', 400);

    const resolved = await resolveAuth(
      body.auth_id as string | undefined,
      body.auth_token as string | undefined,
      guard.userId,
    );
    if ('error' in resolved) return jsonError(resolved.error, resolved.status);
    const { entry, authId, fromToken } = resolved;

    try {
      await entry.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: entry.phone,
          phoneCodeHash: entry.phoneCodeHash,
          phoneCode: code,
        }),
      );
      const account = await saveAccount(entry.client, entry.userId, entry.phone, entry.label);
      await entry.client.disconnect().catch(() => {});
      pendingAuths.delete(authId);
      log('sign_in_ok', { auth_id: authId, user_id: guard.userId, phone: entry.phone, fromToken });
      return NextResponse.json({ step: 'done', account });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        const newToken = buildAuthToken(entry);
        log('sign_in_2fa_required', { auth_id: authId, user_id: guard.userId });
        return NextResponse.json({ step: 'password_needed', auth_id: authId, auth_token: newToken });
      }
      await entry.client.disconnect().catch(() => {});
      pendingAuths.delete(authId);
      log('sign_in_fail', { auth_id: authId, user_id: guard.userId, error: msg, fromToken });
      return jsonError(`Ошибка входа: ${msg}`, 400);
    }
  }

  // ─── Шаг 3: check_password (2FA) ────────────────────────────────────
  if (step === 'check_password') {
    const password = (body.password as string) ?? '';
    if (!password) return jsonError('password обязателен', 400);

    const resolved = await resolveAuth(
      body.auth_id as string | undefined,
      body.auth_token as string | undefined,
      guard.userId,
    );
    if ('error' in resolved) return jsonError(resolved.error, resolved.status);
    const { entry, authId, fromToken } = resolved;

    try {
      const passwordSrp = await entry.client.invoke(new Api.account.GetPassword());
      const srpResult = await computeCheck(passwordSrp, password);
      await entry.client.invoke(new Api.auth.CheckPassword({ password: srpResult }));

      const account = await saveAccount(entry.client, entry.userId, entry.phone, entry.label);
      await entry.client.disconnect().catch(() => {});
      pendingAuths.delete(authId);
      log('check_password_ok', { auth_id: authId, user_id: guard.userId, fromToken });
      return NextResponse.json({ step: 'done', account });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await entry.client.disconnect().catch(() => {});
      pendingAuths.delete(authId);
      if (msg.includes('PASSWORD_HASH_INVALID')) {
        log('check_password_invalid', { auth_id: authId, user_id: guard.userId });
        return jsonError('Неверный пароль 2FA', 400);
      }
      log('check_password_fail', { auth_id: authId, user_id: guard.userId, error: msg, fromToken });
      return jsonError(`Ошибка 2FA: ${msg}`, 400);
    }
  }

  log('unknown_step', { step });
  return jsonError('Неизвестный step. Ожидается: send_code, sign_in, check_password', 400);
}
