import 'server-only';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sameCompanySiteBoundary } from './companySiteAlias';
import { createUsWebsiteFetchGuard, isPublicIpAddress } from './publicAddress';
import { reserveEngTinyfishUrl } from './engTinyfishBudget';
import { isEngHtmlBlocked } from './engPageFallbackPolicy';
import { parseEngTinyfishAccounts, parseRuTinyfishAccounts } from './engTinyfishAccounts';

const ENDPOINT = 'https://api.fetch.tinyfish.ai';
const WALLET_ENDPOINT = 'https://agent.tinyfish.ai/v1/wallet';
const USAGE_ENDPOINT = 'https://api.fetch.tinyfish.ai/usage';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_METADATA_BYTES = 128 * 1024;
const MAX_HTML_CHARS = 500_000;
const TIMEOUT_MS = 15_000;
const METADATA_TIMEOUT_MS = 4_000;
const DAILY_REMOTE_LIMIT = 1000;
const CHALLENGE = /(?:captcha|access denied|checking your browser|verify (?:that )?you are human|just a moment|security challenge|cloudflare ray id|automated (?:access|requests)|bot detection|login required)/i;

export interface EngTinyfishFallbackInput {
  url: string;
  companyUrl: string;
  /** Only successful HTML with no content; 403/429, challenge and ambiguity are ineligible. */
  directOutcome: 'empty_success';
  /** An actual browser attempt; blocked and refused outcomes are ineligible. */
  browserOutcome: 'empty_success' | 'unavailable';
  /** RU is an explicit, separately metered deficit recovery, never the default. */
  locale?: 'en' | 'ru';
  ruDeficit?: boolean;
  signal?: AbortSignal;
}
export interface EngTinyfishFallbackResult {
  url: string;
  html: string;
  /** Provider-extracted DOM, scripts and styles stripped; not native response bytes. */
  source: 'tinyfish';
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

async function readBounded(response: Response, signal: AbortSignal, maxBytes = MAX_RESPONSE_BYTES): Promise<string | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
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
      if (total > maxBytes) return null;
      chunks.push(value);
    }
    const data = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder().decode(data);
  } finally { void reader.cancel().catch(() => {}); }
}

/** Read-only checks. Provider usage may lag and may not include all other
 * clients of an organisation; the shared local reservation remains mandatory. */
type FreePreflight = { kind: 'ready'; day: string } | { kind: 'daily_exhausted' | 'unavailable' };

async function freePreflight(key: string, signal: AbortSignal): Promise<FreePreflight> {
  const unavailable: FreePreflight = { kind: 'unavailable' };
  const day = new Date().toISOString().slice(0, 10);
  const usageUrl = new URL(USAGE_ENDPOINT);
  usageUrl.searchParams.set('start_after', `${day}T00:00:00Z`);
  usageUrl.searchParams.set('limit', '1');
  const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(METADATA_TIMEOUT_MS)]);
  const read = async (url: string): Promise<unknown> => {
    const response = await withAbort(fetch(url, { headers: { 'X-API-Key': key }, redirect: 'error', signal: boundedSignal }), boundedSignal);
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return null; }
    const body = await readBounded(response, boundedSignal, MAX_METADATA_BYTES);
    return body ? JSON.parse(body) as unknown : null;
  };
  try {
    const [wallet, usage] = await Promise.all([read(WALLET_ENDPOINT), read(usageUrl.href)]);
    signal.throwIfAborted();
    if (!wallet || typeof wallet !== 'object' || !usage || typeof usage !== 'object') return unavailable;
    const rates = (wallet as { rates?: unknown }).rates;
    if (!rates || typeof rates !== 'object') return unavailable;
    const { meters, as_of: asOf } = rates as { meters?: unknown; as_of?: unknown };
    if (!Array.isArray(meters) || typeof asOf !== 'string') return unavailable;
    const timestamp = Date.parse(asOf);
    const ageMs = Date.now() - timestamp;
    if (!Number.isFinite(timestamp) || ageMs > 300_000 || ageMs < -60_000) return unavailable;
    const fetchMeters = meters.filter((meter: unknown) => meter && typeof meter === 'object' && (meter as { label?: unknown }).label === 'TinyFish Fetch');
    if (fetchMeters.length !== 1) return unavailable;
    const meter = fetchMeters[0] as { currency?: unknown; per?: unknown; unit_amount?: unknown };
    if (meter.currency !== 'USD' || meter.per !== 'url' || typeof meter.unit_amount !== 'string' || !/^0(?:\.0{1,6})?$/.test(meter.unit_amount)) return unavailable;
    const total = (usage as { total?: unknown }).total;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0
      || new Date().toISOString().slice(0, 10) !== day) return unavailable;
    return total >= DAILY_REMOTE_LIMIT ? { kind: 'daily_exhausted' } : { kind: 'ready', day };
  } catch { signal.throwIfAborted(); return unavailable; }
}

/** Advance through an approved account pool only on confirmed daily exhaustion.
 * Never retry a Fetch on another key after a block, error or uncertain outcome. */
export async function fetchEngTinyfishFallback(input: EngTinyfishFallbackInput): Promise<EngTinyfishFallbackResult | null> {
  input.signal?.throwIfAborted();
  if (input.directOutcome !== 'empty_success' || !['empty_success', 'unavailable'].includes(input.browserOutcome)) return null;
  const ru = input.locale === 'ru';
  if (ru && input.ruDeficit !== true) return null;
  const accounts = ru ? parseRuTinyfishAccounts(process.env) : parseEngTinyfishAccounts(process.env);
  if (!accounts) return null;
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
    for (const settings of accounts) {
      const preflight = await freePreflight(settings.key, controller.signal);
      if (preflight.kind === 'daily_exhausted') continue;
      if (preflight.kind !== 'ready') return null;
      const reservation = await reserveEngTinyfishUrl(settings.accountId, controller.signal);
      if (reservation === 'daily_exhausted') continue;
      if (reservation !== 'granted') return null;
      if (new Date().toISOString().slice(0, 10) !== preflight.day) return null;
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
    }
    return null;
  } catch { input.signal?.throwIfAborted(); return null; }
  finally { clearTimeout(timer); input.signal?.removeEventListener('abort', abort); }
}
