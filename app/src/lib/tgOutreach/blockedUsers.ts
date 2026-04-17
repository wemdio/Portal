import type { SupabaseClient } from '@supabase/supabase-js';
import type { OutreachBlockedUser } from './types';

const TABLE = 'tg_outreach_blocked_users';
const DIALOGS_TABLE = 'tg_outreach_dialogs';

/**
 * Returns the set of `tg_user_id`s that are globally blocked for the given portal user.
 * Used by the campaign worker to early-skip incoming chats from blocked Telegram users.
 *
 * The caller decides how often to refresh; the worker re-loads once per outer loop tick.
 */
export async function loadBlockedUserIds(
  db: SupabaseClient,
  userId: string,
): Promise<Set<number>> {
  const { data, error } = await db
    .from(TABLE)
    .select('tg_user_id')
    .eq('user_id', userId);
  if (error) {
    throw new Error(`Failed to load blocked users: ${error.message}`);
  }
  const rows = (data ?? []) as { tg_user_id: number | string | bigint }[];
  return new Set(rows.map(r => Number(r.tg_user_id)));
}

export async function listBlockedUsers(
  db: SupabaseClient,
  userId: string,
): Promise<OutreachBlockedUser[]> {
  const { data, error } = await db
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) {
    throw new Error(`Failed to list blocked users: ${error.message}`);
  }
  const rows = (data ?? []) as { tg_user_id: number | string | bigint; user_id: string; tg_username: string | null; reason: string | null; created_at: string }[];
  return rows.map(r => ({
    user_id: r.user_id,
    tg_user_id: Number(r.tg_user_id),
    tg_username: r.tg_username,
    reason: r.reason,
    created_at: r.created_at,
  }));
}

/**
 * Adds a Telegram user to the portal user's global blocklist AND disables `can_send` on
 * every existing dialog row for that `tg_user_id` across all of the user's campaigns.
 *
 * The bulk update relies on RLS to scope dialog rows to campaigns owned by the caller,
 * so this MUST be called with an authenticated supabase client (the user's JWT),
 * NOT the service-role admin client.
 */
export async function addBlockedUser(
  db: SupabaseClient,
  userId: string,
  tgUserId: number,
  tgUsername: string | null,
  reason?: string | null,
): Promise<void> {
  const { error: upsertErr } = await db
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        tg_user_id: tgUserId,
        tg_username: tgUsername ?? null,
        reason: reason ?? null,
      },
      { onConflict: 'user_id,tg_user_id' },
    );
  if (upsertErr) {
    throw new Error(`Failed to add blocked user: ${upsertErr.message}`);
  }

  const { error: updateErr } = await db
    .from(DIALOGS_TABLE)
    .update({ can_send: false })
    .eq('tg_user_id', tgUserId);
  if (updateErr) {
    throw new Error(`Failed to disable dialogs for blocked user: ${updateErr.message}`);
  }
}

export async function removeBlockedUser(
  db: SupabaseClient,
  userId: string,
  tgUserId: number,
): Promise<void> {
  const { error } = await db
    .from(TABLE)
    .delete()
    .eq('user_id', userId)
    .eq('tg_user_id', tgUserId);
  if (error) {
    throw new Error(`Failed to remove blocked user: ${error.message}`);
  }
}
