import 'server-only';

import { NextResponse, type NextRequest } from 'next/server';
import { requireClientAuth, jsonError, type ClientAuthResult } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import {
  ENG_OWN_MAILBOX_UNAVAILABLE_CODE,
  ENG_OWN_MAILBOX_UNAVAILABLE_TEXT,
  mailboxConnectAllowed,
  ownMailboxConnectRefused,
  parseMailboxPilotUserIds,
} from '@/lib/byoMailbox/accessPolicy';

/**
 * Гейт подключения ящиков.
 *
 * RU-пилот по-прежнему только allowlist `BYO_MAILBOX_PILOT_USER_IDS`
 * (пустой env = у RU выключено). ENG гейт пропускает (Host ENG-кабинета или
 * profiles.market='eng') — к ящикам, подключённым раньше; ПОДКЛЮЧИТЬ новый
 * ENG-клиент не может: refuseOwnMailboxConnectForEng ниже в каждой точке
 * подключения.
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

/**
 * Точка подключения ящика (POST /api/client/mailboxes, старт OAuth) для
 * ENG-клиента: 403 с английской фразой и кодом (accessPolicy,
 * ENG_OWN_MAILBOX_UNAVAILABLE_*); null — не ENG, путь идёт дальше без
 * изменений. Звать сразу после requireByoMailboxClient.
 */
export function refuseOwnMailboxConnectForEng(auth: ClientAuthResult): NextResponse | null {
  if (!ownMailboxConnectRefused(auth.market)) return null;
  return NextResponse.json(
    { error: ENG_OWN_MAILBOX_UNAVAILABLE_TEXT, code: ENG_OWN_MAILBOX_UNAVAILABLE_CODE },
    { status: 403 },
  );
}
