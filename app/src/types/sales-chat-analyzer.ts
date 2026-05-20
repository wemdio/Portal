/** Типы инструмента «Анализатор сейлз-переписок» (таблицы sales_chat_*). */

export type SalesChatAccountStatus = 'active' | 'auth_error' | 'disabled';
export type SalesChatBackfillStatus = 'pending' | 'running' | 'done' | 'error';
export type SalesChatPeerType = 'user' | 'chat' | 'channel';
export type SalesChatDirection = 'in' | 'out';
export type SalesChatSyncTrigger = 'manual' | 'scheduled';
export type SalesChatSyncStatus = 'pending' | 'running' | 'done' | 'error';

export interface SalesChatAccountRow {
  id: string;
  created_by: string | null;

  label: string | null;
  phone: string;

  tg_user_id: number | null;
  tg_username: string | null;
  tg_first_name: string | null;
  tg_last_name: string | null;

  status: SalesChatAccountStatus;

  backfill_status: SalesChatBackfillStatus;
  backfill_dialogs_done: number;
  backfill_dialogs_total: number | null;

  last_connected_at: string | null;
  last_event_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;

  created_at: string;
  updated_at: string;
}

export interface SalesChatSyncRunRow {
  id: string;
  trigger: SalesChatSyncTrigger;
  sync_date: string;
  status: SalesChatSyncStatus;
  requested_by: string | null;
  accounts_total: number | null;
  accounts_done: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SalesChatDialogRow {
  id: string;
  // null, если аккаунт был удалён (переписка сохраняется в базе).
  account_id: string | null;
  tg_peer_id: number;
  peer_type: SalesChatPeerType;
  peer_title: string | null;
  peer_username: string | null;
  last_message_at: string | null;
  message_count: number;
  created_at: string;
  updated_at: string;
}

export interface SalesChatMessageRow {
  id: string;
  // null, если аккаунт был удалён (переписка сохраняется в базе).
  account_id: string | null;
  dialog_id: string;
  tg_message_id: number;
  tg_peer_id: number;
  direction: SalesChatDirection;
  sender_tg_id: number | null;
  sender_name: string | null;
  text: string | null;
  media_type: string | null;
  sent_at: string;
  created_at: string;
}

export interface SalesChatMessageAttachmentRow {
  id: string;
  message_id: string | null;
  account_id: string | null;
  dialog_id: string;
  tg_message_id: number;
  tg_peer_id: number;
  media_type: string;
  file_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  s3_bucket: string | null;
  s3_key: string | null;
  status: 'uploaded' | 'skipped' | 'error';
  error_message: string | null;
  created_at: string;
  uploaded_at: string | null;
}
