import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sameCompanySiteBoundary } from './companySiteAlias';
import { createUsWebsiteFetchGuard, isPublicIpAddress } from './publicAddress';
import { reserveEngTinyfishUrl } from './engTinyfishBudget';
import { isEngHtmlBlocked } from './engPageFallbackPolicy';

const ENDPOINT = 'https://api.fetch.tinyfish.ai';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_HTML_CHARS = 500_000;
const TIMEOUT_MS = 15_000;
const CHALLENGE = /(?:captcha|access denied|checking your browser|verify (?:that )?you are human|just a moment|security challenge|cloudflare ray id|automated (?:access|requests)|bot detection|login required)/i;

export interface EngTinyfishFallbackInput {
  url: string;
  companyUrl: string;
  /** Only successful HTML with no content; 403/429, challenge and ambiguity are ineligible. */
  directOutcome: 'empty_success';
  /** An actual browser attempt; blocked and refused outcomes are ineligible. */
  browserOutcome: 'empty_success' | 'unavailable';
  signal?: AbortSignal;
}
export interface EngTinyfishFallbackResult {
  url: string;
  html: string;
  /** Provider-extracted DOM, scripts and styles stripped; not native response bytes. */
  source: 'tinyfish';
}

/** These attestations must reflect provider/account guarantees. Flags do not
 * themselves guarantee no proxy/antibot bypass or free pricing. */
function config(): { key: string; accountId: string } | null {
  if (process.env.ENG_TINYFISH_ENABLED !== '1' ||
      process.env.ENG_TINYFISH_DEDICATED_ACCOUNT_ATTESTED !== '1' ||
      process.env.ENG_TINYFISH_NO_ANTIBOT_ATTESTED !== '1' ||
      process.env.ENG_TINYFISH_NO_PAID_USAGE_ATTESTED !== '1') return null;
  const key = process.env.TINYFISH_API_KEY?.trim() ?? '';
  const accountId = process.env.ENG_TINYFISH_ACCOUNT_ID?.trim() ?? '';
  return key && /^[a-zA-Z0-9._-]{1,80}$/.test(accountId) ? { key, accountId } : null;
}

function urlOf(raw: string): URL | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port !== '' && url.port !== '443')) return null;
    return url;
  } catch { return null; }
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

/** Positive DNS resolution is necessary here: the general guard tolerates DNS
 * failure because it normally also guards the socket. The provider resolves on
 * its own side; its documented private-URL restriction is a separate layer. */
async function publicUrl(url: URL, signal: AbortSignal): Promise<boolean> {
  try {
    signal.throwIfAborted();
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host)) {
      if (!isPublicIpAddress(host)) return false;
    } else {
      const addresses = await withAbort(lookup(host, { all: true, verbatim: true }), signal);
      if (!addresses.length || addresses.some(({ address }) => !isPublicIpAddress(address))) return false;
    }
    await withAbort(createUsWebsiteFetchGuard().checkUrl(url), signal);
    signal.throwIfAborted();
    return true;
  } catch { signal.throwIfAborted(); return false; }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await withAbort(reader.read(), signal);
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) return null;
      chunks.push(value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(data);
  } finally { void reader.cancel().catch(() => {}); }
}

/** Caller must retain the real typed outcome of both prior attempts. No retry
 * on blocks, uncertain results, failure, limit exhaustion or provider errors. */
export async function fetchEngTinyfishFallback(input: EngTinyfishFallbackInput): Promise<EngTinyfishFallbackResult | null> {
  input.signal?.throwIfAborted();
  if (input.directOutcome !== 'empty_success' || !['empty_success', 'unavailable'].includes(input.browserOutcome)) return null;
  const settings = config();
  if (!settings) return null;
  const requested = urlOf(input.url);
  const company = urlOf(input.companyUrl);
  if (!requested || !company || !sameCompanySiteBoundary(requested.href, company.href)) return null;
  const controller = new AbortController();
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    input.signal?.throwIfAborted();
    if (!await publicUrl(requested, controller.signal)) return null;
    if (!await reserveEngTinyfishUrl(settings.accountId, controller.signal)) return null;
    const response = await fetch(ENDPOINT, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': settings.key },
      body: JSON.stringify({ urls: [requested.href], format: 'html', include_selectors: ['body'], ttl: 0, per_url_timeout_ms: 10_000 }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    const body = await readBounded(response, controller.signal);
    if (!body) return null;
    const data = JSON.parse(body) as { results?: Array<{ url?: unknown; final_url?: unknown; format?: unknown; text?: unknown }>; errors?: unknown[] };
    if (!Array.isArray(data.results) || data.results.length !== 1 || !Array.isArray(data.errors) || data.errors.length) return null;
    const result = data.results[0];
    if (result.url !== requested.href || result.format !== 'html' || typeof result.final_url !== 'string' ||
        typeof result.text !== 'string' || !result.text.trim() || result.text.length > MAX_HTML_CHARS ||
        CHALLENGE.test(result.text) || isEngHtmlBlocked(result.text)) return null;
    const finalUrl = urlOf(result.final_url);
    if (!finalUrl || !sameCompanySiteBoundary(finalUrl.href, company.href) || !await publicUrl(finalUrl, controller.signal)) return null;
    input.signal?.throwIfAborted();
    return { url: finalUrl.href, html: result.text, source: 'tinyfish' };
  } catch { input.signal?.throwIfAborted(); return null; }
  finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
}
