export function isTransientEnrichmentError(message: string | null | undefined): boolean {
  if (!message) return false;
  const normalized = message.toLowerCase();

  return (
    normalized.includes('превышено время ожидания') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('fetch failed') ||
    normalized.includes('network') ||
    normalized.includes('connection') ||
    normalized.includes('econn') ||
    normalized.includes('aborted') ||
    normalized.includes('не удалось получить html')
  );
}

export function shouldUseCachedError(message: string | null | undefined): boolean {
  // Transient network/timeouts should be retried, not cached as hard failures.
  return !isTransientEnrichmentError(message);
}

export function shouldRetryEnrichmentItem(
  message: string | null | undefined,
  attemptCount: number,
  maxAttempts: number,
): boolean {
  if (maxAttempts <= 1) return false;
  if (!isTransientEnrichmentError(message)) return false;
  return attemptCount < maxAttempts;
}
