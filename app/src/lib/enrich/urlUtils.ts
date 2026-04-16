// Supports Unicode/IDN hostnames (e.g. партизанскиймаркетинг.рф, münchen.de).
// Node's URL constructor converts these to Punycode automatically.
const URL_TOKEN_REGEX = /(https?:\/\/[^\s]+|[\p{L}\p{N}.\-_]+\.[\p{L}]{2,}[^\s]*)/iu;
const URL_TOKEN_GLOBAL_REGEX = /(https?:\/\/[^\s]+|[\p{L}\p{N}.\-_]+\.[\p{L}]{2,}[^\s]*)/giu;

function normalizeUrlCandidate(candidate: string, rawForError: string): string {
  const cleaned = candidate.replace(/[),.;]+$/g, '');
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Невалидный URL: ${rawForError}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Неподдерживаемый протокол: ${parsed.protocol}`);
  }

  if (!parsed.hostname.includes('.')) {
    throw new Error(`Невалидный домен: ${parsed.hostname}`);
  }

  return parsed.href;
}

/**
 * Normalise a raw string into a valid `https://` URL.
 * Throws if the value cannot be turned into a URL.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Пустой URL');
  const tokenMatch = trimmed.match(URL_TOKEN_REGEX);
  const candidate = tokenMatch ? tokenMatch[0] : trimmed;
  return normalizeUrlCandidate(candidate, trimmed);
}

/**
 * Extract and normalize all URL-like tokens from a cell.
 * Useful for rows where several sites are listed in one string.
 */
export function extractNormalizedUrls(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];

  const matches = Array.from(trimmed.matchAll(URL_TOKEN_GLOBAL_REGEX), (match) => match[0]);
  const candidates = matches.length > 0 ? matches : [trimmed];
  const unique = new Set<string>();

  for (const candidate of candidates) {
    try {
      unique.add(normalizeUrlCandidate(candidate, trimmed));
    } catch {
      // Ignore broken fragments when the same cell contains other valid URLs.
    }
  }

  if (unique.size > 0) {
    return Array.from(unique);
  }

  return [normalizeUrl(trimmed)];
}
