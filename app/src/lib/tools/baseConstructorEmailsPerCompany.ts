/**
 * Настройка «Почт на компанию» ручного конструктора баз.
 *
 * Шаг cap_emails_per_company (stepCapEmailsPerCompany) оставляет не больше N
 * email-строк на компанию. Но сам он адреса не ищет: find_emails по умолчанию
 * останавливает обход сайта на первой странице с пригодным адресом
 * (stop_at_first=true), и почти всегда это одна общая почта с главной.
 * Поэтому при N > 1 ручной конструктор выключает раннюю остановку — иначе
 * ограничивать нечего.
 *
 * Только ручной конструктор (BaseConstructorView → POST /api/tools/base-constructor).
 * Автоматические пайплайны (VE2, Hypothesis Engine/ENG, 2GIS signals,
 * OutreachOS) создают base_constructor_jobs напрямую со своим step_config
 * и этот модуль не используют.
 *
 * Отдельный лёгкий файл (без processingSteps.ts), чтобы клиентский бандл
 * и тесты не тянули скраперы.
 */

export const EMAILS_PER_COMPANY_DEFAULT = 5;
export const EMAILS_PER_COMPANY_MIN = 1;
export const EMAILS_PER_COMPANY_MAX = 20;

/** Дефолт find_emails для адресов с одного сайта (processingSteps: maxEmailsPerSite ?? 8). */
const FIND_EMAILS_DEFAULT_MAX_PER_SITE = 8;

/**
 * Целое в диапазоне [MIN, MAX]. Мусор (NaN, строки, пусто) → дефолт:
 * stepCapEmailsPerCompany с NaN в max отрезал бы все строки.
 */
export function normalizeEmailsPerCompany(value: unknown): number {
  const n = typeof value === 'number' ? value
    : typeof value === 'string' && value.trim() !== '' ? Number(value.trim())
    : NaN;
  if (!Number.isFinite(n)) return EMAILS_PER_COMPANY_DEFAULT;
  return Math.min(EMAILS_PER_COMPANY_MAX, Math.max(EMAILS_PER_COMPANY_MIN, Math.floor(n)));
}

/**
 * step_config для настройки «Почт на компанию». Пусто, если шаг не выбран —
 * тогда поведение конструктора прежнее (worker-дефолты find_emails).
 *   - cap_emails_per_company.max = N;
 *   - при N > 1 и выбранном find_emails: stop_at_first=false (обход всего
 *     сайта, до 5 страниц) и max_per_site ≥ N, чтобы cap выбирал лучшие N
 *     из всех найденных после валидации.
 */
export function buildEmailsPerCompanyStepConfig(
  selectedSteps: readonly string[],
  emailsPerCompany: unknown,
): Record<string, unknown> {
  if (!selectedSteps.includes('cap_emails_per_company')) return {};
  const max = normalizeEmailsPerCompany(emailsPerCompany);
  const config: Record<string, unknown> = { cap_emails_per_company: { max } };
  if (max > 1 && selectedSteps.includes('find_emails')) {
    config.find_emails = {
      stop_at_first: false,
      max_per_site: Math.max(FIND_EMAILS_DEFAULT_MAX_PER_SITE, max),
    };
  }
  return config;
}

/**
 * Серверная нормализация для POST ручного конструктора: step_config пишется
 * в БД как есть, а N теперь приходит из UI. Если шаг выбран — max приводится
 * к допустимому целому (без max → дефолт). Остальные ключи не трогаем.
 */
export function sanitizeEmailsPerCompanyStepConfig(
  stepConfig: Record<string, unknown>,
  selectedSteps: readonly string[],
): Record<string, unknown> {
  if (!selectedSteps.includes('cap_emails_per_company')) return stepConfig;
  const base = stepConfig && typeof stepConfig === 'object' && !Array.isArray(stepConfig) ? stepConfig : {};
  const raw = base.cap_emails_per_company;
  const rawMax = raw && typeof raw === 'object' ? (raw as { max?: unknown }).max : undefined;
  return { ...base, cap_emails_per_company: { max: normalizeEmailsPerCompany(rawMax) } };
}
