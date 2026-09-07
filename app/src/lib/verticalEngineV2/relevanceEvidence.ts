import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { loadBuffer } from 'cheerio';
import { Agent, fetch } from 'undici';
import { assertPublicWebsite } from '@/lib/clientDemo/personalize';
import { VeOperationTimeoutError, withVeDeadline } from './operationDeadline';

export interface VeRelevanceEvidence {
  status: 'ok' | 'unavailable' | 'error';
  text: string;
  url: string;
  reason: string;
}

interface EvidencePage { text: string; url: string; servicesUrl?: string }

const TOTAL_TIMEOUT_MS = 15_000;
const PAGE_TIMEOUT_MS = 7_000;
const MAX_BODY_BYTES = 1_048_576;
const MAX_TEXT_CHARS = 6_000;

function allowedUrl(value: string): URL | null {
  try {
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

function firstWebsite(raw: string): URL | null {
  // A multi-value cell may contain emails, labels and several websites. Never
  // extract the domain from an email or repair a URL containing credentials.
  for (const token of raw.trim().split(/[\s,;|]+/).slice(0, 20)) {
    const candidate = token.replace(/^["'(<]+|["')>.]+$/g, '');
    if (!candidate || candidate.includes('@')) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(candidate) && !/^https?:\/\//i.test(candidate)) continue;
    const parsed = allowedUrl(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (parsed) return new URL('/', parsed);
  }
  return null;
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

function usefulText(raw: string): string {
  const text = raw.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\s+/g, ' ').trim();
  if (text.length < 60 || (text.match(/\p{L}/gu)?.length ?? 0) < 30) return '';
  if (/Страница доступна, но требует JavaScript или блокирует парсер/i.test(text)) return '';
  if (text.length < 1_200 && /access denied|just a moment|checking your browser|verify you are human|проверка браузера|подтвердите, что вы человек|доступ запрещ[её]н|сайт (?:временно )?недоступен|сайт на реконструкции|страница не найдена|404 not found/i.test(text.slice(0, 400))) return '';
  return text;
}

/** Narrow static-page reader. The shared website parser follows unchecked
 * redirects and crawls extra pages, so it is deliberately not used here.
 * Each hop passes the existing SSRF gate, then connects to a pinned public
 * IPv4 address; neither DNS rebinding nor a redirect can reach a private host.
 */
async function fetchEvidencePage(initialUrl: URL, signal: AbortSignal): Promise<EvidencePage> {
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
      const $ = loadBuffer(Buffer.concat(chunks), {
        encoding: { transportLayerEncodingLabel: contentType.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] },
      });
      let servicesUrl: string | undefined;
      $('a[href]').each((_index, element) => {
        if (servicesUrl) return;
        try {
          const target = allowedUrl(new URL($(element).attr('href') ?? '', current).href);
          if (target?.origin === current.origin && /^\/(?:services|uslugi)\/?$/i.test(target.pathname)) {
            target.search = '';
            servicesUrl = target.href;
          }
        } catch { /* Ignore malformed links; never discover off-site pages. */ }
      });
      const description = $('meta[name="description"], meta[property="og:description"]').map((_i, el) => $(el).attr('content') ?? '').get().join(' ');
      const title = $('title').text();
      $('script, style, noscript, svg, iframe, form').remove();
      $('br, p, div, li, h1, h2, h3, h4, section').append(' ');
      return { text: usefulText(`${title} ${description} ${$('body').text()}`).slice(0, MAX_TEXT_CHARS), url: current.href, servicesUrl };
    } finally {
      // Destroy also aborts late/incomplete bodies; do not keep per-site sockets.
      await dispatcher.destroy();
    }
  }
  throw new Error('website_redirect_unavailable');
}

/** Evidence is supplementary: unavailable/error means "needs review", never
 * "irrelevant". This is not a complete site audit; it reads at most the home
 * page and one same-origin services page, with no search or paid provider.
 */
export async function fetchVeRelevanceEvidence(
  website: string,
  opts: { signal?: AbortSignal; fetchText?: (url: string) => Promise<string> } = {},
): Promise<VeRelevanceEvidence> {
  opts.signal?.throwIfAborted();
  const selected = firstWebsite(website);
  if (!selected) return { status: 'unavailable', text: '', url: '', reason: 'missing_or_unsafe_website' };
  const parts: string[] = [];
  let failed = false;
  let timedOut = false;
  let evidenceUrl = selected.href;
  const read = (url: URL, parent: AbortSignal) => withVeDeadline('relevance evidence page', PAGE_TIMEOUT_MS, parent, async (signal) => {
    if (!opts.fetchText) return fetchEvidencePage(url, signal);
    // Trusted dependency injection for offline checks; URL/credential checks
    // still run, but no DNS/network operation is introduced by this branch.
    const text = usefulText(await opts.fetchText(url.href));
    signal.throwIfAborted();
    return { text, url: url.href } satisfies EvidencePage;
  });
  try {
    await withVeDeadline('relevance website evidence', TOTAL_TIMEOUT_MS, opts.signal, async (signal) => {
      let homepage: EvidencePage | undefined;
      try {
        homepage = await read(selected, signal);
        evidenceUrl = homepage.url;
        if (homepage.text) parts.push(`URL: ${homepage.url}\n${homepage.text.slice(0, 2_900)}`);
      } catch (error) {
        signal.throwIfAborted();
        failed = true;
        timedOut ||= error instanceof VeOperationTimeoutError;
      }
      signal.throwIfAborted();
      const origin = new URL(homepage?.url ?? selected.href);
      const services = new URL(homepage?.servicesUrl ?? (/\.(?:ru|xn--p1ai)$/i.test(origin.hostname) ? '/uslugi' : '/services'), origin);
      // A redirect into /services already supplied that page's evidence.
      if (services.href === homepage?.url) return;
      try {
        const page = await read(services, signal);
        if (page.text && page.text !== homepage?.text) parts.push(`URL: ${page.url}\n${page.text.slice(0, 2_900)}`);
      } catch (error) {
        signal.throwIfAborted();
        failed = true;
        timedOut ||= error instanceof VeOperationTimeoutError;
      }
    });
  } catch (error) {
    opts.signal?.throwIfAborted();
    failed = true;
    timedOut ||= error instanceof VeOperationTimeoutError;
  }
  opts.signal?.throwIfAborted();
  const text = parts.join('\n\n').slice(0, MAX_TEXT_CHARS);
  return {
    status: text ? 'ok' : failed ? 'error' : 'unavailable',
    text, url: evidenceUrl,
    reason: text ? (parts.length > 1 ? 'homepage_and_services' : 'partial_website_evidence')
      : timedOut ? 'website_evidence_timeout' : failed ? 'website_evidence_failed' : 'no_usable_website_text',
  };
}
