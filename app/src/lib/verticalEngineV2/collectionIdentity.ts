/** Conservative identities shared by VE2 acquisition and retained candidates. */
export function normalizeVeCompanyInn(value: unknown): string {
  const digits = String(value ?? '').replace(/\D/g, '');
  return digits.length === 10 || digits.length === 12 ? digits : '';
}

export function normalizeVeCompanyName(value: unknown): string {
  return ` ${String(value ?? '').trim().toLowerCase()} `
    .replace(/[^0-9a-zа-яё\s]+/gi, ' ')
    .replace(/(^|\s)(ооо|ип|пао|зао|оао|ано|нко|ао|llc|ltd|inc|ooo|corporation|corp|limited|llp|lp|gmbh|plc|sarl|sa|ag|bv|nv|pty|pte)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

export function normalizeVeWebsiteHost(value: unknown): string {
  // Collectors sometimes return multiple sites. Use one valid host as the
  // identity hint, never a comma-delimited string or arbitrary free text.
  for (const raw of String(value ?? '').trim().toLowerCase().split(/[\s,;|]+/)) {
    if (!raw || raw.includes('@')) continue;
    try {
      const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) continue;
      const host = url.hostname.replace(/^www\./, '').replace(/\.+$/, '');
      if (/^[a-z0-9.-]+\.(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(host)) return host;
    } catch { /* Not a usable website identity. */ }
  }
  return '';
}

export function veCompanyWebsiteKey(row: { company?: unknown; website?: unknown }): string | null {
  const company = normalizeVeCompanyName(row.company);
  const website = normalizeVeWebsiteHost(row.website);
  return company && website ? JSON.stringify([company, website]) : null;
}

/** A generic name alone cannot establish that two source rows are one company. */
export function veCompanyIdentityKey(row: { company?: unknown; website?: unknown; inn?: unknown }): string | null {
  const inn = normalizeVeCompanyInn(row.inn);
  if (inn) return `inn:${inn}`;
  const websiteKey = veCompanyWebsiteKey(row);
  return websiteKey ? `site:${websiteKey}` : null;
}

/** Keep complementary source facts; repeated observations must be idempotent. */
export function mergeVeSourceFactText(left: unknown, right: unknown): string {
  const first = String(left ?? '').trim(), next = String(right ?? '').trim();
  if (!first) return next;
  if (!next) return first;
  const normalize = (text: string) => text.replace(/\s+/g, ' ').toLowerCase();
  const firstKey = normalize(first), nextKey = normalize(next);
  if (firstKey.includes(nextKey)) return first;
  if (nextKey.includes(firstKey)) return next;
  return `${first}\n${next}`;
}
