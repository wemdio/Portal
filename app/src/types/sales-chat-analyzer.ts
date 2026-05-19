/** Типы инструмента «Анализатор сейлз-переписок» (таблицы sales_chat_*). */

export type SalesChatAccountStatus = 'active' | 'auth_error' | 'disabled';
export type SalesChatBackfillStatus = 'pending' | 'running' | 'done' | 'error';
export type SalesChatPeerType = 'user' | 'chat' | 'channel';
export type SalesChatDirection = 'in' | 'out';

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
  last_error: string | null;

  created_at: string;
  updated_at: string;
}

export interface SalesChatDialogRow {
  id: string;
  account_id: string;
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
  account_id: string;
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
