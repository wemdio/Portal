import type { Email } from '@/lib/instantly/types';

export interface FindEaccountForReplyArgs {
  originalEmail: Email;
  threadEmails: Email[];
}

/**
 * Pick the eaccount to send a reply FROM.
 *
 * Strategy:
 *  1. If the original (lead's reply) email already carries an eaccount — use it.
 *  2. Otherwise scan the same thread (matching `thread_id`) for the most recent
 *     OUTBOUND email (ue_type=1 initial send or ue_type=3 our manual reply) and
 *     reuse its eaccount.
 *  3. If nothing is found — return null (caller surfaces a clear error).
 */
export function findEaccountForReply({ originalEmail, threadEmails }: FindEaccountForReplyArgs): string | null {
  if (typeof originalEmail.eaccount === 'string' && originalEmail.eaccount.length > 0) {
    return originalEmail.eaccount;
  }
  const threadId = originalEmail.thread_id;
  if (!threadId) return null;
  const outbound = threadEmails
    .filter((e) => e.thread_id === threadId)
    .filter((e) => {
      const type = typeof e.ue_type === 'number' ? e.ue_type : 1;
      return type === 1 || type === 3;
    })
    .filter((e) => typeof e.eaccount === 'string' && (e.eaccount as string).length > 0);

  if (outbound.length === 0) return null;

  // Prefer the most recent outbound message (timestamp_email > timestamp_created).
  outbound.sort((a, b) => {
    const ta = Date.parse((a.timestamp_email ?? a.timestamp_created ?? '') as string) || 0;
    const tb = Date.parse((b.timestamp_email ?? b.timestamp_created ?? '') as string) || 0;
    return tb - ta;
  });

  return (outbound[0]!.eaccount as string) ?? null;
}
