import { extractEmail, findColumnIndex } from './dfybUtils';
import { WEBSITE_EMAIL_PREFERENCE_COL } from './baseConstructorCheckpoint';

/** Avoid copying a company's entire address list into every split row. */
export function compactWebsiteEmailPreferences(data: string[][]): string[][] {
  const header = data[0] ?? [];
  const preferenceIdx = header.indexOf(WEBSITE_EMAIL_PREFERENCE_COL);
  if (preferenceIdx < 0) return data;
  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const cache = new Map<string, { group: string; found: Set<string> } | null>();
  return [header, ...data.slice(1).map((row) => {
    const raw = row[preferenceIdx];
    if (!cache.has(raw)) {
      try {
        const parsed = JSON.parse(raw);
        cache.set(raw, typeof parsed?.group === 'string' && Array.isArray(parsed.found)
          ? { group: parsed.group, found: new Set(parsed.found) } : null);
      } catch { cache.set(raw, null); }
    }
    const preference = cache.get(raw);
    if (!preference) return row;
    const email = extractEmail(row[emailIdx] || '')?.toLowerCase() ?? '';
    const out = [...row];
    out[preferenceIdx] = JSON.stringify({
      group: preference.group, found: preference.found.has(email) ? [email] : [],
    });
    return out;
  })];
}

/** Keep database fallback addresses unless a website address passed validation.
 * Rows have already been split to one email and validated. Unknown website
 * addresses remain available for recovery, but cannot suppress an OK fallback.
 */
export function selectValidatedWebsiteEmails(data: string[][]): string[][] {
  const header = data[0] ?? [];
  const preferenceIdx = header.indexOf(WEBSITE_EMAIL_PREFERENCE_COL);
  if (preferenceIdx < 0) return data;
  const emailIdx = findColumnIndex(header, 'email', 'e-mail', 'почта', 'mail');
  const statusIdx = emailIdx < 0 ? -1 : header.findIndex(
    (label) => label.trim() === `${header[emailIdx].trim()} Статус`,
  );
  const parsed = data.slice(1).map((row) => {
    try {
      const value: unknown = JSON.parse(row[preferenceIdx] || 'null');
      if (!value || typeof value !== 'object') return null;
      const { group, found } = value as Record<string, unknown>;
      if (typeof group !== 'string' || !Array.isArray(found)) return null;
      const email = extractEmail(row[emailIdx] || '')?.toLowerCase();
      return { group, isFound: Boolean(email && found.includes(email)) };
    } catch {
      return null;
    }
  });
  const acceptedGroups = new Set<string>();
  data.slice(1).forEach((row, index) => {
    const preference = parsed[index];
    const status = row[statusIdx];
    if (preference?.isFound && (status === 'ok' || status === 'catch_all')) {
      acceptedGroups.add(preference.group);
    }
  });
  const body = data.slice(1).filter((_row, index) => {
    const preference = parsed[index];
    return !preference || preference.isFound || !acceptedGroups.has(preference.group);
  });
  return [header, ...body].map((row) => row.filter((_cell, index) => index !== preferenceIdx));
}
