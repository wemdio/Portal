/**
 * TASK 2.1 — Извлечение домена из email и валидация.
 * Input: email (например info@company.ru).
 * Output: домен (company.ru), валидация домена.
 */

const EMAIL_RE = /^[a-zA-Z0-9._%+-]+@([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})$/;
const DOMAIN_LABEL_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/;
const TLD_MIN_LEN = 2;
const TLD_MAX_LEN = 10;
const MAX_DOMAIN_LEN = 253;

/**
 * Извлекает домен из email.
 * Пример: info@company.ru → company.ru
 */
export function extractDomainFromEmail(email: string | null | undefined): string | null {
  const s = String(email ?? '').trim().toLowerCase();
  if (!s || !s.includes('@')) return null;
  const match = s.match(EMAIL_RE);
  return match ? match[1]! : null;
}

/**
 * Проверяет, что строка выглядит как валидный домен (не полный URL).
 * Допускает домен с поддоменами: sub.company.ru
 */
export function isValidDomain(domain: string | null | undefined): boolean {
  const d = String(domain ?? '').trim().toLowerCase();
  if (!d || d.length > MAX_DOMAIN_LEN) return false;
  if (d.includes(' ') || d.startsWith('.') || d.endsWith('.') || d.includes('..')) return false;

  const parts = d.split('.');
  if (parts.length < 2) return false;

  const tld = parts[parts.length - 1]!;
  if (tld.length < TLD_MIN_LEN || tld.length > TLD_MAX_LEN) return false;
  if (!/^[a-z]+$/.test(tld)) return false;

  for (const label of parts) {
    if (!label.length) return false;
    if (!DOMAIN_LABEL_RE.test(label)) return false;
  }
  return true;
}

/**
 * Извлекает домен из email и проверяет его валидность.
 */
export function extractAndValidateDomainFromEmail(
  email: string | null | undefined,
): { domain: string } | null {
  const domain = extractDomainFromEmail(email);
  if (!domain || !isValidDomain(domain)) return null;
  return { domain };
}
