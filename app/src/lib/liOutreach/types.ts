/* ------------------------------------------------------------------ */
/*  LinkedIn Outreach — shared TypeScript types                       */
/* ------------------------------------------------------------------ */

// ---- Enums / unions ------------------------------------------------

export type LiLeadStatus =
  | 'new'
  | 'invited'
  // LinkedIn refused the invite step because the recipient was already
  // invited (by us in a prior campaign or by another tool). We did NOT
  // send an invite this run — separate from `invited` to keep the funnel
  // honest vs the LinkedIn account dashboard.
  | 'already_invited'
  | 'connected'
  | 'messaged'
  | 'replied'
  | 'completed'
  | 'error';

export type LiCampaignStatus =
  | 'draft'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'error';

export type LiCampaignLeadStatus =
  | 'pending'
  | 'in_progress'
  | 'waiting'
  | 'completed'
  | 'error'
  | 'skipped';

export type LiTaskType = 'search' | 'post_reactions' | 'csv_import';
export type LiTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type LiCampaignStepType = 'invite' | 'wait' | 'message' | 'follow_up';

// ---- Campaign step definition (stored as JSONB array) ---------------

export interface LiCampaignStep {
  type: LiCampaignStepType;
  /** Message template. Supports {{name}}, {{company}}, {вариант1|вариант2}. */
  message?: string;
  /** For 'wait' steps — number of days to pause. */
  days?: number;
  /** For 'wait' steps — number of hours to pause. */
  hours?: number;
  /** For 'wait' steps — number of minutes to pause. */
  minutes?: number;
}

// ---- Database row types ---------------------------------------------

export interface LiSettings {
  id: string;
  user_id: string;
  unipile_dsn: string;
  unipile_api_key: string;
  // NOTE: the underlying table still has `openai_api_key` / `openai_model`
  // columns from the BYOK era, but they're deliberately omitted from this
  // interface so application code can't accidentally read them. AI creds for
  // outreach now live in process.env.OPENROUTER_LI_OUTREACH_API_KEY (key)
  // and li_campaigns.ai_model (per-campaign model override). The columns will
  // be dropped in a follow-up destructive migration once we're confident no
  // service still reads them — migration 20260525_0003 wiped the *values*
  // for safety in the meantime.
  webhook_secret: string;
  proxy_url: string;
  created_at: string;
  updated_at: string;
}

export interface LiAccount {
  id: string;
  user_id: string;
  unipile_account_id: string;
  name: string | null;
  is_active: boolean;
  profile_url: string | null;
  headline: string | null;
  last_synced_at: string | null;
  created_at: string;
  /**
   * When set and >now(), every campaign + scraper that uses this LinkedIn
   * account skips its tick. Cleared automatically when the timestamp passes.
   * See `lib/liOutreach/accountCooldown.ts`.
   */
  cooldown_until: string | null;
  cooldown_reason: 'invitation_limit' | 'already_invited' | 'account_restricted' | null;
  proxy_url: string | null;
}

export interface LiLeadList {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Список был импортирован через «Импорт CSV с инвайтами» — у его лидов
   * заполнена колонка `invite_text` с персонализированным текстом инвайта.
   * Кампания может использовать его вместо общего шаблона (тумблер
   * `use_custom_invites`). UI редактора кампании показывает тумблер только
   * для списков с этим флагом.
   */
  has_custom_invites: boolean;
  /** Virtual — filled by API. */
  leads_count?: number;
}

export interface LiLead {
  id: string;
  user_id: string;
  lead_list_id: string | null;
  linkedin_id: string | null;
  public_identifier: string | null;
  profile_url: string | null;
  name: string;
  first_name: string | null;
  last_name: string | null;
  position: string | null;
  company: string | null;
  chat_id: string | null;
  status: LiLeadStatus;
  account_id: string | null;
  conversation_history: Array<{ role: string; content: string; ts?: string }>;
  /**
   * Персонализированный текст инвайта, заданный для этого конкретного лида
   * при импорте «CSV с инвайтами». Используется runner'ом, когда у
   * привязанной кампании включён `use_custom_invites`. NULL — нет своего
   * текста, используем шаблон `step.message`.
   */
  invite_text: string | null;
  extra_data: Record<string, unknown>;
  last_activity: string | null;
  created_at: string;
  updated_at: string;
}

export interface LiCampaign {
  id: string;
  user_id: string;
  name: string;
  account_id: string | null;
  lead_list_id: string | null;
  steps: LiCampaignStep[];
  use_ai: boolean;
  ai_prompt_invite: string | null;
  ai_prompt_chat: string | null;
  stop_on_reply: boolean;
  min_delay: number;
  max_delay: number;
  daily_invite_limit: number;
  invites_sent_today: number;
  last_invite_date: string | null;
  welcome_message: string | null;
  message_existing_connections: boolean;
  use_ai_welcome: boolean;
  use_ai_followup: boolean;
  ai_model: string | null;
  /**
   * Если true — runner на шаге `invite` берёт `lead.invite_text` вместо
   * шаблона `step.message`. AI-персонализация для инвайта при этом
   * пропускается: персонализация уже сделана на стороне CSV. Если у лида
   * нет своего invite_text — fallback на шаблон с обычным флоу. Тумблер в
   * UI показывается только для списков с `has_custom_invites=true`.
   */
  use_custom_invites: boolean;
  status: LiCampaignStatus;
  created_at: string;
  updated_at: string;
}

export interface LiCampaignLead {
  id: string;
  campaign_id: string;
  lead_id: string;
  current_step: number;
  status: LiCampaignLeadStatus;
  next_action_at: string | null;
  user_replied: boolean;
  invite_accepted: boolean;
  /**
   * Set by the connection_accepted webhook when it successfully delivers
   * campaign.welcome_message to this lead. The runner uses this to skip the
   * first message/follow_up step so the lead isn't messaged twice.
   */
  welcome_sent_at: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  /** Joined from li_leads when needed. */
  lead?: LiLead;
}

export interface LiCampaignStepStat {
  id: string;
  campaign_id: string;
  step_index: number;
  step_type: string;
  reached: number;
  completed: number;
  failed: number;
  created_at: string;
  updated_at: string;
}

export interface LiCampaignLog {
  id: number;
  campaign_id: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  lead_name: string | null;
  step_index: number | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface LiTask {
  id: string;
  user_id: string;
  type: LiTaskType;
  status: LiTaskStatus;
  params: Record<string, unknown>;
  result: Record<string, unknown> | null;
  progress: number;
  total: number;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface LiWebhookLog {
  id: number;
  user_id: string | null;
  event_type: string | null;
  payload: Record<string, unknown>;
  processed: boolean;
  error_message: string | null;
  created_at: string;
}

// ---- Unipile API response types ------------------------------------

export interface UnipileAccount {
  id: string;
  type: string;
  name: string;
  status: string;
  created_at: string;
}

export interface UnipileSearchResult {
  provider_id: string;
  public_identifier: string;
  name: string;
  first_name: string | null;
  last_name: string | null;
  headline: string | null;
  profile_url: string | null;
  company: string | null;
}

export interface UnipileChat {
  id: string;
  provider_id: string;
  attendees: Array<{ provider_id: string; name: string }>;
}

export interface UnipileMessage {
  id: string;
  text: string;
  sender_id: string;
  timestamp: string;
  is_sender: boolean;
}
