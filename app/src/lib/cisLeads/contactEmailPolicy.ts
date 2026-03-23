import 'server-only';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(raw: string | null | undefined): string | null {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!email || !EMAIL_RE.test(email)) return null;
  return email;
}

/**
 * Contact-level filter: normalizes and validates email format.
 * All structurally valid emails are accepted (including generic mailboxes like info@, sales@).
 */
export function sanitizeContactEmail(raw: string | null | undefined): string | null {
  return normalizeEmail(raw);
}

