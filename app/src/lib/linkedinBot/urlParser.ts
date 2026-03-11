/**
 * Parse LinkedIn companies search URL to extract keywords.
 */
const TEMPLATE = 'https://www.linkedin.com/search/results/companies';

export function parseLinkedInSearchUrl(url: string): { keywords: string; valid: boolean } {
  const trimmed = url.trim();
  if (!trimmed.startsWith(TEMPLATE)) {
    return { keywords: '', valid: false };
  }
  try {
    const u = new URL(trimmed);
    const keywords = u.searchParams.get('keywords') ?? '';
    return { keywords, valid: true };
  } catch {
    return { keywords: '', valid: false };
  }
}
