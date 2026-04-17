/**
 * Pure helpers for working with LinkedIn lead data.
 *
 * Kept framework-free and side-effect-free so they can be unit-tested in isolation
 * and reused both in the campaign runner and in import / backfill scripts.
 */

/**
 * Extracts the LinkedIn `public_identifier` (the slug after `/in/`) from a profile URL.
 *
 * Handles the variations we see in imported data:
 *  - http(s):// or no protocol
 *  - www / m subdomains
 *  - trailing slash
 *  - query string (?trk=...) and fragment (#about)
 *  - nested paths like /in/<slug>/details/experience
 *
 * Returns `null` for anything that isn't a `/in/<slug>` profile URL — e.g. company pages,
 * feed URLs, empty / null / random text — so callers can safely chain with `??`.
 */
export function extractPublicIdentifier(profileUrl: string | null | undefined): string | null {
  if (!profileUrl || typeof profileUrl !== 'string') return null;
  const trimmed = profileUrl.trim();
  if (!trimmed) return null;

  // Capture the segment that immediately follows "/in/", up to the next "/", "?", "#" or end.
  // Restrict to LinkedIn hosts (linkedin.com / www.linkedin.com / m.linkedin.com / ru.linkedin.com / …).
  const match = trimmed.match(/(?:^|\/\/|\.)linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!match || !match[1]) return null;

  const slug = match[1].trim();
  return slug.length > 0 ? slug : null;
}
