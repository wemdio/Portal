/** Company-site exclusions apply to new processing/uploads, never to historical data. */
const MAILGANER_CLIENT_ID = '0a6d90e1-91d0-404e-b508-6b031bda7cfd';
const MAILGANER_EXCLUDED_SUFFIXES: readonly string[] = Object.freeze(['.com']);
const NO_EXCLUSIONS: readonly string[] = Object.freeze([]);

export function getClientExcludedDomainSuffixes(clientUserId: string): readonly string[] {
  return clientUserId === MAILGANER_CLIENT_ID ? MAILGANER_EXCLUDED_SUFFIXES : NO_EXCLUSIONS;
}

export function isClientDomainExcluded(
  clientUserId: string,
  value: string | null | undefined,
): boolean {
  const suffixes = getClientExcludedDomainSuffixes(clientUserId);
  if (!suffixes.length || !value?.trim()) return false;
  try {
    const input = value.trim();
    const url = new URL(input.startsWith('//') ? `https:${input}` : /^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : `https://${input}`);
    const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
    return suffixes.some((suffix) => hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

export function filterClientDomainLeads<T extends {
  email: string;
  website?: string;
  custom_variables?: Record<string, unknown>;
}>(leads: readonly T[], clientUserId: string): { kept: T[]; blockedCount: number } {
  const kept = leads.filter((lead) => {
    // A free mailbox such as Gmail is not evidence of the company's website/country.
    const sites = [lead.website, lead.custom_variables?.domain, lead.custom_variables?.website, lead.custom_variables?.site_url];
    return !sites.some((site) => typeof site === 'string' && isClientDomainExcluded(clientUserId, site));
  });
  return { kept, blockedCount: leads.length - kept.length };
}
