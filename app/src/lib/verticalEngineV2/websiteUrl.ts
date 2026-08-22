import { domainToUnicode } from 'node:url';

/**
 * Normalize a specialist-supplied client website without importing the
 * ENG-owned Hypothesis Engine helper.
 */
/** Alias used by the cloned engine modules (HE called this normalizeWebsiteInput). */
export function normalizeWebsiteInput(
  raw: string,
): { url: string; hostname: string } | null {
  return normalizeVeWebsiteInput(raw);
}

export function normalizeVeWebsiteInput(
  raw: string,
): { url: string; hostname: string } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(hostname)) return null;
  if (!hostname.includes('.') || hostname.includes('..')) return null;

  const unicodeHostname = domainToUnicode(hostname) || hostname;
  const url =
    unicodeHostname === hostname
      ? parsed.href
      : `${parsed.protocol}//${unicodeHostname}${parsed.port ? `:${parsed.port}` : ''}${parsed.pathname}${parsed.search}${parsed.hash}`;

  return { url, hostname: unicodeHostname };
}
