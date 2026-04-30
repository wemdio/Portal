/**
 * Validation helpers for client-driven reply / forward actions on campaign emails.
 * All validators return a normalised, AI/user-facing-safe payload that can be
 * forwarded directly to Instantly API helpers.
 */

const MAX_BODY_CHARS = 100_000;

// Permissive email regex: allows unicode local-parts (e.g. кир@почта.рф) and TLDs.
// Must contain a local part, '@', a domain segment, '.', and a TLD ≥ 1 char.
const EMAIL_REGEX = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/u;

export function isValidEmail(input: string): boolean {
  if (typeof input !== 'string') return false;
  const trimmed = input.trim();
  if (trimmed.length === 0) return false;
  if (trimmed !== input) return false; // surrounding whitespace is not allowed (caller should pre-trim)
  return EMAIL_REGEX.test(trimmed);
}

export interface ParsedEmailList {
  valid: string[];
  invalid: string[];
}

/**
 * Parse a free-form list (comma- or semicolon-separated) of emails.
 * Lower-cased and de-duplicated. Empty segments are dropped silently.
 */
export function parseEmailList(raw: string): ParsedEmailList {
  if (!raw || typeof raw !== 'string') return { valid: [], invalid: [] };
  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const part of raw.split(/[,;]/)) {
    const candidate = part.trim();
    if (candidate.length === 0) continue;
    const normalised = candidate.toLowerCase();
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    if (EMAIL_REGEX.test(normalised)) {
      valid.push(normalised);
    } else {
      invalid.push(candidate);
    }
  }
  return { valid, invalid };
}

export interface ValidateReplyInputArgs {
  body_text: unknown;
  cc?: unknown;
  bcc?: unknown;
}

export interface ReplyValidationResult {
  ok: boolean;
  error?: string;
  body_text?: string;
  cc?: string;
  bcc?: string;
}

export function validateReplyInput(input: ValidateReplyInputArgs): ReplyValidationResult {
  const bodyRaw = typeof input.body_text === 'string' ? input.body_text : '';
  const body = bodyRaw.trim();
  if (body.length === 0) {
    return { ok: false, error: 'Тело ответа обязательно' };
  }
  if (body.length > MAX_BODY_CHARS) {
    return { ok: false, error: `Тело ответа слишком длинное (макс. ${MAX_BODY_CHARS} символов)` };
  }

  let ccString: string | undefined;
  if (typeof input.cc === 'string' && input.cc.trim().length > 0) {
    const parsed = parseEmailList(input.cc);
    if (parsed.invalid.length > 0) {
      return { ok: false, error: `Некорректные адреса в копии: ${parsed.invalid.join(', ')}` };
    }
    if (parsed.valid.length > 0) ccString = parsed.valid.join(',');
  }

  let bccString: string | undefined;
  if (typeof input.bcc === 'string' && input.bcc.trim().length > 0) {
    const parsed = parseEmailList(input.bcc);
    if (parsed.invalid.length > 0) {
      return { ok: false, error: `Некорректные адреса в скрытой копии: ${parsed.invalid.join(', ')}` };
    }
    if (parsed.valid.length > 0) bccString = parsed.valid.join(',');
  }

  return { ok: true, body_text: body, cc: ccString, bcc: bccString };
}

export interface ValidateForwardInputArgs {
  to_email: unknown;
}

export interface ForwardValidationResult {
  ok: boolean;
  error?: string;
  to_email?: string;
}

export function validateForwardInput(input: ValidateForwardInputArgs): ForwardValidationResult {
  const raw = typeof input.to_email === 'string' ? input.to_email.trim() : '';
  if (raw.length === 0) {
    return { ok: false, error: 'Укажите адрес получателя' };
  }
  // Reject lists — forward is strictly 1-to-1 per Instantly API.
  if (/[,;]/.test(raw)) {
    return { ok: false, error: 'Пересылка только на одного получателя' };
  }
  const normalised = raw.toLowerCase();
  if (!EMAIL_REGEX.test(normalised)) {
    return { ok: false, error: 'Некорректный email получателя' };
  }
  return { ok: true, to_email: normalised };
}
