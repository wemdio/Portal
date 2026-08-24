/**
 * Пауза аккаунта после лимита Telegram.
 *
 * Один и тот же cooldown_until читает круг кампании: пока дата в будущем,
 * аккаунт пропускается целиком. Раньше паузу ставили только на флуде ответа,
 * а PEER_FLOOD на первом касании оставлял номер в ротации.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export function isFloodLimitReason(reason: string): boolean {
  const u = reason.toUpperCase();
  return u.includes('PEER_FLOOD') || u.includes('FLOOD_WAIT') || u.includes('SLOWMODE_WAIT');
}

export function cooldownUntilIso(hours: number, now = new Date()): string {
  return new Date(now.getTime() + hours * 3600_000).toISOString();
}

export async function writeAccountCooldown(
  db: SupabaseClient,
  accountId: string,
  untilIso: string,
): Promise<string | null> {
  const { error } = await db
    .from('tg_outreach_accounts')
    .update({ cooldown_until: untilIso })
    .eq('id', accountId);
  return error?.message ?? null;
}
