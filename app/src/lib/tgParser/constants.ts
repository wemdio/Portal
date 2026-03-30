/** Значение по умолчанию для «макс. контактов за запуск» при создании аккаунта */
export const TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT = 500;
/** Верхняя граница настраиваемого лимита (защита от опечаток) */
export const TG_PARSER_MAX_CONTACTS_PER_RUN_MAX = 100_000;

export function clampTgParserMaxContactsPerRun(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return TG_PARSER_MAX_CONTACTS_PER_RUN_DEFAULT;
  return Math.min(TG_PARSER_MAX_CONTACTS_PER_RUN_MAX, Math.max(1, Math.floor(n)));
}
