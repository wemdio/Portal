/** Durable cost restriction, never evidence of relevance or a ready contact. */
export const VE_FREE_WEBSITE_SEARCH_FIELD = '_ve_free_website_search';

/** Preserve the ordinary setting for unrelated companies. A single restricted
 * observation closes paid discovery for its relevance group, including saved
 * retries and a group with several e-mail rows. Cached results remain usable. */
export function vePaidWebsiteSearchAllowed(
  rows: Array<Record<string, unknown>>, configured: boolean | undefined,
): boolean | undefined {
  return rows.some((row) => row[VE_FREE_WEBSITE_SEARCH_FIELD] === true) ? false : configured;
}

/** Constructor output drops private columns. Restore this restriction only
 * for the exact source identity that was admitted to the free RU rescue.
 * Company/site/INN cells remain unchanged by the canonical RU constructor. */
export function retainVeFreeWebsiteSearch<T extends Record<string, unknown>>(
  rows: T[], observations: Array<Record<string, unknown>>,
): T[] {
  const identity = (row: Record<string, unknown>) => {
    const cell = (key: string) => typeof row[key] === 'string' ? row[key].trim() : '';
    const company = cell('company'), website = cell('website');
    return company && website ? JSON.stringify([company, website, cell('inn')]) : null;
  };
  const restricted = new Set(observations.flatMap((row) => {
    if (row[VE_FREE_WEBSITE_SEARCH_FIELD] !== true) return [];
    const key = identity(row);
    return key ? [key] : [];
  }));
  return rows.map((row) => {
    const key = identity(row);
    return key && restricted.has(key) ? { ...row, [VE_FREE_WEBSITE_SEARCH_FIELD]: true } : row;
  });
}
