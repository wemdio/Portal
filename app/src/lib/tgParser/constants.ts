/** Дневная квота операций на аккаунт (парсинг/рассылки и т.д.) */
export const TG_PARSER_DAILY_LIMIT_DEFAULT = 500;
/** Верхняя граница настраиваемого лимита (защита от опечаток) */
export const TG_PARSER_DAILY_LIMIT_MAX = 5000;

export function clampTgParserDailyLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return TG_PARSER_DAILY_LIMIT_DEFAULT;
  return Math.min(TG_PARSER_DAILY_LIMIT_MAX, Math.max(0, Math.floor(n)));
}
