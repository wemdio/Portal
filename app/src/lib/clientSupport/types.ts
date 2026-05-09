/**
 * Shared TypeScript shapes for the client ↔ manager support chat.
 *
 * The DB schema lives in supabase/migrations/20260509_0001_create_client_support_chat.sql.
 * Keep these mirrored when columns are added/removed there.
 */

export type SupportSenderRole = 'client' | 'manager';
export type SupportThreadStatus = 'open' | 'closed';

export interface SupportThreadRow {
  id: string;
  client_user_id: string;
  last_message_at: string | null;
  last_message_role: SupportSenderRole | null;
  last_message_preview: string | null;
  status: SupportThreadStatus;
  created_at: string;
  updated_at: string;
}

export interface SupportMessageRow {
  id: string;
  thread_id: string;
  sender_user_id: string;
  sender_role: SupportSenderRole;
  body: string;
  created_at: string;
}

/** Trim/truncate a body for the cached `last_message_preview` cell. */
export function buildMessagePreview(body: string, maxLen = 140): string {
  const trimmed = body.replace(/\s+/g, ' ').trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `${trimmed.slice(0, maxLen - 1)}…`;
}

/** Length cap mirrors the DB CHECK on client_support_messages.body. */
export const SUPPORT_MESSAGE_MAX_LEN = 5000;

export interface ValidatedMessageInput {
  ok: true;
  body: string;
}

export interface InvalidMessageInput {
  ok: false;
  error: string;
}

/**
 * Validate a candidate message body against the same rules the DB enforces.
 * Centralised so client-side, server-side, and tests use one source of truth.
 */
export function validateMessageBody(raw: unknown): ValidatedMessageInput | InvalidMessageInput {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Сообщение должно быть строкой' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: 'Сообщение не может быть пустым' };
  }
  if (trimmed.length > SUPPORT_MESSAGE_MAX_LEN) {
    return { ok: false, error: `Сообщение длиннее ${SUPPORT_MESSAGE_MAX_LEN} символов` };
  }
  return { ok: true, body: trimmed };
}
