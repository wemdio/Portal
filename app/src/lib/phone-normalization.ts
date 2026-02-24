/**
 * Normalize outbound Russian phone number to E.164 (+7XXXXXXXXXX).
 * Returns null when number is not valid for RU outbound dialing.
 */
export function normalizeRuPhoneNumber(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  let digits = value.replace(/[^\d]/g, '');
  if (!digits) return null;

  // Local mobile format: 8XXXXXXXXXX -> 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }

  if (digits.length === 11 && digits.startsWith('7')) {
    return `+${digits}`;
  }

  return null;
}
