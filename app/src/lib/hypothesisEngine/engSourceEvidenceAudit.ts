import { createHash } from 'node:crypto';
import * as cheerio from 'cheerio';
import { sliceWholeChars, stripUnstorableJsonChars } from '@/lib/jsonbSafe';

/** Private collection diagnostics, never evidence that can admit a company. */
export interface HeEngSourcePageAudit {
  url: string;
  requestSha256: string;
  finalUrl?: string;
  status: 'loaded' | 'unavailable';
  htmlSha256?: string;
  title?: string;
  evidence?: string;
  evidenceOmitted?: boolean;
  identity?: boolean;
  employeeFit?: string;
  country?: string;
}

export interface HeEngSourceEvidenceAudit {
  version: 1;
  source: string;
  country?: string;
  countrySource?: string;
  catalogMatches?: number;
  pages: HeEngSourcePageAudit[];
}

function clean(value: string, max: number): string {
  return sliceWholeChars(stripUnstorableJsonChars(value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,63}/gi, '[email removed]')
    .replace(/\s+/g, ' ').trim(), 0, max);
}

function urlForAudit(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
    // Query values and fragments may carry tokens. They are not identity proof.
    return clean(`${url.origin}${url.pathname}`, 1000);
  } catch { return ''; }
}

export function createHeEngSourceEvidenceAudit(source: string, country?: string): HeEngSourceEvidenceAudit {
  return { version: 1, source: clean(source, 80), ...(country ? { country: clean(country, 80) } : {}), pages: [] };
}

/** Keep reasons/observations/hashes for every company, but bound saved excerpts
 * across all completed waves. Prefer recent excerpts; never reread a paid source.
 */
export function compactHeEngSourceEvidenceAudits(audits: readonly (HeEngSourceEvidenceAudit | undefined)[], maxBytes = 2 * 1024 * 1024): void {
  let remaining = Math.max(0, maxBytes);
  for (let index = audits.length - 1; index >= 0; index--) {
    for (const page of audits[index]?.pages ?? []) {
      if (page.evidence === undefined) continue;
      const bytes = Buffer.byteLength(page.evidence, 'utf8');
      if (bytes <= remaining) remaining -= bytes;
      else { delete page.evidence; page.evidenceOmitted = true; }
    }
  }
}

/** Bounded excerpts survive wave cleanup; full HTML is not copied into collect_info. */
export function recordHeEngSourcePageAudit(
  audit: HeEngSourceEvidenceAudit,
  requestedUrl: string,
  page: { url: string; html: string } | null,
): HeEngSourcePageAudit {
  const entry: HeEngSourcePageAudit = { url: urlForAudit(requestedUrl),
    requestSha256: createHash('sha256').update(requestedUrl).digest('hex'), status: page ? 'loaded' : 'unavailable' };
  if (page) {
    entry.finalUrl = urlForAudit(page.url);
    entry.htmlSha256 = createHash('sha256').update(page.html).digest('hex');
    if (page.html.length <= 1_500_000) {
      const $ = cheerio.load(page.html);
      entry.title = clean($('title, h1').slice(0, 3).toArray().map(node => $(node).text()).join(' | '), 240);
      const structured: string[] = [];
      let visited = 0;
      const walk = (value: unknown, depth: number): void => {
        if (depth > 8 || ++visited > 300 || structured.length >= 3) return;
        if (Array.isArray(value)) { value.slice(0, 30).forEach(item => walk(item, depth + 1)); return; }
        if (!value || typeof value !== 'object') return;
        const org = value as Record<string, unknown>;
        if (org.name || org.legalName) {
          const fields = ['@type', 'name', 'legalName', 'identifier', 'taxID', 'vatID', 'address', 'numberOfEmployees'];
          structured.push(clean(JSON.stringify(Object.fromEntries(fields.filter(key => org[key] !== undefined)
            .map(key => [key, org[key]]))), 600));
        }
        for (const [key, child] of Object.entries(org)) if (key !== '@context') walk(child, depth + 1);
      };
      $('script[type="application/ld+json"]').slice(0, 12).each((_index, node) => {
        const raw = $(node).text();
        if (raw.length <= 256_000) { try { walk(JSON.parse(raw), 0); } catch { /* Diagnostics do not repair source data. */ } }
      });
      $('script, style, noscript, template').remove();
      const legal = $('footer, [role="contentinfo"], address, #contact, .contact, #legal, .legal, #imprint, .imprint')
        .slice(0, 8).toArray().map(node => clean($(node).text(), 1200)).filter(Boolean);
      entry.evidence = clean([...structured, ...legal].join(' | '), 2400);
    }
  }
  // Registry resolution has at most three sites and three pages per site.
  // Retry observations may replace the same page rather than grow indefinitely.
  const index = audit.pages.findIndex(item => item.requestSha256 === entry.requestSha256);
  if (index >= 0) audit.pages[index] = entry;
  else if (audit.pages.length < 9) audit.pages.push(entry);
  return entry;
}
