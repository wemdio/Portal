/**
 * Выключатель отправки аккаунта у платных роутов подготовки кабинета (S3b) —
 * одна проверка на пять роутов: «Collect again» (POST …/verticals/[id]/collect)
 * и «Rewrite letters» (POST …/templates/[id]/rewrite) шага 3, а также три
 * роута, которые кабинет сейчас не зовёт и куда приходят только прямые
 * запросы и старые бандлы: прежняя кнопка автопилота
 * (POST …/projects/[id]/autopilot), цепочка (POST …/verticals/[id]/chain) и
 * шаблон (POST …/bases/[id]/template).
 *
 * Та же проверка и те же ответы, что у «Launch» проекта
 * (POST …/projects/[id]/launch), до гейта платных шагов: эти роуты платят за
 * подготовку отправки, а отправку сотрудник выключил — значит, оплачено было
 * бы зря. 'revoked' — 403 sending_turned_off; сбой чтения — 503 (сбой мог
 * скрыть выключение, fail-closed); нет таблицы выключателя (миграция
 * 20261011_0002) — 503 и алерт команде через общий гейт
 * (requireHeEngSendingAccess); 'not_enabled' пускает: подготовка идёт, старт
 * подождёт разовой проверки. null — можно дальше.
 */

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { logWarn } from '@/lib/loggerServer';
import {
  ENG_SENDING_ACCESS_PROBLEM_TEXT,
  ENG_SENDING_TURNED_OFF_TEXT,
  readHeEngSendingAccess,
  requireHeEngSendingAccess,
} from './engSendingAccess';
import { ENG_PAID_UNAVAILABLE_TEXT } from './engPaidAccess';

export async function engSendingSwitchRefusal(
  db: SupabaseClient,
  userId: string,
  projectId: string | null,
  event: string,
): Promise<NextResponse | null> {
  const sending = await readHeEngSendingAccess(db, userId);
  if (sending.state === 'revoked') {
    return NextResponse.json({ error: ENG_SENDING_TURNED_OFF_TEXT, code: 'sending_turned_off' }, { status: 403 });
  }
  if (sending.state === 'error') {
    void logWarn(event, sending.detail ?? 'sending switch read failed', { userId, projectId });
    return NextResponse.json({ error: ENG_PAID_UNAVAILABLE_TEXT, code: 'unavailable' }, { status: 503 });
  }
  if (sending.state === 'unavailable') {
    await requireHeEngSendingAccess(db, userId, { projectId, via: 'launch' });
    return NextResponse.json({ error: ENG_SENDING_ACCESS_PROBLEM_TEXT, code: 'sending_access_unavailable' }, { status: 503 });
  }
  return null;
}
