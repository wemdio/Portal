const URL_TOKEN_REGEX = /(https?:\/\/[^\s]+|[\w.-]+\.[a-z]{2,}[^\s]*)/i;

/**
 * Normalise a raw string into a valid `https://` URL.
 * Throws if the value cannot be turned into a URL.
 */
export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error('Пустой URL');
  const tokenMatch = trimmed.match(URL_TOKEN_REGEX);
  const candidate = tokenMatch ? tokenMatch[0] : trimmed;
  const cleaned = candidate.replace(/[),.;]+$/g, '');
  const withScheme = /^https?:\/\//i.test(cleaned) ? cleaned : `https://${cleaned}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Невалидный URL: ${trimmed}`);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`Неподдерживаемый протокол: ${parsed.protocol}`);
  }

  // Basic hostname check: at least one dot
  if (!parsed.hostname.includes('.')) {
    throw new Error(`Невалидный домен: ${parsed.hostname}`);
  }

  return parsed.href;
}
