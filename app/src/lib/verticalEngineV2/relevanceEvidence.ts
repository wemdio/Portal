import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { VeOperationTimeoutError, withVeDeadline } from './operationDeadline';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { normalizeVeCompanyInn } from './collectionIdentity';
import { parseVeEvidencePage, selectVeEvidenceText, type VeEvidencePage } from './relevancePage';
import { searchVeRelevanceWebsites, veSearchProviderFailure, type VeSearchProviderFailure } from './relevanceSearch';

export interface VeRelevanceEvidence {
  status: 'ok' | 'unavailable' | 'error';
  text: string;
  url: string;
  reason: string;
  provider_error?: VeSearchProviderFailure;
}

export interface VeRelevanceEvidenceOptions {
  signal?: AbortSignal;
  companyInn?: string;
  focus?: string;
  /** Trusted offline adapters; never selected from user/source data. */
  fetchText?: (url: string) => Promise<string>;
  fetchPage?: (url: string, signal: AbortSignal) => Promise<VeEvidencePage>;
  search?: (query: string, signal: AbortSignal) => Promise<SerperOrganicItem[]>;
}

const TOTAL_TIMEOUT_MS = 25_000;
const PAGE_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_TEXT_CHARS = 6_000;
const MAX_PAGE_READS = 10;
const MAX_DOMAINS = 3;

function allowedUrl(value: string): URL | null {
  try {
    if (value.length > 1_000) return null;
    const url = new URL(value);
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || (url.port && !['80', '443'].includes(url.port))
      || isIP(host) || host.startsWith('[') || !host.includes('.')
      || /(^|\.)(localhost|local|internal)$/.test(host)) return null;
    url.hostname = host;
    url.hash = '';
    return url;
  } catch {
    return null;
  }
}

function websiteCandidates(raw: string): URL[] {
  const candidates = new Map<string, URL>();
  // A multi-value cell may contain emails, labels and several websites. Never
  // extract the domain from an email or repair a URL containing credentials.
  for (const token of raw.trim().split(/[\s,;|]+/).slice(0, 20)) {
    const candidate = token.replace(/^["'(<]+|["')>.]+$/g, '');
    if (!candidate || candidate.includes('@')) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) continue;
    const parsed = allowedUrl(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (parsed && !DIRECTORY_HOST.test(parsed.hostname) && !candidates.has(siteHost(parsed))) candidates.set(siteHost(parsed), parsed);
    if (candidates.size >= MAX_DOMAINS) break;
  }
  return [...candidates.values()];
}

function siteHost(url: URL): string { return url.hostname.replace(/^www\./, ''); }
const DIRECTORY_HOST = /(?:^|\.)(?:rusprofile\.ru|list-org\.com|saby\.ru|sbis\.ru|spark-interfax\.ru|companium\.ru|checko\.ru|zachestnyibiznes\.ru|egrul\.nalog\.ru|2gis\.ru|yandex\.ru|google\.com|vk\.com|ok\.ru|prodoctorov\.ru|zoon\.ru|companies\.rbc\.ru|check\.tochka\.com|e-ecolog\.ru|xfirm\.ru|tbank\.ru|ruspeach\.com)$/i;
const LEGAL_LINK = /контакт|реквизит|правов|оферт|политик|персональн|информаци[яи] о|contact|requisit|rekvizit|privacy|legal|oferta|about|o-klinik|o-kompan/i;
const SERVICE_LINK = /услуг|направлен|процедур|каталог|продукт|решени|service|uslug|treatment|product|solution|catalog|price|ceny/i;
function sameOriginLinks(page: VeEvidencePage): VeEvidencePage['links'] {
  return page.links.filter((link) => {
    const url = allowedUrl(link.url);
    return url?.origin === new URL(page.url).origin && !/\.(?:pdf|jpg|jpeg|png|zip|docx?)$/i.test(url.pathname);
  });
}

function publicIpv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113));
}

/** Narrow static-page reader. The shared website parser follows unchecked
 * redirects and crawls extra pages, so it is deliberately not used here.
 * Each hop passes the existing SSRF gate, then connects to a pinned public
 * IPv4 address; neither DNS rebinding nor a redirect can reach a private host.
 */
async function fetchEvidencePage(initialUrl: URL, signal: AbortSignal, focus?: string): Promise<VeEvidencePage> {
  let current = initialUrl;
  for (let hop = 0; hop <= 3; hop += 1) {
    await assertPublicWebsite(current.href);
    signal.throwIfAborted();
    const addresses = await lookup(current.hostname, { all: true, family: 4 });
    signal.throwIfAborted();
    if (!addresses.length || addresses.some(({ address }) => !publicIpv4(address))) {
      throw new Error('website_address_unavailable');
    }
    const pinned = addresses[0].address;
    const dispatcher = new Agent({
      connect: {
        family: 4,
        lookup: (_hostname, options, callback) => callback(null,
          options.all ? [{ address: pinned, family: 4 }] : pinned, 4),
      },
    });
    try {
      const response = await fetch(current.href, {
        dispatcher, signal, redirect: 'manual',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PortalWebsiteEvidence/1.0)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
          'Accept-Language': 'ru,en;q=0.7',
        },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        const next = location ? allowedUrl(new URL(location, current).href) : null;
        const sameSite = next?.hostname.replace(/^www\./, '') === initialUrl.hostname.replace(/^www\./, '');
        if (!next || !sameSite || hop === 3 || (current.protocol === 'https:' && next.protocol !== 'https:')) {
          throw new Error('website_redirect_unavailable');
        }
        current = next;
        continue;
      }
      const contentType = response.headers.get('content-type') ?? '';
      if (!response.ok || !/^(?:text\/(?:html|plain)|application\/xhtml\+xml)\b/i.test(contentType) || !response.body) {
        await response.body?.cancel();
        throw new Error('website_content_unavailable');
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BODY_BYTES) throw new Error('website_content_too_large');
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      signal.throwIfAborted();
      return parseVeEvidencePage(Buffer.concat(chunks), current.href, contentType, focus);
    } finally {
      // Destroy also aborts late/incomplete bodies; do not keep per-site sockets.
      await dispatcher.destroy();
    }
  }
  throw new Error('website_redirect_unavailable');
}

/** Bounded official-site evidence: at most 10 pages, one search, 25 seconds.
 * Search snippets are discovery only. With a known INN, every selected domain
 * must confirm that sole INN on its own pages before any activity is returned.
 * Unavailable, conflicting or unverified identity always stays needs_review.
 */
export async function fetchVeRelevanceEvidence(
  website: string,
  opts: VeRelevanceEvidenceOptions = {},
): Promise<VeRelevanceEvidence> {
  opts.signal?.throwIfAborted();
  const inn = normalizeVeCompanyInn(opts.companyInn);
  const supplied = websiteCandidates(website);
  if (!supplied.length && !inn) return { status: 'unavailable', text: '', url: '', reason: 'missing_or_unsafe_website' };
  const pages = new Map<string, Promise<VeEvidencePage | undefined>>();
  let failed = false, timedOut = false, unverified = false, searchAttempted = false;
  let providerError: VeSearchProviderFailure | undefined;
  const verified = new Map<string, VeEvidencePage[]>();
  const read = async (url: URL, parent: AbortSignal): Promise<VeEvidencePage | undefined> => {
    parent.throwIfAborted();
    if (pages.has(url.href)) return pages.get(url.href);
    if (pages.size >= MAX_PAGE_READS) return undefined;
    const task = withVeDeadline('relevance evidence page', PAGE_TIMEOUT_MS, parent, async (signal) => {
      const page = opts.fetchPage ? await opts.fetchPage(url.href, signal)
        : opts.fetchText ? { text: selectVeEvidenceText(await opts.fetchText(url.href), opts.focus), url: url.href, links: [], inns: [] }
          : await fetchEvidencePage(url, signal, opts.focus);
      signal.throwIfAborted();
      // Offline adapters have the same destination restrictions as transport.
      const finalUrl = allowedUrl(page.url);
      if (!finalUrl || siteHost(finalUrl) !== siteHost(url) || (url.protocol === 'https:' && finalUrl.protocol !== 'https:')) {
        throw new Error('website_redirect_unavailable');
      }
      return page;
    }).catch((error) => {
      parent.throwIfAborted();
      failed = true;
      timedOut ||= error instanceof VeOperationTimeoutError;
      return undefined;
    });
    pages.set(url.href, task);
    return task;
  };
  const inspect = async (start: URL, initial: VeEvidencePage | undefined, signal: AbortSignal): Promise<VeEvidencePage[]> => {
    const sitePages: VeEvidencePage[] = initial ? [initial] : [];
    const identity = () => {
      const seen = new Set(sitePages.flatMap((page) => page.inns));
      const owners = new Set(sitePages.flatMap((page) => page.ownerInns ?? []));
      return !inn ? 'supplied' : [...seen].some((value) => value !== inn) ? 'conflict'
        : owners.size === 1 && owners.has(inn) ? 'verified' : 'unknown';
    };
    if (inn && identity() === 'unknown') {
      const legal = initial ? sameOriginLinks(initial).filter((link) => LEGAL_LINK.test(link.text + ' ' + link.url)).map((link) => link.url) : [];
      const base = new URL(initial?.url ?? start.href);
      for (const href of [...new Set([...legal, new URL('/contacts', base).href])].slice(0, 2)) {
        const url = allowedUrl(href);
        if (!url) continue;
        const page = await read(url, signal);
        if (page) sitePages.push(page);
        if (identity() !== 'unknown') break;
      }
    }
    if (identity() === 'conflict' || identity() === 'unknown') { unverified = true; return []; }
    // Use actual same-origin links, including deeper service sections. Focus
    // ranking comes from the page parser; never invent a target-specific path.
    const home = sitePages[0];
    if (!home) return [];
    const host = siteHost(new URL(home.url));
    const publish = () => verified.set(host, sitePages.filter((page) => Boolean(page.text)));
    // Preserve already verified pages if a later optional service read times out.
    publish();
    const links = sitePages.flatMap(sameOriginLinks);
    const serviceUrls = [...new Set(links.filter((link) => SERVICE_LINK.test(link.text + ' ' + link.url)).map((link) => link.url))];
    const focusWords = (opts.focus?.toLowerCase().match(/[\p{L}]{5,}/gu) ?? []).map((word) => word.slice(0, 5));
    const focused = links.filter((link) => focusWords.some((word) => (link.text + ' ' + link.url).toLowerCase().includes(word))).map((link) => link.url);
    const fallback = new URL(/\.(?:ru|xn--p1ai)$/i.test(new URL(home.url).hostname) ? '/uslugi' : '/services', home.url).href;
    for (const href of [...new Set([...focused, ...serviceUrls, fallback])].filter((url) => !sitePages.some((page) => page.url === url)).slice(0, 2)) {
      const url = allowedUrl(href);
      if (!url || url.origin !== new URL(home.url).origin) continue;
      const page = await read(url, signal);
      if (page) sitePages.push(page);
      if (identity() === 'conflict') { verified.delete(host); unverified = true; return []; }
      publish();
    }
    // A legal footer on a later service page can expose another entity.
    if (identity() === 'conflict') { verified.delete(host); unverified = true; return []; }
    return sitePages.filter((page) => Boolean(page.text));
  };
  try {
    await withVeDeadline('relevance website evidence', TOTAL_TIMEOUT_MS, opts.signal, async (signal) => {
      // Without a strong identity, do not move across unrelated supplied domains.
      const candidates = inn ? supplied : supplied.slice(0, 1);
      const homes = await Promise.all(candidates.map((url) => read(url, signal)));
      for (let i = 0; i < candidates.length; i += 1) {
        await inspect(candidates[i], homes[i], signal);
      }
      if (verified.size || !inn || pages.size >= MAX_PAGE_READS) return;
      signal.throwIfAborted();
      searchAttempted = true;
      const query = '"' + inn + '" официальный сайт -site:rusprofile.ru -site:list-org.com -site:checko.ru -site:companium.ru';
      let results: SerperOrganicItem[];
      try {
        results = await withVeDeadline('relevance website search', 6_000, signal, async (searchSignal) =>
          opts.search ? opts.search(query, searchSignal) : searchVeRelevanceWebsites(query, searchSignal));
      } catch (error) {
        signal.throwIfAborted();
        providerError = veSearchProviderFailure(error);
        return;
      }
      signal.throwIfAborted();
      const found: URL[] = [];
      for (const item of results.slice(0, 6)) {
        const url = typeof item.link === 'string' ? allowedUrl(item.link) : null;
        if (!url || DIRECTORY_HOST.test(url.hostname) || /\.(?:pdf|docx?|zip)$/i.test(url.pathname)
          || found.some((other) => siteHost(other) === siteHost(url))) continue;
        found.push(url);
        if (found.length >= MAX_DOMAINS) break;
      }
      for (const url of found) {
        await inspect(url, await read(url, signal), signal);
        if (verified.size) return;
      }
    });
  } catch (error) {
    opts.signal?.throwIfAborted();
    failed = true;
    timedOut ||= error instanceof VeOperationTimeoutError;
  }
  opts.signal?.throwIfAborted();
  if (providerError) return {
    status: 'error', text: '', url: supplied[0]?.href ?? '',
    reason: providerError.message, provider_error: providerError,
  };
  // Reserve room for every page rather than letting a long home/menu consume
  // all evidence. Focus selection has already scanned each complete document.
  const selected = [...verified.values()].flat();
  const unique = selected.filter((page, index) => selected.findIndex((other) => other.url === page.url) === index);
  const perPage = Math.floor((MAX_TEXT_CHARS - unique.reduce((n, page) => n + page.url.length + 8, 0)) / Math.max(1, unique.length));
  const text = unique.map((page) => `URL: ${page.url}\n${selectVeEvidenceText(page.text, opts.focus, Math.max(200, perPage))}`).join('\n\n').slice(0, MAX_TEXT_CHARS);
  return {
    status: text ? 'ok' : 'unavailable', text, url: unique[0]?.url ?? supplied[0]?.href ?? '',
    reason: text ? (searchAttempted ? 'discovered_verified_website' : inn ? 'identity_verified_website' : 'supplied_website_evidence')
      : timedOut ? 'website_evidence_timeout' : unverified ? 'website_identity_unverified'
        : failed ? 'website_evidence_failed' : searchAttempted ? 'website_search_unverified' : 'no_usable_website_text',
  };
}
