/**
 * Шаги конструктора в ENG-сборе — рядом со списком шагов, которые конструктор
 * выполняет под бюджетом ENG-базы (step_config.he_eng_base_budget). Держим их в
 * одном месте намеренно: шаг цепочки, которого нет в бюджетном списке, валит
 * каждую джобу сбора на старте («unbudgeted_constructor_step»). 23.10.2026 так
 * случилось с remove_support_emails: каждый круг сбора терял уже проверенные
 * компании, а два таких круга подряд остановили сбор как «low_yield».
 */

/** ENG-хвост после необязательных find_emails и enrich_descriptions (constructStepsFor). */
export const ENG_CONSTRUCT_STEPS_AFTER_SPLIT = [
  'split_emails',
  'dedup_email',
  'remove_support_emails',
  'validate_emails',
  'cap_emails_per_company',
] as const;

/**
 * Что серверная ENG-джоба может делать вне бюджета своей базы: без платных
 * вызовов моделей. remove_support_emails только фильтрует адреса в памяти.
 */
export const ENG_BASE_BUDGET_FREE_STEPS: ReadonlySet<string> = new Set([
  'find_emails', 'enrich_descriptions', 'split_emails', 'dedup_email', 'remove_support_emails',
  'dedup_full', 'remove_empty', 'validate_emails', 'cap_emails_per_company',
]);
