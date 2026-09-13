/** Accepted validation results for internal outreach; keep the original status. */
export function isVeAcceptedEmailStatus(value: unknown): value is 'ok' | 'catch_all' {
  return value === 'ok' || value === 'catch_all';
}
