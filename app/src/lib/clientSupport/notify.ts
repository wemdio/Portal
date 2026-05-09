/**
 * Notification fanout for the client ↔ manager support chat.
 *
 * We deliberately reuse public.notifications (the same table the global bell
 * icon already polls) instead of inventing a parallel surface. That means:
 *
 *   - Manager sees "Новое сообщение от <client>" alongside their other
 *     deadlines/leads, with the same UX they're used to.
 *   - Client sees "Новый ответ от менеджера" the moment they re-open the
 *     portal, without us building a second bell.
 *
 * The CHECK on public.notifications was extended in
 * 20260509_0001_create_client_support_chat.sql to accept type='support_message'
 * and entity_type='support_thread'.
 *
 * These helpers are pure (db, args) → side-effect functions kept outside the
 * route handlers so they're testable without spinning up Next.js request mocks.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { buildMessagePreview } from './types';

/** Roles considered able to handle support tickets. Mirrors lib/roles.ts isTechnician(). */
export const SUPPORT_MANAGER_ROLES = ['admin', 'technician'] as const;

export interface NotifyManagersArgs {
  /** Service-role supabase client — RLS is bypassed for the fanout writes. */
  db: SupabaseClient;
  threadId: string;
  /** Client user who sent the message. */
  clientUserId: string;
  /** Display name shown in the notification title. */
  clientDisplayName: string;
  body: string;
}

export interface NotifyClientArgs {
  db: SupabaseClient;
  threadId: string;
  clientUserId: string;
  managerDisplayName: string;
  body: string;
}

export interface NotifyResult {
  /** Count of rows actually inserted into public.notifications. */
  inserted: number;
}

/**
 * Insert one public.notifications row for every active manager (admin /
 * technician) so the bell icon lights up for them after a client posts.
 *
 * No-op (returns inserted: 0) when there are no managers in the system —
 * that's recoverable, the message itself is already saved to the thread.
 */
export async function notifyManagersOfClientMessage(
  args: NotifyManagersArgs,
): Promise<NotifyResult> {
  const { db, threadId, clientUserId, clientDisplayName, body } = args;

  const { data: managers, error } = await db
    .from('profiles')
    .select('id')
    .in('role', SUPPORT_MANAGER_ROLES);

  if (error || !managers || managers.length === 0) {
    return { inserted: 0 };
  }

  const preview = buildMessagePreview(body);
  const rows = managers
    // The client themselves can theoretically also have role=admin during dev;
    // we still skip self-notification — the client UI shows their own message
    // immediately on submit.
    .filter((m) => (m as { id: string }).id !== clientUserId)
    .map((m) => ({
      user_id: (m as { id: string }).id,
      type: 'support_message',
      title: `Новое сообщение от ${clientDisplayName}`,
      body: preview,
      entity_type: 'support_thread',
      entity_id: threadId,
    }));

  if (rows.length === 0) return { inserted: 0 };

  const { error: insertError } = await db.from('notifications').insert(rows);
  if (insertError) return { inserted: 0 };

  return { inserted: rows.length };
}

/**
 * Insert a single notification row for the client when a manager posts. The
 * client only ever has one thread, so we don't need a fanout — just one row.
 */
export async function notifyClientOfManagerMessage(
  args: NotifyClientArgs,
): Promise<NotifyResult> {
  const { db, threadId, clientUserId, managerDisplayName, body } = args;

  const preview = buildMessagePreview(body);
  const { error } = await db.from('notifications').insert({
    user_id: clientUserId,
    type: 'support_message',
    title: `Ответ от ${managerDisplayName}`,
    body: preview,
    entity_type: 'support_thread',
    entity_id: threadId,
  });

  if (error) return { inserted: 0 };
  return { inserted: 1 };
}

/**
 * Mark every unread support_message notification for `userId` that points at
 * this thread as read. Called when the user opens the thread (client) or
 * focuses an admin thread row in /support.
 */
export async function markSupportNotificationsRead(
  db: SupabaseClient,
  userId: string,
  threadId: string,
): Promise<void> {
  await db
    .from('notifications')
    .update({ is_read: true })
    .eq('user_id', userId)
    .eq('type', 'support_message')
    .eq('entity_type', 'support_thread')
    .eq('entity_id', threadId)
    .eq('is_read', false);
}
