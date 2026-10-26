import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { findReferredEmails, parseCcEmails } from '@/lib/replyPersonalization/referredContact';

/**
 * «Кому» в переписке «Рассылки» — как в «Персонализированных ответах»: адресат
 * пишет «по этому вопросу — к Екатерине, ekaterina@...», и ответить можно ей
 * новым письмом или ему с ней в копии.
 *
 * Новый адрес принимаем, только если он есть в последнем ответе: иначе через
 * переписку можно было бы написать с ящика кампании кому угодно. Поэтому одна
 * и та же проверка стоит и у генерации черновика, и у отправки.
 */

/** Ответы, где бывает новый контакт: автоответ «я в отпуске, пишите ...» — тоже. */
export const REFERRAL_KINDS = ['human', 'unknown', 'auto_reply'];

/** Адреса из последнего ответа адресата — без адреса лида и ящика переписки. */
export function referredFromLastReply(
  replies: Array<{ kind: string | null; body: string | null }>,
  exclude: Array<string | null | undefined>,
): string[] {
  const last = [...replies].reverse().find((r) => REFERRAL_KINDS.includes(String(r.kind)));
  return last?.body ? findReferredEmails(last.body, exclude) : [];
}

export async function loadReferredEmails(
  db: SupabaseClient,
  recipientId: string,
  exclude: Array<string | null | undefined>,
): Promise<string[]> {
  const { data } = await db
    .from('sender_replies')
    .select('kind, body')
    .eq('recipient_id', recipientId)
    .in('kind', REFERRAL_KINDS)
    .order('created_at', { ascending: false })
    .limit(1);
  return referredFromLastReply((data ?? []) as Array<{ kind: string | null; body: string | null }>, exclude);
}

export type ReplyTargets = { newContact: string | null; cc: string[] } | { error: string };

/**
 * Кому уходит ответ: новый контакт (тогда без копии) или лид в ту же переписку
 * с присланными адресами в копии. Всё, чего нет в ответе адресата, — отказ.
 */
export function resolveReplyTargets(input: {
  referred: string[];
  leadEmail: string;
  toEmail: unknown;
  ccEmails: unknown;
}): ReplyTargets {
  const lead = input.leadEmail.trim().toLowerCase();
  const target = typeof input.toEmail === 'string' ? input.toEmail.trim().toLowerCase() : '';
  const newContact = target && target !== lead ? target : null;
  if (newContact && !input.referred.includes(newContact)) {
    return { error: 'Этого адреса нет в ответе адресата — написать на него нельзя' };
  }
  const cc = newContact ? [] : parseCcEmails(input.ccEmails).filter((e) => e !== lead);
  if (cc.some((e) => !input.referred.includes(e))) {
    return { error: 'Адреса для копии нет в ответе адресата — поставить его в копию нельзя' };
  }
  return { newContact, cc };
}
