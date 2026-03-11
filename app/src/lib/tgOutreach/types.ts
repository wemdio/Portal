export interface TgOutreachTag {
  id: string;
  name: string;
  color: string;
  created_by: string | null;
  created_at: string;
}

export type ProxyType = 'HTTP' | 'SOCKS4' | 'SOCKS5';

export interface TgOutreachProxy {
  id: string;
  ip: string;
  port: number;
  login: string;
  password: string;
  type: ProxyType;
  notes: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  tags?: TgOutreachTag[];
}

export type AccountFormat = 'tdata' | 'session_json';
export type AccountStatus = 'active' | 'banned' | 'frozen' | 'limited';

export interface TgOutreachAccount {
  id: string;
  format: AccountFormat;
  session_data: Record<string, unknown>;
  phone: string;
  first_name: string;
  last_name: string;
  username: string;
  bio: string;
  avatar_url: string;
  proxy_id: string | null;
  status: AccountStatus;
  account_price: number;
  notes: string;

  max_invites_per_day: number;
  max_messages_per_day: number;
  max_chat_messages_per_day: number;
  max_contact_adds_per_day: number;
  max_story_views_per_day: number;
  max_neurocomment_posts_per_day: number;
  control_tg_request_limit: boolean;

  created_by: string | null;
  created_at: string;
  updated_at: string;

  tags?: TgOutreachTag[];
  proxy?: TgOutreachProxy | null;
}

export type AccountAction =
  | 'check_status'
  | 'check_spambot'
  | 'sync_profile'
  | 'request_unfreeze'
  | 'remove_spamblock'
  | 'unblock';
