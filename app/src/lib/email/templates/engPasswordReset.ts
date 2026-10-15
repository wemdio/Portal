/**
 * Date format shared by the ENG letters. The plaintext "Your new outreachOS
 * password" letter that used to live here is gone (audit 2026-10-14): the ENG
 * «Forgot password?» now mails a one-time link instead
 * (api/auth/forgot-password/_engReset.ts) and never a password.
 */

/**
 * "Oct 12, 2026, 14:05 UTC" — the reader's time zone is unknown, so UTC is
 * named. Same format as the email-confirmation letter (engEmailVerification.ts).
 */
export function formatEngEmailUtc(d: Date): string {
  const text = d.toLocaleString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${text} UTC`;
}
