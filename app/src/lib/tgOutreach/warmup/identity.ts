/**
 * Прогрев: узнать, кто такой сам аккаунт.
 *
 * В tg_outreach_accounts исторически нет ни tg_user_id, ни username — боевому
 * циклу они не нужны, он всегда отвечает уже известному собеседнику. Прогреву
 * нужны: чтобы аккаунт А написал аккаунту Б первым, надо знать, как Б адресовать.
 */
import type { TelegramClient } from 'telegram';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Api } from 'telegram';
import type { OutreachAccount } from '../types';
import { withTimeout } from '../withTimeout';
import { normalizePhone } from './peer';

export interface AccountIdentity {
  tg_user_id: number | null;
  tg_username: string | null;
  phone: string | null;
}

/**
 * Сколько ждать ответа Telegram на getMe.
 *
 * Мобильный прокси меняет IP в любой момент, в том числе сразу после успешного
 * connect. Сокет при этом остаётся «живым» с точки зрения gramJS, запрос уходит
 * в никуда и не таймаутится — 05.08.2026 это вешало запуск прогрева намертво:
 * getMe по одному аккаунту не отвечал, а остальные 15 ждали своей очереди.
 * Сторожевой таймер воркера через 15 минут убивал процесс, после рестарта всё
 * повторялось; за ночь — 14 перезапусков. Connect уже прикрыт таймаутом
 * (TG_OUTREACH_CONNECT_TIMEOUT_MS), а первый запрос после него — нет.
 *
 * Читаем env при вызове, а не при импорте: так тест может подставить своё
 * значение, не пересобирая модуль.
 */
function identityTimeoutMs(): number {
  return Number(process.env.TG_WARMUP_IDENTITY_TIMEOUT_MS) || 30_000;
}

/**
 * Спросить у Telegram, кто мы, и сохранить в БД.
 *
 * Телефон записываем только если в БД его ещё нет: в загруженных аккаунтах поле
 * часто пустое, а getMe его знает — и без телефона аккаунт нельзя найти по
 * импорту контактов, то есть он выпадет из прогрева.
 */
export async function bootstrapAccountIdentity(
  db: SupabaseClient,
  client: TelegramClient,
  account: Pick<OutreachAccount, 'id' | 'phone'>,
): Promise<AccountIdentity> {
  const me = (await withTimeout(
    client.getMe() as Promise<Api.User | undefined>,
    identityTimeoutMs(),
    'getMe',
  )) as Api.User | undefined;

  const identity: AccountIdentity = {
    tg_user_id: me?.id != null ? Number(me.id) : null,
    tg_username: me?.username ?? null,
    phone: normalizePhone(account.phone) ?? normalizePhone(me?.phone ?? null),
  };

  const patch: Record<string, unknown> = {
    tg_user_id: identity.tg_user_id,
    tg_username: identity.tg_username,
    identity_checked_at: new Date().toISOString(),
  };
  if (!normalizePhone(account.phone) && identity.phone) patch.phone = identity.phone;

  await db.from('tg_outreach_accounts').update(patch).eq('id', account.id);
  return identity;
}
