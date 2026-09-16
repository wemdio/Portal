import { Resolver } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch } from 'undici';
import { ProviderUsageWriteError } from '@/lib/providerUsage';
import { VeOperationTimeoutError, withVeDeadline } from './operationDeadline';
import type { SerperOrganicItem } from '@/lib/search/serperClient';
import { normalizeVeCompanyInn, normalizeVeCompanyName } from './collectionIdentity';
import { parseVeEvidencePage, rankVeEvidenceLinks, selectVeEvidenceText, type VeEvidencePage } from './relevancePage';
import { searchVeRelevanceWebsites, veSearchProviderFailure, VeSearchProviderError, VE_RELEVANCE_SEARCH_OPERATION_TIMEOUT_MS, type VeSearchProviderFailure } from './relevanceSearch';

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
  companyName?: string;
  companyAddress?: string;
  focus?: string;
  /** Trusted offline adapters; never selected from user/source data. */
  fetchText?: (url: string) => Promise<string>;
  fetchPage?: (url: string, signal: AbortSignal) => Promise<VeEvidencePage>;
  search?: (query: string, signal: AbortSignal) => Promise<SerperOrganicItem[]>;
}

// Includes the shared search queue, one bounded search and website reads.
const TOTAL_TIMEOUT_MS = 120_000;
const PAGE_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_TEXT_CHARS = 6_000;
const MAX_PAGE_READS = 10;
const MAX_PAGE_RETRIES = 2;
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

export function veOfficialWebsiteCandidates(raw: string): URL[] {
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
const DIRECTORY_HOST = /(?:^|\.)(?:rusprofile\.ru|list-org\.com|saby\.ru|sbis\.ru|spark-interfax\.ru|companium\.ru|checko\.ru|zachestnyibiznes\.ru|egrul\.nalog\.ru|2gis\.ru|yandex\.ru|google\.com|vk\.com|ok\.ru|hh\.ru|headhunter\.ru|superjob\.ru|rabota\.ru|t\.me|instagram\.com|facebook\.com|prodoctorov\.ru|zoon\.ru|companies\.rbc\.ru|check\.tochka\.com|e-ecolog\.ru|xfirm\.ru|tbank\.ru|ruspeach\.com)$/i;

/** No-INN discovery needs the complete brand in the site's own title AND a
 * geographic clue from the original source. Search snippets cannot verify it. */
function discoveredNameMatches(pages: VeEvidencePage[], name: string, address: string): boolean {
  const brand = normalizeVeCompanyName(name);
  const distinctive = brand.split(' ').filter((word) => word.length >= 4
    && !/^(агентство|недвижимости|компания|группа|компаний|центр|риэлтор|риелтор|сервис|услуги)$/.test(word));
  const geo = address.toLowerCase().match(/[\p{L}]{4,}/gu)?.filter((word) =>
    !/^(россия|область|район|город|улица|проспект|республика|край|russia|region)$/.test(word)) ?? [];
  const titles = pages.map((page) => ` ${normalizeVeCompanyName(page.title)} `).join(' ');
  const text = normalizeVeCompanyName(pages.map((page) => page.text).join(' '));
  return distinctive.length > 0 && geo.length > 0 && titles.includes(` ${brand} `)
    && geo.some((word) => (` ${text} `).includes(` ${word} `));
}
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

function transientPageFailure(error: unknown): boolean {
  return error instanceof VeOperationTimeoutError || error instanceof Error
    && /website_transient_http_(?:408|500|502|503|504)|\b(?:EAI_AGAIN|ETIMEOUT|ETIMEDOUT|ESERVFAIL|ECONNRESET|ECONNREFUSED|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)\b|fetch failed|network error/i.test(error.message);
}

/** Website DNS must not occupy the OS lookup pool used by database/provider
 * connections. A per-read resolver is cancellable when the page deadline ends;
 * timed-out sites cannot leave background lookups blocking unrelated work.
 * Only these checked IPv4 answers may be used by the pinned HTTP connection.
 */
export async function resolveVeEvidenceAddress(hostname: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const resolver = new Resolver({ timeout: 1_500, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const addresses = await resolver.resolve4(hostname);
    signal.throwIfAborted();
    if (!addresses.length || addresses.some((address) => !publicIpv4(address))) {
      throw new Error('website_address_unavailable');
    }
    return addresses[0];
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    resolver.cancel();
  }
}

/** Narrow static-page reader. The shared website parser follows unchecked
 * redirects and crawls extra pages, so it is deliberately not used here.
 * Each hop validates its URL and DNS answers, then connects to a pinned public
 * IPv4 address; neither DNS rebinding nor a redirect can reach a private host.
 */
async function fetchEvidencePage(initialUrl: URL, signal: AbortSignal, focus?: string): Promise<VeEvidencePage> {
  let current = initialUrl;
  for (let hop = 0; hop <= 3; hop += 1) {
    const checked = allowedUrl(current.href);
    if (!checked) throw new Error('website_address_unavailable');
    const pinned = await resolveVeEvidenceAddress(checked.hostname, signal);
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
        if ([408, 500, 502, 503, 504].includes(response.status)) throw new Error(`website_transient_http_${response.status}`);
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

/** Bounded official-site evidence: 10 pages + at most 2 transient retries,
 * one search, 120 seconds including queue/metering. Each URL can be retried at most once.
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
  const supplied = veOfficialWebsiteCandidates(website);
  const nameSearch = Boolean(opts.companyName?.trim() && opts.companyAddress?.trim());
  if (!supplied.length && !inn && !nameSearch) return { status: 'unavailable', text: '', url: '', reason: 'missing_or_unsafe_website' };
  const pages = new Map<string, Promise<VeEvidencePage | undefined>>();
  let failed = false, timedOut = false, unverified = false, searchAttempted = false, searchCompleted = false;
  let retries = 0;
  let providerError: VeSearchProviderFailure | undefined;
  const verified = new Map<string, VeEvidencePage[]>();
  const read = async (url: URL, parent: AbortSignal): Promise<VeEvidencePage | undefined> => {
    parent.throwIfAborted();
    if (pages.has(url.href)) return pages.get(url.href);
    if (pages.size >= MAX_PAGE_READS) return undefined;
    const task = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          return await withVeDeadline('relevance evidence page', PAGE_TIMEOUT_MS, parent, async (signal) => {
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
          });
        } catch (error) {
          parent.throwIfAborted();
          failed = true;
          timedOut ||= error instanceof VeOperationTimeoutError;
          if (attempt > 0 || retries >= MAX_PAGE_RETRIES || !transientPageFailure(error)) return undefined;
          retries += 1;
        }
      }
      return undefined;
    })();
    pages.set(url.href, task);
    return task;
  };
  const inspect = async (start: URL, initial: VeEvidencePage | undefined, signal: AbortSignal, discovered = false): Promise<VeEvidencePage[]> => {
    const sitePages: VeEvidencePage[] = initial ? [initial] : [];
    const identity = () => {
      const seen = new Set(sitePages.flatMap((page) => page.inns));
      const owners = new Set(sitePages.flatMap((page) => page.ownerInns ?? []));
      return !inn ? (!discovered || discoveredNameMatches(sitePages, opts.companyName ?? '', opts.companyAddress ?? '') ? 'supplied' : 'unknown') : [...seen].some((value) => value !== inn) ? 'conflict'
        : owners.size === 1 && owners.has(inn) ? 'verified' : 'unknown';
    };
    if ((inn || discovered) && identity() === 'unknown') {
      const base = new URL(initial?.url ?? start.href);
      // Re-rank newly discovered legal/about links after each page, so a hub
      // can lead to requisites without crawling unrelated navigation.
      for (let attempt = 0; attempt < 3 && pages.size < MAX_PAGE_READS; attempt++) {
        const legal = rankVeEvidenceLinks(sitePages.flatMap(sameOriginLinks), opts.focus, 'identity');
        const next = [...legal, { url: new URL('/contacts', base).href, text: 'Contacts' }]
          .find((link) => !pages.has(link.url));
        const url = next ? allowedUrl(next.url) : null;
        if (!url) break;
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
    const fallback = new URL(/\.(?:ru|xn--p1ai)$/i.test(new URL(home.url).hostname) ? '/uslugi' : '/services', home.url).href;
    const visited: VeEvidencePage['links'] = [];
    for (let attempt = 0; attempt < 4 && pages.size < MAX_PAGE_READS; attempt++) {
      const ranked = rankVeEvidenceLinks(sitePages.flatMap(sameOriginLinks), opts.focus, 'activity', visited);
      const next = [...ranked, { url: fallback, text: 'Services' }].find((link) => !pages.has(link.url));
      if (!next) break;
      const url = allowedUrl(next.url);
      if (!url || url.origin !== new URL(home.url).origin) continue;
      visited.push(next);
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
      if (verified.size || (!inn && !nameSearch) || pages.size >= MAX_PAGE_READS) return;
      signal.throwIfAborted();
      searchAttempted = true;
      const query = (inn ? '"' + inn + '"' : '"' + String(opts.companyName).replace(/["\r\n]/g, ' ').slice(0, 160) + '" ' + String(opts.companyAddress).slice(0, 100))
        + ' официальный сайт -site:rusprofile.ru -site:list-org.com -site:checko.ru -site:companium.ru -site:hh.ru';
      let results: SerperOrganicItem[];
      try {
        results = await withVeDeadline('relevance website search', VE_RELEVANCE_SEARCH_OPERATION_TIMEOUT_MS, signal, async (searchSignal) =>
          opts.search ? opts.search(query, searchSignal) : searchVeRelevanceWebsites(query, searchSignal));
      } catch (error) {
        if (error instanceof ProviderUsageWriteError) throw error;
        signal.throwIfAborted();
        providerError = veSearchProviderFailure(error);
        return;
      }
      searchCompleted = true;
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
        await inspect(url, await read(url, signal), signal, true);
        if (verified.size) return;
      }
    });
  } catch (error) {
    if (error instanceof ProviderUsageWriteError) throw error;
    opts.signal?.throwIfAborted();
    failed = true;
    timedOut ||= error instanceof VeOperationTimeoutError;
    if (searchAttempted && !searchCompleted && !providerError) {
      providerError = veSearchProviderFailure(new VeSearchProviderError('transient', timedOut ? 'timeout' : 'transport'));
    }
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
