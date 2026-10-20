import { parse } from 'tldts';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';

/** Internal ENG constructor column; never a customer-supplied description. */
export const ENG_WEBSITE_EVIDENCE_COL = '_eng_website_evidence';
const MAX_CHARS = 6000;
const MAX_PAGES = 3;
const EMAIL = /[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const BUILDERS = ['wixsite.com', 'squarespace.com', 'webflow.io', 'tilda.ws', 'weebly.com',
  'wordpress.com', 'godaddysites.com', 'myshopify.com', 'business.site'];

export interface EngWebsiteEvidencePage { url: string; text: string; truncated?: boolean }
export interface EngWebsiteEvidence {
  version: 1;
  source: 'constructor_website';
  website: string;
  pages: EngWebsiteEvidencePage[];
}

function cleanUrl(raw: string): string | null {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const parsed = parse(url.hostname, { allowPrivateDomains: true });
    if (parsed.isIp || !parsed.domain) return null;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

function boundary(raw: string): string {
  const host = new URL(raw).hostname.replace(/\.+$/, '');
  return BUILDERS.some((value) => host === value || host.endsWith(`.${value}`))
    ? host : parse(host, { allowPrivateDomains: true }).domain!;
}

/** Only extracted pages with their observed final URL can become reusable evidence. */
export function buildEngWebsiteEvidence(website: string, input: EngWebsiteEvidencePage[]): EngWebsiteEvidence | null {
  const root = cleanUrl(website);
  if (!root) return null;
  const pages: EngWebsiteEvidencePage[] = [];
  let remaining = MAX_CHARS;
  for (const page of input) {
    const url = cleanUrl(page.url);
    if (!url || boundary(url) !== boundary(root) || (root.startsWith('https:') && !url.startsWith('https:')) ||
        pages.some((saved) => saved.url === url) || typeof page.text !== 'string') continue;
    const cleaned = stripUnstorableJsonChars(page.text.replace(EMAIL, '[email removed]')).trim();
    const text = sliceWholeChars(cleaned, 0, remaining);
    if (text.length < 12) continue;
    pages.push({ url, text, ...(page.truncated || text.length < cleaned.length ? { truncated: true } : {}) });
    remaining -= text.length;
    if (pages.length >= MAX_PAGES || remaining < 12) break;
  }
  return pages.length ? { version: 1, source: 'constructor_website', website: root, pages } : null;
}

/** Read only canonical producer output bound to this exact constructor input site. */
export function readEngWebsiteEvidence(raw: unknown, website: string): EngWebsiteEvidence | null {
  try {
    if (typeof raw !== 'string' || raw.length > 32_000) return null;
    const value = JSON.parse(raw) as EngWebsiteEvidence;
    if (value?.version !== 1 || value.source !== 'constructor_website' || value.website !== cleanUrl(website) ||
        !Array.isArray(value.pages) || value.pages.length > MAX_PAGES || value.pages.some((page) =>
          !page || typeof page.url !== 'string' || typeof page.text !== 'string' ||
          (page.truncated !== undefined && page.truncated !== true))) return null;
    const checked = buildEngWebsiteEvidence(website, value.pages);
    return checked && JSON.stringify(checked) === JSON.stringify(value) ? checked : null;
  } catch { return null; }
}
