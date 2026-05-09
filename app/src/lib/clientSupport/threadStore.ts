/**
 * DB access helpers for the support chat. Kept narrow on purpose — every
 * route handler should be reading/writing through these functions so the SQL
 * stays reviewable in one place.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { SupportMessageRow, SupportSenderRole, SupportThreadRow } from './types';
import { buildMessagePreview } from './types';

/**
 * Fetch the support thread for `clientUserId`, creating it on demand. We pay
 * the create cost on first access only — every subsequent open just returns
 * the existing row.
 */
export async function getOrCreateThread(
  db: SupabaseClient,
  clientUserId: string,
): Promise<SupportThreadRow | null> {
  const { data: existing } = await db
    .from('client_support_threads')
    .select('*')
    .eq('client_user_id', clientUserId)
    .maybeSingle<SupportThreadRow>();

  if (existing) return existing;

  const { data: created, error } = await db
    .from('client_support_threads')
    .insert({ client_user_id: clientUserId })
    .select('*')
    .single<SupportThreadRow>();

  if (error || !created) return null;
  return created;
}

/**
 * Append a message and update the thread's cached aggregates in one call.
 * The DB has no trigger doing this for us because the cache is a UX nicety
 * (admin list view), not a correctness invariant.
 *
 * Returns the inserted message or null on error.
 */
export async function appendMessageWithCache(
  db: SupabaseClient,
  args: {
    threadId: string;
    senderUserId: string;
    senderRole: SupportSenderRole;
    body: string;
  },
): Promise<SupportMessageRow | null> {
  const { threadId, senderUserId, senderRole, body } = args;

  const { data: message, error: insertError } = await db
    .from('client_support_messages')
    .insert({
      thread_id: threadId,
      sender_user_id: senderUserId,
      sender_role: senderRole,
      body,
    })
    .select('*')
    .single<SupportMessageRow>();

  if (insertError || !message) return null;

  // Best-effort cache update. If it fails, the message is still saved and
  // visible in the thread; only the admin list "last message preview" lags.
  await db
    .from('client_support_threads')
    .update({
      last_message_at: message.created_at,
      last_message_role: senderRole,
      last_message_preview: buildMessagePreview(body),
    })
    .eq('id', threadId);

  return message;
}

/**
 * Last N messages of a thread, sorted oldest-first so the UI can append-only
 * render. We cap at 200 to bound payload size; the UI uses the cursor + the
 * realtime subscription for paging back/forward.
 */
export async function listMessages(
  db: SupabaseClient,
  threadId: string,
  limit = 200,
): Promise<SupportMessageRow[]> {
  const { data } = await db
    .from('client_support_messages')
    .select('*')
    .eq('thread_id', threadId)
    .order('created_at', { ascending: false })
    .limit(limit);

  const rows = (data ?? []) as SupportMessageRow[];
  // Reverse to chronological order (oldest first), which is what chat UIs render.
  return rows.slice().reverse();
}
