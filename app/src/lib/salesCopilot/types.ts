export type DraftType = 'reactive' | 'proactive';
export type DraftStatus = 'pending' | 'sent' | 'edited_and_sent' | 'dismissed' | 'expired';
export type CopilotJobAction = 'start' | 'stop';
export type CopilotJobStatus = 'pending' | 'running' | 'completed' | 'failed';
export type CopilotLogLevel = 'info' | 'warning' | 'error';

export interface SalesCopilotConfig {
  id: string;
  user_id: string;
  account_id?: string | null;

  session_data?: Record<string, unknown> | null;
  phone: string;
  tg_first_name: string;
  tg_username: string;

  is_enabled: boolean;
  llm_model: string;

  reactive_enabled: boolean;
  reactive_system_prompt: string;
  reactive_set_tg_draft: boolean;
  reactive_history_limit: number;

  proactive_enabled: boolean;
  proactive_system_prompt: string;
  proactive_silence_days: number;
  proactive_max_drafts_per_scan: number;

  scan_interval_seconds: number;
  sleep_periods: string[];
  timezone_offset: number;

  ignore_bots: boolean;
  ignore_no_username: boolean;
  excluded_chat_ids: number[];

  initial_sync_completed: boolean;
  initial_sync_offset: number;
  last_full_sync_at: string | null;

  created_at: string;
  updated_at: string;
}

export interface CopilotDraftMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

export interface SalesCopilotDraft {
  id: string;
  config_id: string;
  account_id?: string | null;

  tg_user_id: number;
  tg_username: string | null;
  tg_display_name: string | null;

  draft_text: string;
  draft_type: DraftType;
  status: DraftStatus;

  chat_history: CopilotDraftMessage[];
  last_incoming_text: string | null;
  silence_days: number | null;

  llm_model: string | null;
  llm_tokens_used: number | null;
  tg_draft_set: boolean;

  edited_text: string | null;
  acted_at: string | null;

  created_at: string;
  expires_at: string | null;
}

export interface SalesCopilotJob {
  id: string;
  config_id: string;
  user_id: string;
  action: CopilotJobAction;
  status: CopilotJobStatus;
  error_message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface SalesCopilotLog {
  id: number;
  config_id: string;
  level: CopilotLogLevel;
  message: string;
  created_at: string;
}

export interface DraftStats {
  pending_reactive: number;
  pending_proactive: number;
  sent_today: number;
  dismissed_today: number;
}

export interface CopilotDialog {
  id: string;
  config_id: string;
  tg_user_id: number;
  tg_username: string | null;
  tg_display_name: string;
  is_bot: boolean;
  last_message_date: string | null;
  last_synced_msg_id: number | null;
  message_count: number;
  kb_document_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CopilotMessage {
  id: string;
  dialog_id: string;
  tg_message_id: number;
  role: 'user' | 'assistant';
  content: string;
  message_date: string;
}

export const DEFAULT_REACTIVE_PROMPT = `Ты — помощник менеджера по продажам. Тебе дана переписка менеджера с клиентом в Telegram.

Задача: написать черновик следующего ответа от имени менеджера.

Правила:
- Пиши естественно, как в мессенджере (без канцеляризмов)
- Коротко — 1-3 предложения
- Учитывай контекст всей переписки
- Если клиент задал вопрос — ответь на него
- Если клиент проявил интерес — двигай к следующему шагу (звонок/встреча)
- Если клиент негативит — вежливо попрощайся
- НЕ используй эмодзи если их нет в стиле менеджера`;

export const DEFAULT_PROACTIVE_PROMPT = `Ты — помощник менеджера по продажам. Тебе дана переписка менеджера с клиентом в Telegram. Диалог замолк {silence_days} дней назад.

Задача: написать сообщение для возобновления диалога.

Правила:
- Пиши естественно, как в мессенджере
- Коротко — 1-3 предложения
- Не начинай с "Привет, давно не общались" — это банально
- Привяжись к контексту прошлого разговора
- Дай повод ответить (вопрос, новость, предложение)
- Не будь навязчивым`;
