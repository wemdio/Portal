/**
 * Normalize outbound Russian phone number to E.164 (+7XXXXXXXXXX).
 * Returns null when number is not valid for RU outbound dialing.
 */
export function normalizeRuPhoneNumber(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  let digits = value.replace(/[^\d]/g, '');
  if (!digits) return null;

  // 10-digit mobile without country code: 9XXXXXXXXX -> 79XXXXXXXXX
  if (digits.length === 10 && digits.startsWith('9')) {
    digits = '7' + digits;
  }

  // Local format: 8XXXXXXXXXX -> 7XXXXXXXXXX
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }

  if (digits.length === 11 && digits.startsWith('7')) {
    return `+${digits}`;
  }

  return null;
}
