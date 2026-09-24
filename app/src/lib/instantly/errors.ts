export class InstantlyApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = 'InstantlyApiError';
  }
}

/** An explicit contact-storage refusal, never a 429, network failure or generic billing error. */
export function isInstantlyContactCapacityError(error: unknown): boolean {
  if (!(error instanceof InstantlyApiError) || ![400, 402, 403, 409, 422].includes(error.status)) return false;
  const detail = typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? {});
  const message = `${error.message} ${detail}`;
  return /\b(?:lead|contact)s?\b/i.test(message)
    && /(?:limit|capacity).{0,60}(?:reached|exceeded|exhausted|full)|(?:reached|exceeded).{0,60}(?:limit|maximum)|not enough.{0,30}(?:space|capacity)/i.test(message);
}
