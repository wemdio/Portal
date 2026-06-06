import 'server-only';

import type { NextRequest, NextResponse } from 'next/server';
import { requireClientAuth, jsonError, type ClientAuthResult } from '@/lib/clientApiHelper';

/**
 * Гейт пилота BYO-почт.
 *
 * ВАЖНО (по итогам ревью): фича включается ТОЛЬКО для явного allowlist'а user-id
 * из env `BYO_MAILBOX_PILOT_USER_IDS` (UUID через запятую/пробел/перенос строки).
 * Это жёсткая защита «невидимо по умолчанию»: её НЕЛЬЗЯ включить случайно из
 * админки — массовое сохранение видимости инструментов (user_tool_visibility)
 * на этот флаг НЕ влияет. Пустой env = выключено у всех.
 *
 * Чтобы добавить тестовый аккаунт в пилот: возьми его UUID в /admin/users,
 * добавь в BYO_MAILBOX_PILOT_USER_IDS в .env и перезапусти приложение.
 */

function pilotUserIds(): Set<string> {
  const raw = process.env.BYO_MAILBOX_PILOT_USER_IDS ?? '';
  return new Set(
    raw
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** Включён ли пилот для пользователя (только по env-allowlist'у, без БД). */
export async function isByoMailboxEnabled(userId: string): Promise<boolean> {
  if (!userId) return false;
  return pilotUserIds().has(userId.toLowerCase());
}

/**
 * Аутентифицирует клиента (role=client/admin, режет демо от записи) И проверяет,
 * что пользователь в пилотном allowlist'е. Вернёт { auth } или { error }.
 */
export async function requireByoMailboxClient(
  req: NextRequest,
): Promise<{ auth: ClientAuthResult } | { error: NextResponse }> {
  const res = await requireClientAuth(req);
  if ('error' in res) return res;

  const enabled = await isByoMailboxEnabled(res.auth.userId);
  if (!enabled) {
    return { error: jsonError('Forbidden: byo-mailbox not enabled', 403) };
  }
  return res;
}
