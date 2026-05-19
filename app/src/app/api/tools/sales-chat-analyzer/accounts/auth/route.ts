import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { randomUUID } from 'crypto';
import { Api, type TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { computeCheck } from 'telegram/Password';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';
import { createSalesChatClient } from '@/lib/salesChatAnalyzer/gramClient';
import { getSalesChatApiCreds } from '@/lib/salesChatAnalyzer/config';
import { sealSession } from '@/lib/salesChatAnalyzer/session';
import { bigToNum } from '@/lib/salesChatAnalyzer/messageMapper';
import { ACCOUNT_PUBLIC_COLUMNS } from '../route';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

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

function cleanup() {
  const now = Date.now();
  for (const [id, entry] of pendingAuths) {
    if (now - entry.createdAt > TTL_MS) {
      entry.client.disconnect().catch(() => {});
      pendingAuths.delete(id);
    }
  }
}

/** Сохраняет авторизованный аккаунт: шифрует сессию, тянет мета через getMe. */
async function saveAccount(entry: PendingAuth) {
  const sessionStr = (entry.client.session as StringSession).save();
  const sealed = sealSession(sessionStr);

  let tgUserId: number | null = null;
  let username: string | null = null;
  let firstName: string | null = null;
  let lastName: string | null = null;
  try {
    const me = await entry.client.getMe();
    if (me instanceof Api.User) {
      tgUserId = bigToNum(me.id);
      username = me.username ?? null;
      firstName = me.firstName ?? null;
      lastName = me.lastName ?? null;
    }
  } catch {
    // мета не критична — продолжаем без неё
  }

  const label =
    entry.label || [firstName, lastName].filter(Boolean).join(' ') || username || entry.phone;

  const { data, error } = await supabaseAdmin!
    .from('sales_chat_accounts')
    .insert({
      created_by: entry.userId,
      label,
      phone: entry.phone,
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
      const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;

      const authId = randomUUID();
      pendingAuths.set(authId, {
        client,
        userId: guard.userId,
        label,
        phone,
        phoneCodeHash,
        createdAt: Date.now(),
      });
      return NextResponse.json({ step: 'code_needed', auth_id: authId });
    } catch (e) {
      await client.disconnect().catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      return jsonError(`Не удалось отправить код: ${msg}`, 400);
    }
  }

  // ─── Шаг 2: sign_in ─────────────────────────────────────────────────
  if (step === 'sign_in') {
    const authId = body.auth_id as string;
    const code = (body.code as string)?.trim();
    if (!authId || !code) return jsonError('auth_id и code обязательны', 400);

    const entry = pendingAuths.get(authId);
    if (!entry) return jsonError('Сессия авторизации не найдена или истекла', 404);
    if (entry.userId !== guard.userId) return jsonError('Unauthorized', 401);

    try {
      await entry.client.invoke(
        new Api.auth.SignIn({
          phoneNumber: entry.phone,
          phoneCodeHash: entry.phoneCodeHash,
          phoneCode: code,
        }),
      );
      const account = await saveAccount(entry);
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

  // ─── Шаг 3: check_password (2FA) ────────────────────────────────────
  if (step === 'check_password') {
    const authId = body.auth_id as string;
    const password = (body.password as string) ?? '';
    if (!authId || !password) return jsonError('auth_id и password обязательны', 400);

    const entry = pendingAuths.get(authId);
    if (!entry) return jsonError('Сессия авторизации не найдена или истекла', 404);
    if (entry.userId !== guard.userId) return jsonError('Unauthorized', 401);

    try {
      const passwordSrp = await entry.client.invoke(new Api.account.GetPassword());
      const srpResult = await computeCheck(passwordSrp, password);
      await entry.client.invoke(new Api.auth.CheckPassword({ password: srpResult }));

      const account = await saveAccount(entry);
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
}
