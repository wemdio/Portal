const HH_EMPLOYER_ID_PATTERN = /\/employers?\/(\d+)(?:[/?#]|$)/;

export function resolveHhEmployerId(
  employerId: string | null | undefined,
  companyUrl: string | null | undefined,
): string {
  const storedId = String(employerId ?? '').trim();
  if (storedId) return storedId;

  return String(companyUrl ?? '').match(HH_EMPLOYER_ID_PATTERN)?.[1] ?? '';
}
