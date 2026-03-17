export const OPENROUTER_MODEL = 'policy/gemini-flash';
export const OPENROUTER_API_KEY = process.env.OPENROUTER_SEARCH_PARSER_API_KEY || '';
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
export const TG_TRANSCRIBE_BOT_TOKEN = process.env.TG_TRANSCRIBE_BOT_TOKEN;
export const TG_AGENT_BOT_TOKEN = process.env.TG_AGENT_BOT_TOKEN;
export const TG_LOCAL_API_URL = process.env.TG_LOCAL_API_URL || '';
export const TELEGRAM_INITDATA_MAX_AGE_SECONDS = 300;

export const REDACT_KEYS = [
  /password/i,
  /token/i,
  /authorization/i,
  /cookie/i,
  /secret/i,
  /api[_-]?key/i,
  /supabase/i,
];

export const MAX_STRING_LENGTH = 500;
export const MAX_ARRAY_LENGTH = 50;
export const MAX_DEPTH = 4;
export const MAX_STACK_LENGTH = 2000;
