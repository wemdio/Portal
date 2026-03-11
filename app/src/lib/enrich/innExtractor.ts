/** Extract first INN (10 or 12 digits) from text. Russian companies often publish ИНН in footer/requisites. */
export function extractInnFromText(text: string): string | null {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/(?:ИНН|inn|инн)\s*[:–—]?\s*(\d{12}|\d{10})(?!\d)/i);
  return m ? m[1] : null;
}

/**
 * Extract INN from raw HTML source — catches INN in meta tags, JSON-LD,
 * HTML attributes, comments, and JS strings that text extraction misses.
 */
export function extractInnFromHtml(html: string): string | null {
  if (!html || typeof html !== 'string') return null;

  // 1) Try standard text-based extraction first (works if INN is in visible text)
  const fromText = extractInnFromText(html);
  if (fromText) return fromText;

  // 2) Look for INN in structured patterns common in Russian websites
  const patterns = [
    /["']inn["']\s*:\s*["'](\d{12}|\d{10})["']/i,
    /data-inn=["'](\d{12}|\d{10})["']/i,
    /["']ИНН["']\s*:\s*["'](\d{12}|\d{10})["']/i,
    /ИНН\s*<[^>]*>\s*(\d{12}|\d{10})/i,
    /inn[_-]?number["']?\s*[:=]\s*["']?(\d{12}|\d{10})/i,
  ];

  for (const pat of patterns) {
    const m = html.match(pat);
    if (m?.[1]) return m[1];
  }

  return null;
}
