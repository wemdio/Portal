import 'server-only';

import type { NextRequest, NextResponse } from 'next/server';
import { requireClientAuth, jsonError, type ClientAuthResult } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { mailboxConnectAllowed, parseMailboxPilotUserIds } from '@/lib/byoMailbox/accessPolicy';

/**
 * Гейт подключения ящиков.
 *
 * RU-пилот по-прежнему только allowlist `BYO_MAILBOX_PILOT_USER_IDS`
 * (пустой env = у RU выключено). ENG открыт: Host ENG-кабинета или
 * profiles.market='eng'. Иначе форма на app.outreachos.xyz всегда 403.
 *
 * user_tool_visibility на этот флаг по-прежнему не влияет.
 */

function allowlistRaw(): string {
  return process.env.BYO_MAILBOX_PILOT_USER_IDS ?? '';
}

/** RU-навигация «Мои почты»: только явный allowlist, без БД. */
export async function isByoMailboxEnabled(userId: string): Promise<boolean> {
  if (!userId) return false;
  return parseMailboxPilotUserIds(allowlistRaw()).has(userId.toLowerCase());
}

async function profileMarket(userId: string): Promise<string | null> {
  if (!supabaseAdmin) return null;
  const { data } = await supabaseAdmin
    .from('profiles')
    .select('market')
    .eq('id', userId)
    .single<{ market?: string | null }>();
  return data?.market ?? null;
}

/** Можно ли этому запросу вызывать /api/client/mailboxes (подключение + список). */
export async function isMailboxConnectEnabled(userId: string, req: NextRequest): Promise<boolean> {
  if (
    mailboxConnectAllowed({
      userId,
      allowlistRaw: allowlistRaw(),
      host: req.headers.get('host'),
    })
  ) {
    return true;
  }
  return mailboxConnectAllowed({
    userId,
    allowlistRaw: allowlistRaw(),
    host: req.headers.get('host'),
    profileMarket: await profileMarket(userId),
  });
}

/**
 * Аутентифицирует клиента (role=client/admin, режет демо от записи) И проверяет,
 * что подключение ящиков ему разрешено. Вернёт { auth } или { error }.
 */
export async function requireByoMailboxClient(
  req: NextRequest,
): Promise<{ auth: ClientAuthResult } | { error: NextResponse }> {
  const res = await requireClientAuth(req);
  if ('error' in res) return res;

  const enabled = await isMailboxConnectEnabled(res.auth.userId, req);
  if (!enabled) {
    return { error: jsonError('Forbidden: mailbox connect not enabled', 403) };
  }
  return res;
}
