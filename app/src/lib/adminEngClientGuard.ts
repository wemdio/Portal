/**
 * Сторож общих админ-роутов /api/admin/users/[id]/* для клиентов английского
 * кабинета (S3b; решение владельца 12.10.2026 — английские клиенты ведутся в
 * отдельном разделе админки «Английские клиенты»).
 *
 * Клиент английского кабинета — profiles.role='client' AND market='eng': то же
 * правило, что у раздела и у readHeEngSendingAccess (engSendingAccess.ts).
 *
 * Зачем. Общие действия /admin/users ломают такой аккаунт:
 *  - удаление или смена роли превращают его в «не клиента»: выключатель
 *    отправки отвечает 'not_client', heEngSendingAccessAllows его пропускает,
 *    ночной добор считает проект проектом сотрудника, а us-проект и его
 *    кампании остаются (he_projects.created_by без FK). Смена роли на
 *    сотрудника вдобавок открывает внутренние инструменты;
 *  - тариф RU (client_tariffs) открывает платные RU-инструменты /api/client/*
 *    (шапка миграции 20261011_0002);
 *  - доступ к RU-кампаниям (client_instantly_access) такому клиенту не нужен;
 *  - включённый внутренний инструмент (user_tool_visibility, enabled=true)
 *    перекрывает умолчание роли: например, salesChatAnalyzer/apiGuard.ts
 *    пускает по такой строке к Анализатору сейлз-переписок, который платит
 *    за LLM.
 *
 * Правила:
 *  - профиля нет → это не английский клиент, роут работает как раньше;
 *  - колонки market нет (42703) → английских клиентов быть не может, как в
 *    readHeEngSendingAccess;
 *  - любой другой сбой чтения → 500, роут ничего не меняет (fail-closed).
 * Действия, которые только закрывают (снять тариф, убрать доступ к кампаниям,
 * вернуть роль «клиент», выключить все инструменты), роуты не сторожат: их
 * проверка не нужна.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logError } from '@/lib/loggerServer';

/** Postgres `undefined_column`: колонки profiles.market ещё нет. */
const PG_UNDEFINED_COLUMN = '42703';

export const ADMIN_ENG_CLIENT_READ_FAILED_TEXT =
  'Не удалось проверить, клиент ли это английского кабинета — попробуйте ещё раз.';
export const ADMIN_ENG_CLIENT_PROJECTS_READ_FAILED_TEXT =
  'Не удалось проверить проекты клиента английского кабинета — попробуйте ещё раз.';
export const ADMIN_ENG_CLIENT_DELETE_TEXT =
  'Клиента английского кабинета с проектом нельзя удалить: его кампании и ночной добор могли бы продолжить работу. Заблокируйте его в разделе «Английские клиенты».';
export const ADMIN_ENG_CLIENT_ROLE_TEXT =
  'Клиенту английского кабинета нельзя сменить роль — он может быть только клиентом. Если этот человек — сотрудник, заведите ему отдельный аккаунт.';
export const ADMIN_ENG_CLIENT_TARIFF_TEXT =
  'Тарифы RU не применяются к клиентам английского кабинета.';
export const ADMIN_ENG_CLIENT_ACCESS_TEXT =
  'Доступ к RU-кампаниям не выдаётся клиентам английского кабинета.';
export const ADMIN_ENG_CLIENT_TOOLS_TEXT =
  'Внутренние инструменты не выдаются клиентам английского кабинета.';

export type AdminEngClientRead =
  | { state: 'eng' }
  | { state: 'not_eng' }
  | { state: 'error'; detail: string };

type LogMeta = Parameters<typeof logError>[3];

function errText(prefix: string, err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : null;
  const message = typeof e?.message === 'string' ? e.message : String(err);
  return `${prefix}: ${code ? `${code} ` : ''}${message}`.slice(0, 300);
}

function refuse(message: string, status: number): NextResponse {
  return NextResponse.json({ error: message }, { status });
}

/** Клиент ли английского кабинета. НЕ БРОСАЕТ. */
export async function readAdminEngClient(db: SupabaseClient, userId: string): Promise<AdminEngClientRead> {
  try {
    const { data, error } = await db
      .from('profiles')
      .select('role, market')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      if ((error as { code?: unknown }).code === PG_UNDEFINED_COLUMN) return { state: 'not_eng' };
      return { state: 'error', detail: errText('profiles read', error) };
    }
    const row = (data ?? null) as { role?: unknown; market?: unknown } | null;
    return row?.role === 'client' && row.market === 'eng' ? { state: 'eng' } : { state: 'not_eng' };
  } catch (e) {
    return { state: 'error', detail: errText('profiles read threw', e) };
  }
}

/**
 * Отказ общего действия для клиента английского кабинета: 409 с `refusal`,
 * сбой чтения — 500. null — не английский клиент, роут продолжает как раньше.
 */
export async function refuseAdminActionForEngClient(
  db: SupabaseClient,
  userId: string,
  opts: { refusal: string; event: string; logMeta?: LogMeta },
): Promise<NextResponse | null> {
  const read = await readAdminEngClient(db, userId);
  if (read.state === 'not_eng') return null;
  if (read.state === 'error') {
    await logError(`${opts.event}.eng_guard.read_failed`, read.detail, { targetUserId: userId }, opts.logMeta);
    return refuse(ADMIN_ENG_CLIENT_READ_FAILED_TEXT, 500);
  }
  return refuse(opts.refusal, 409);
}

/**
 * DELETE /api/admin/users/[id]: клиента английского кабинета, у которого есть
 * хотя бы одна строка he_projects, не удаляем (409). Аккаунт без проекта
 * (регистрация, дальше которой клиент не пошёл) удаляется как раньше.
 * null — удалять можно.
 */
export async function refuseEngClientDelete(
  db: SupabaseClient,
  userId: string,
  logMeta?: LogMeta,
): Promise<NextResponse | null> {
  const read = await readAdminEngClient(db, userId);
  if (read.state === 'not_eng') return null;
  if (read.state === 'error') {
    await logError('admin.users.delete.eng_guard.read_failed', read.detail, { targetUserId: userId }, logMeta);
    return refuse(ADMIN_ENG_CLIENT_READ_FAILED_TEXT, 500);
  }
  let detail: string | null = null;
  let hasProject = false;
  try {
    const { data, error } = await db
      .from('he_projects')
      .select('id')
      .eq('created_by', userId)
      .limit(1);
    if (error) detail = errText('he_projects read', error);
    else hasProject = Array.isArray(data) && data.length > 0;
  } catch (e) {
    detail = errText('he_projects read threw', e);
  }
  if (detail) {
    await logError('admin.users.delete.eng_guard.projects_read_failed', detail, { targetUserId: userId }, logMeta);
    return refuse(ADMIN_ENG_CLIENT_PROJECTS_READ_FAILED_TEXT, 500);
  }
  return hasProject ? refuse(ADMIN_ENG_CLIENT_DELETE_TEXT, 409) : null;
}
