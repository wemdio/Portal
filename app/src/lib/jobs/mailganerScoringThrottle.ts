const MAILGANER_CONCURRENCY_ENV = 'MAILGANER_SCORING_CONCURRENCY';

type EnvLike = Record<string, string | undefined>;

export function isMailganerEndpointUrl(endpointUrl: string | null | undefined): boolean {
  if (!endpointUrl) return false;
  try {
    const host = new URL(endpointUrl).hostname.toLowerCase();
    return host === 'mailganer.com' || host.endsWith('.mailganer.com');
  } catch {
    return false;
  }
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed);
}

export function resolveMailganerScoringConcurrency({
  endpointUrl,
  defaultConcurrency,
  env = process.env,
}: {
  endpointUrl: string | null | undefined;
  defaultConcurrency: number;
  env?: EnvLike;
}): number {
  const normalizedDefault = Math.max(1, Math.floor(defaultConcurrency));
  if (!isMailganerEndpointUrl(endpointUrl)) return normalizedDefault;

  const configured = positiveInteger(env[MAILGANER_CONCURRENCY_ENV]);
  if (configured !== null) return configured;

  return Math.max(1, Math.floor(normalizedDefault / 2));
}

/**
 * Concurrency для Mailganer-скоринга, где `defaultConcurrency` — УЖЕ осознанно
 * выставленное значение (background_scorer_state.concurrency у bob-scorer'а,
 * который скорит большой файл и наполняет BoB-кэш). В отличие от
 * resolveMailganerScoringConcurrency, НЕ уполовинивает default — только
 * применяет env-оверрайд MAILGANER_SCORING_CONCURRENCY, если он задан.
 *
 * Так MAILGANER_SCORING_CONCURRENCY становится единым рычагом для ВСЕХ путей к
 * Mailganer: добор/ручной скоринг — через resolveMailganerScoringConcurrency,
 * большой файл/BoB-филлер — через эту функцию.
 */
export function applyMailganerConcurrencyOverride({
  endpointUrl,
  defaultConcurrency,
  env = process.env,
}: {
  endpointUrl: string | null | undefined;
  defaultConcurrency: number;
  env?: EnvLike;
}): number {
  const normalizedDefault = Math.max(1, Math.floor(defaultConcurrency));
  if (!isMailganerEndpointUrl(endpointUrl)) return normalizedDefault;
  const configured = positiveInteger(env[MAILGANER_CONCURRENCY_ENV]);
  return configured ?? normalizedDefault;
}
