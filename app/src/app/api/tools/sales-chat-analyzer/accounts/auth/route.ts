import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { Api } from 'telegram';
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

interface PendingAuthPayload {
  session: string;
  phoneCodeHash: string;
  phone: string;
  userId: string;
  label: string;
  createdAt: number;
}

const TTL_MS = 5 * 60 * 1000;

const LOG_PREFIX = '[scA][auth]';
function log(event: string, fields: Record<string, unknown> = {}) {
  // eslint-disable-next-line no-console
  console.error(
    `${LOG_PREFIX} pid=${process.pid} event=${event} ${JSON.stringify(fields)}`,
  );
}

function sealAuth(payload: PendingAuthPayload): string {
  return encryptJsonAes256Gcm(payload, getSalesChatCipherKey());
}

function unsealAuth(token: string): PendingAuthPayload {
  return decryptJsonAes256Gcm<PendingAuthPayload>(token, getSalesChatCipherKey());
}

function sentTypeLabel(className: string | undefined | null): string {
  const name = className?.replace(/^auth\./, '') ?? '';
  switch (name) {
    case 'SentCodeTypeApp':
      return 'app';
    case 'SentCodeTypeSms':
      return 'sms';
    case 'SentCodeTypeCall':
      return 'call';
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

/** Сохраняет авторизованный аккаунт: шифрует сессию, тянет мета через getMe. */
async function saveAccount(
  client: import('telegram').TelegramClient,
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
    // мета не критична — продолжаем без неё
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
      const sessionStr = (client.session as StringSession).save();

      await client.disconnect().catch(() => {});

      const authToken = sealAuth({
        session: sessionStr,
        phoneCodeHash,
        phone,
        userId: guard.userId,
        label,
        createdAt: Date.now(),
      });

      const sentType = sentTypeLabel(sent.type?.className);

      log('send_code_ok', {
        user_id: guard.userId,
        phone,
        sent_type: sentType,
        sent_type_raw: sent.type?.className ?? null,
        result_class: result?.className ?? null,
        next_type: sent.nextType?.className ?? null,
        timeout: sent.timeout ?? null,
        phone_code_hash_prefix: phoneCodeHash.slice(0, 6),
      });

      return NextResponse.json({
        step: 'code_needed',
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

  // ─── Шаг 1b: resend_code ──────────────────────────────────────────
  if (step === 'resend_code') {
    const tokenStr = body.auth_token as string;
    if (!tokenStr) return jsonError('auth_token обязателен', 400);

    let payload: PendingAuthPayload;
    try {
      payload = unsealAuth(tokenStr);
    } catch {
      return jsonError('Невалидный или повреждённый auth_token', 400);
    }
    if (payload.userId !== guard.userId) return jsonError('Unauthorized', 401);
    if (Date.now() - payload.createdAt > TTL_MS) {
      return jsonError('Сессия авторизации истекла. Начните заново.', 410);
    }

    const client = createSalesChatClient(payload.session);
    try {
      await client.connect();
      const result = await client.invoke(
        new Api.auth.ResendCode({
          phoneNumber: payload.phone,
          phoneCodeHash: payload.phoneCodeHash,
        }),
      );
      const sent = result as Api.auth.SentCode;
      const newPhoneCodeHash = sent.phoneCodeHash;
      const newSessionStr = (client.session as StringSession).save();

      await client.disconnect().catch(() => {});

      const newToken = sealAuth({
        ...payload,
        session: newSessionStr,
        phoneCodeHash: newPhoneCodeHash,
        createdAt: Date.now(),
      });

      const sentType = sentTypeLabel(sent.type?.className);

      log('resend_code_ok', {
        user_id: guard.userId,
        phone: payload.phone,
        sent_type: sentType,
        next_type: sent.nextType?.className ?? null,
        timeout: sent.timeout ?? null,
      });

      return NextResponse.json({
        step: 'code_needed',
        auth_token: newToken,
        sent_type: sentType,
        next_type: sentTypeLabel(sent.nextType?.className),
        timeout: sent.timeout ?? null,
      });
    } catch (e) {
      await client.disconnect().catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      log('resend_code_fail', { phone: payload.phone, error: msg });
      return jsonError(`Не удалось повторно отправить код: ${msg}`, 400);
    }
  }

  // ─── Шаг 2: sign_in ─────────────────────────────────────────────────
  if (step === 'sign_in') {
    const tokenStr = body.auth_token as string;
    const code = (body.code as string)?.trim();
    if (!tokenStr || !code) return jsonError('auth_token и code обязательны', 400);

    let payload: PendingAuthPayload;
    try {
      payload = unsealAuth(tokenStr);
    } catch {
      return jsonError('Невалидный или повреждённый auth_token', 400);
    }
    if (payload.userId !== guard.userId) {
      log('sign_in_user_mismatch', { owner: payload.userId, requester: guard.userId });
      return jsonError('Unauthorized', 401);
    }
    if (Date.now() - payload.createdAt > TTL_MS) {
      return jsonError('Сессия авторизации истекла. Начните заново.', 410);
    }

    const client = createSalesChatClient(payload.session);
    try {
      await client.connect();
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: payload.phone,
          phoneCodeHash: payload.phoneCodeHash,
          phoneCode: code,
        }),
      );
      const account = await saveAccount(client, payload.userId, payload.phone, payload.label);
      await client.disconnect().catch(() => {});
      log('sign_in_ok', { user_id: guard.userId, phone: payload.phone });
      return NextResponse.json({ step: 'done', account });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('SESSION_PASSWORD_NEEDED')) {
        const updatedSession = (client.session as StringSession).save();
        await client.disconnect().catch(() => {});
        const newToken = sealAuth({
          ...payload,
          session: updatedSession,
        });
        log('sign_in_2fa_required', { user_id: guard.userId });
        return NextResponse.json({ step: 'password_needed', auth_token: newToken });
      }
      await client.disconnect().catch(() => {});
      log('sign_in_fail', { user_id: guard.userId, error: msg });
      return jsonError(`Ошибка входа: ${msg}`, 400);
    }
  }

  // ─── Шаг 3: check_password (2FA) ────────────────────────────────────
  if (step === 'check_password') {
    const tokenStr = body.auth_token as string;
    const password = (body.password as string) ?? '';
    if (!tokenStr || !password) return jsonError('auth_token и password обязательны', 400);

    let payload: PendingAuthPayload;
    try {
      payload = unsealAuth(tokenStr);
    } catch {
      return jsonError('Невалидный или повреждённый auth_token', 400);
    }
    if (payload.userId !== guard.userId) {
      log('check_password_user_mismatch', { owner: payload.userId, requester: guard.userId });
      return jsonError('Unauthorized', 401);
    }
    if (Date.now() - payload.createdAt > TTL_MS) {
      return jsonError('Сессия авторизации истекла. Начните заново.', 410);
    }

    const client = createSalesChatClient(payload.session);
    try {
      await client.connect();
      const passwordSrp = await client.invoke(new Api.account.GetPassword());
      const srpResult = await computeCheck(passwordSrp, password);
      await client.invoke(new Api.auth.CheckPassword({ password: srpResult }));

      const account = await saveAccount(client, payload.userId, payload.phone, payload.label);
      await client.disconnect().catch(() => {});
      log('check_password_ok', { user_id: guard.userId });
      return NextResponse.json({ step: 'done', account });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await client.disconnect().catch(() => {});
      if (msg.includes('PASSWORD_HASH_INVALID')) {
        log('check_password_invalid', { user_id: guard.userId });
        return jsonError('Неверный пароль 2FA', 400);
      }
      log('check_password_fail', { user_id: guard.userId, error: msg });
      return jsonError(`Ошибка 2FA: ${msg}`, 400);
    }
  }

  log('unknown_step', { step });
  return jsonError('Неизвестный step. Ожидается: send_code, resend_code, sign_in, check_password', 400);
}
