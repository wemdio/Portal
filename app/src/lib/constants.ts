/**
 * Модель генерации поисковых запросов («Поиск Google/Yandex» в парсерах).
 *
 * Пинится в обход политики `policy/gemini-flash`: этот алиас в Requesty стал
 * роутиться на `deepseek-v4-flash` — reasoning-модель, которая тратит весь
 * лимит вывода на скрытые рассуждения и возвращает пустой `content`. На экране
 * это выглядело как «Failed to generate queries». Параметр `reasoning_effort`
 * роутер игнорирует, увеличение лимита не помогает: 2000 токенов уходили в
 * reasoning целиком. Тот же обход уже сделан в `salesHypotheses/model.ts`.
 *
 * Переопределяется env `SEARCH_PARSER_MODEL`.
 */
export const OPENROUTER_MODEL = process.env.SEARCH_PARSER_MODEL || 'anthropic/claude-haiku-4-5';
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
