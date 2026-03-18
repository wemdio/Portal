import 'server-only';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: string | null | undefined): string | null {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return null;
  return email;
}

function isInfoMailbox(email: string): boolean {
  const localPart = email.split('@')[0] ?? '';
  return /^info(?:[._+-].*)?$/i.test(localPart);
}

/**
 * Contact-level filter: suppress generic info@ mailboxes, keep direct/person emails.
 */
export function sanitizeContactEmail(raw: string | null | undefined): string | null {
  const email = normalizeEmail(raw);
  if (!email) return null;
  if (isInfoMailbox(email)) return null;
  return email;
}

