/**
 * Public-safe shape of an email reply (ue_type=2 in Instantly).
 * Stripped of internal fields (eaccount, i_status, raw HTML, etc.) so we can
 * safely return it to clients via /api/client/campaigns/[id]/replies.
 */
export interface ClientReply {
  /** Instantly email UUID */
  id: string;
  /** ISO timestamp of the reply (timestamp_email | timestamp_created) */
  timestamp: string | null;
  subject: string | null;
  /** Lead email (sender) */
  from_email: string | null;
  /** Lead display name extracted from from_address_json[0].name */
  from_name: string | null;
  /** Instantly lead UUID — useful for grouping replies by lead */
  lead_id: string | null;
  /** Instantly thread UUID */
  thread_id: string | null;
  is_unread: boolean;
  /** Instantly's own AI interest scoring (1=cold..5=hot, when present) */
  ai_interest_value: number | null;
  /** Short preview from Instantly */
  content_preview: string | null;
  /** Plaintext body (html → text if needed) */
  body_text: string | null;
}

export interface ClientRepliesPage {
  items: ClientReply[];
  next_starting_after: string | null;
}

/**
 * Direction-aware shape used by the thread view (single conversation).
 * - 'outbound' = sent by us / the campaign (ue_type=1 initial, ue_type=3 manual reply)
 * - 'inbound'  = received from the lead (ue_type=2)
 */
export type ThreadDirection = 'inbound' | 'outbound';

export interface ThreadMessage {
  id: string;
  direction: ThreadDirection;
  timestamp: string | null;
  subject: string | null;
  from_email: string | null;
  from_name: string | null;
  body_text: string | null;
}

export interface ClientReplyThread {
  thread_id: string | null;
  messages: ThreadMessage[];
}

