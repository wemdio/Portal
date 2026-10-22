import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DialogMessage, ReplyFailure } from './types';

export function replyIncomingKey(history: DialogMessage[]): string {
  const incoming = [...history].reverse().find((m) => m.role === 'user');
  return createHash('sha256').update(JSON.stringify(incoming ?? null)).digest('hex');
}

/** Текст настоящей ошибки без API-ключа и авторизационных заголовков. */
export function replyFailureReason(error: unknown): string {
  let reason = error instanceof Error ? error.message : String(error);
  const key = process.env.OPENROUTER_TG_OUTREACH_API_KEY;
  if (key) reason = reason.split(key).join('<redacted>');
  return reason.replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').slice(0, 1000);
}

export async function getReplyFailure(
  db: SupabaseClient, campaignId: string, accountId: string, tgUserId: number,
): Promise<ReplyFailure | null> {
  const { data, error } = await db.from('tg_outreach_dialogs').select('reply_failure')
    .eq('campaign_id', campaignId).eq('account_id', accountId).eq('tg_user_id', tgUserId).maybeSingle();
  if (error) throw new Error(`Не удалось прочитать ошибку ответа: ${error.message}`);
  return (data?.reply_failure as ReplyFailure | null | undefined) ?? null;
}

export async function saveReplyFailure(
  db: SupabaseClient, campaignId: string, accountId: string, tgUserId: number,
  failure: ReplyFailure | null,
): Promise<void> {
  // Только отдельная колонка: обновление истории/экспорт не делают черновик
  // отправленным сообщением и не стирают диагностику.
  const { error } = await db.from('tg_outreach_dialogs').update({ reply_failure: failure })
    .eq('campaign_id', campaignId).eq('account_id', accountId).eq('tg_user_id', tgUserId);
  if (error) throw new Error(`Не удалось сохранить ошибку ответа: ${error.message}`);
}
