function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  if (!email) return null;
  // Basic sanity checks
  if (email.length > 254) return null;
  if (!email.includes('@')) return null;
  if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/i.test(email)) return null;
  return email;
}

/**
 * Extract emails from plain text (best-effort).
 * Handles some common obfuscations like "name [at] domain [dot] com".
 */
export function extractEmails(text: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const normalized = text
    .replace(/\s*\[\s*at\s*]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s*\[\s*dot\s*]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.');

  const matches = normalized.match(/[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi) ?? [];
  for (const m of matches) {
    const email = normalizeEmail(m);
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    results.push(email);
  }
  return results;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract emails from HTML: mailto: links + visible text.
 */
export function extractEmailsFromHtml(html: string): string[] {
  const seen = new Set<string>();
  const results: string[] = [];

  const mailtoRegex = /href=["']mailto:([^"'?\s>]+)[^"'>]*["']/gi;
  let match: RegExpExecArray | null;
  while ((match = mailtoRegex.exec(html)) !== null) {
    const email = normalizeEmail(match[1] ?? '');
    if (!email) continue;
    if (seen.has(email)) continue;
    seen.add(email);
    results.push(email);
  }

  for (const email of extractEmails(stripHtml(html))) {
    if (seen.has(email)) continue;
    seen.add(email);
    results.push(email);
  }

  return results;
}

