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
import { normalizePhone } from './peer';

export interface AccountIdentity {
  tg_user_id: number | null;
  tg_username: string | null;
  phone: string | null;
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
  const me = (await client.getMe()) as Api.User | undefined;

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
