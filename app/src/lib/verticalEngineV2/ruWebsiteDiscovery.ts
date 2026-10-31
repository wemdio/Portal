import * as cheerio from 'cheerio';
import { fetchFollowingGuarded, readBodyCapped, decodeHtml } from '@/lib/enrich/websiteParser';
import { createUsWebsiteFetchGuard } from '@/lib/enrich/publicAddress';
import { sameCompanySiteBoundary } from '@/lib/enrich/companySiteAlias';
import { fetchEngPageFallback } from '@/lib/enrich/engPageFallback';
import { isEngHtmlBlocked } from '@/lib/enrich/engPageFallbackPolicy';
import { normalizeVeCompanyName } from './collectionIdentity';
import { isVeNonOfficialWebsiteHost } from './relevanceEvidence';
import { withVeDeadline } from './operationDeadline';

export interface VeRuDiscoveredCompany {
  company: string; website: string; email: string; inn: string; address: string;
  source_detail: string; description: string;
}
const ORGANIZATION = new Set(['Organization', 'Corporation', 'LocalBusiness', 'ProfessionalService', 'LegalService',
  'FinancialService', 'InsuranceAgency', 'MedicalOrganization', 'MedicalBusiness', 'MedicalClinic', 'Dentist',
  'EducationalOrganization', 'EmploymentAgency', 'OnlineBusiness', 'OnlineStore', 'Store', 'RealEstateAgent',
  'TravelAgency', 'LodgingBusiness', 'Hotel', 'Restaurant', 'FoodEstablishment', 'AutomotiveBusiness',
  'HomeAndConstructionBusiness', 'SportsActivityLocation', 'HealthAndBeautyBusiness']);
const clean = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
const GENERIC_NAME = /^(?:главная|домашняя страница|контакты|о компании|официальный сайт|home|homepage|contacts?|about(?: us)?|welcome)$/iu;

/** SERP URLs are candidates, never company identities. Only public HTTPS
 * company homes are read; known catalog/social/job-board hosts are rejected. */
export function veRuDiscoveryHome(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || isVeNonOfficialWebsiteHost(url.hostname)) return null;
    return `${url.origin}/`;
  } catch { return null; }
}

/** A literal name on the company's own site is required. Search result titles
 * and snippets are intentionally absent from this interface. */
export function extractVeRuDiscoveredCompany(html: string, pageUrl: string, options?: { originalHtml?: string }): VeRuDiscoveredCompany | null {
  if (!veRuDiscoveryHome(pageUrl) || !html || html.length > 1_048_576 || isEngHtmlBlocked(html)) return null;
  const $ = cheerio.load(html);
  // Fetch HTML contains body only. Original same-site successful HTML can
  // supply its head metadata; its identity must then occur in rendered text.
  const original = options?.originalHtml;
  const metadata = !$('title, meta[property="og:site_name"], script[type="application/ld+json"]').length
    && original && original.length <= 1_048_576 ? cheerio.load(original) : $;
  const title = clean(metadata('title').text());
  const siteName = clean(metadata('meta[property="og:site_name"]').attr('content'));
  const description = clean(metadata('meta[name="description"]').attr('content'));
  let company = '';
  let source = '';
  let taxId = '';
  let address = '';
  metadata('script[type="application/ld+json"]').slice(0, 16).each((_, script) => {
    if (company) return;
    const raw = metadata(script).text();
    if (raw.length > 256_000) return;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return; }
    const queue: unknown[] = [value];
    for (let index = 0; index < queue.length && index < 256; index++) {
      const item = queue[index];
      if (Array.isArray(item)) { queue.push(...item.slice(0, 256)); continue; }
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      if (Array.isArray(record['@graph'])) queue.push(...record['@graph'].slice(0, 256));
      const types = (Array.isArray(record['@type']) ? record['@type'] : [record['@type']])
        .map((type) => typeof type === 'string' ? type.replace(/^https?:\/\/schema\.org\//, '') : '');
      if (!types.some((type) => ORGANIZATION.has(type))) continue;
      const name = clean(record.legalName) || clean(record.name);
      const ownUrl = clean(record.url);
      if (!name || name.length > 240 || !normalizeVeCompanyName(name) || GENERIC_NAME.test(normalizeVeCompanyName(name)) || !ownUrl) continue;
      try {
        const url = new URL(ownUrl, pageUrl);
        if (!sameCompanySiteBoundary(url.href, pageUrl)) continue;
      } catch { continue; }
      company = name; source = 'JSON-LD Organization';
      const tax = clean(record.taxID).replace(/^RU\s*/i, '');
      if (/^(?:\d{10}|\d{12})$/.test(tax)) taxId = tax;
      const rawAddress = record.address;
      if (typeof rawAddress === 'string') address = clean(rawAddress).slice(0, 500);
      else if (rawAddress && typeof rawAddress === 'object' && !Array.isArray(rawAddress)) {
        const parts = rawAddress as Record<string, unknown>;
        address = ['postalCode', 'addressRegion', 'addressLocality', 'streetAddress'].map((key) => clean(parts[key])).filter(Boolean).join(', ').slice(0, 500);
      }
      break;
    }
  });
  $('script, style, noscript, svg').remove();
  const text = clean($('body').text());
  if (company && metadata !== $ && !` ${normalizeVeCompanyName(text)} `.includes(` ${normalizeVeCompanyName(company)} `)) return null;
  if (!company && siteName && siteName.length <= 240) {
    const brand = normalizeVeCompanyName(siteName);
    const visible = ` ${normalizeVeCompanyName(text)} `;
    if (brand.length >= 3 && !GENERIC_NAME.test(brand) && visible.includes(` ${brand} `)
      && ` ${normalizeVeCompanyName(title)} `.includes(` ${brand} `)) {
      company = siteName; source = 'og:site_name + visible page';
    }
  }
  if (!company || text.length < 30) return null;
  const observedInns = new Set([...text.matchAll(/(?:ИНН|inn)\s*[:–—]?\s*(\d{12}|\d{10})(?!\d)/gi)].map((match) => match[1]));
  // A footer may also identify the web studio/payment operator. Only the
  // accepted Organization's own taxID, corroborated in text, becomes an INN.
  const inn = taxId && observedInns.size === 1 && observedInns.has(taxId) ? taxId : '';
  return { company, website: pageUrl, email: '', inn, address,
    source_detail: `TinyFish Search; название подтверждено на собственном сайте (${source}): ${pageUrl}`,
    description: (description || text).slice(0, 2000) };
}

/** One guarded site read; a real empty 2xx may use the existing RU readers.
 * Blocks, missing responses and foreign redirects never enable a provider. */
export async function readVeRuDiscoveredCompany(rawUrl: string, parentSignal?: AbortSignal): Promise<VeRuDiscoveredCompany | null> {
  const url = veRuDiscoveryHome(rawUrl);
  if (!url) return null;
  try {
    return await withVeDeadline('RU website discovery', 30_000, parentSignal, async (signal) => {
      const directSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
      const guard = createUsWebsiteFetchGuard({ maxRedirects: 3 });
      const options: RequestInit & { dispatcher?: unknown } = { method: 'GET', redirect: 'manual', signal: directSignal,
        headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'ru,en;q=0.5' },
        dispatcher: guard.directDispatcher };
      const { res, url: finalUrl } = await fetchFollowingGuarded(url, options, guard, directSignal);
      signal.throwIfAborted();
      if (res.status < 200 || res.status >= 300 || !/^(?:text\/html|application\/xhtml\+xml)(?:;|$)/i.test(res.headers.get('content-type') ?? '')
        || !sameCompanySiteBoundary(finalUrl, url) || !veRuDiscoveryHome(finalUrl)
        || Number(res.headers.get('content-length')) > 1_048_576) { void res.body?.cancel().catch(() => {}); return null; }
      let html = decodeHtml(await readBodyCapped(res, 1_048_576, finalUrl), res.headers.get('content-type'));
      signal.throwIfAborted();
      const originalHtml = html;
      if (isEngHtmlBlocked(html)) return null;
      let observedUrl = finalUrl;
      const fallback = await fetchEngPageFallback({ url: finalUrl, companyUrl: url, html, status: res.status,
        signal, locale: 'ru', ruDeficit: true });
      if (fallback) { html = fallback.html; observedUrl = fallback.url; }
      return extractVeRuDiscoveredCompany(html, observedUrl, { originalHtml });
    });
  } catch {
    parentSignal?.throwIfAborted();
    return null;
  }
}
