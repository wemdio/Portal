import { createUsWebsiteFetchGuard } from './publicAddress';
import { sameCompanySiteBoundary } from './companySiteAlias';
import { isEngFallbackCandidate, isEngHtmlBlocked, isEngHtmlImprovement } from './engPageFallbackPolicy';

export type EngFallbackPage = { url: string; html: string; source: 'browser' | 'tinyfish' };
type BrowserRead = { kind: 'page'; page: EngFallbackPage } | { kind: 'disabled' | 'unavailable' | 'blocked' | 'refused' };
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20_000;

async function checkedUrl(raw: string, signal: AbortSignal): Promise<boolean> {
  const guard = createUsWebsiteFetchGuard({ maxRedirects: 0 });
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      guard.checkUrl(new URL(raw)),
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      }),
    ]);
    return true;
  } catch { signal.throwIfAborted(); return false; }
  finally {
    if (abort) signal.removeEventListener('abort', abort);
  }
}

/** The endpoint is operator configuration, never a URL supplied by a company. */
async function browserRead(url: string, signal: AbortSignal, locale: 'en' | 'ru'): Promise<BrowserRead> {
  const endpoint = process.env.ENG_BROWSER_URL?.trim();
  const token = process.env.ENG_BROWSER_TOKEN?.trim();
  if (process.env[locale === 'ru' ? 'RU_BROWSER_ENABLED' : 'ENG_BROWSER_ENABLED'] !== '1' || !endpoint || !token) return { kind: 'disabled' };
  try {
    const base = new URL(endpoint);
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return { kind: 'refused' };
    const response = await fetch(new URL('/render', base), {
      method: 'POST', redirect: 'error', signal,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ url, timeoutMs: 12_000, ...(locale === 'ru' ? { locale } : {}) }),
    });
    const reader = response.body?.getReader();
    if (!reader) return { kind: 'refused' };
    const parts: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      // JSON escaping can expand the bounded HTML several times.
      if (size > MAX_BYTES * 6 + 4096) { await reader.cancel(); return { kind: 'refused' }; }
      parts.push(value);
    }
    const data: unknown = JSON.parse(Buffer.concat(parts).toString('utf8'));
    if (!data || typeof data !== 'object') return { kind: 'refused' };
    const body = data as Record<string, unknown>;
    // An older broker must not silently ignore the RU locale, including when
    // reporting busy: that would incorrectly admit an external RU rescue.
    if (locale === 'ru' && body.locale !== 'ru') return { kind: 'refused' };
    if (!response.ok) {
      if (body.error === 'blocked') return { kind: 'blocked' };
      // Only confirmed admission failures or an observed upstream 5xx can escalate.
      // A timeout/transport loss can hide an access refusal still in flight.
      return ['busy', 'not_ready', 'upstream_unavailable'].includes(String(body.error))
        ? { kind: 'unavailable' } : { kind: 'refused' };
    }
    if (typeof body.url !== 'string' || typeof body.html !== 'string' || Buffer.byteLength(body.html) > MAX_BYTES) return { kind: 'refused' };
    if (isEngHtmlBlocked(body.html)) return { kind: 'blocked' };
    return { kind: 'page', page: { url: body.url, html: body.html, source: 'browser' } };
  } catch {
    signal.throwIfAborted();
    // A lost reply may have contained a terminal refusal. Do not escalate an unknown outcome.
    return { kind: 'refused' };
  }
}

/** Called only for a successful empty direct response, never on a blocked or unknown result. */
export async function fetchEngPageFallback(input: {
  url: string; companyUrl: string; html: string | null; status?: number; signal?: AbortSignal;
  locale?: 'en' | 'ru'; ruDeficit?: boolean;
}): Promise<EngFallbackPage | null> {
  const locale = input.locale === 'ru' ? 'ru' : 'en';
  if (process.env[locale === 'ru' ? 'RU_BROWSER_ENABLED' : 'ENG_BROWSER_ENABLED'] !== '1' || !isEngFallbackCandidate(input)) return null;
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let rendered: EngFallbackPage | null = null;
  try {
    // The original caller URL is independent of the observed HTTP redirect.
    // A foreign empty destination must not become its own company boundary.
    if (!input.url.startsWith('https:') || !sameCompanySiteBoundary(input.url, input.companyUrl)
      || !await checkedUrl(input.url, signal)) return null;
    const browser = await browserRead(input.url, signal, locale);
    if (browser.kind === 'disabled' || browser.kind === 'blocked' || browser.kind === 'refused') return null;
    const allowed = async (page: EngFallbackPage) => page.url.startsWith('https:')
      && sameCompanySiteBoundary(page.url, input.companyUrl) && await checkedUrl(page.url, signal);
    if (browser.kind === 'page') {
      if (!await allowed(browser.page)) return null;
      if (isEngHtmlImprovement(input.html!, browser.page.html)) rendered = browser.page;
      if (rendered && !isEngFallbackCandidate({ status: 200, html: rendered.html })) return rendered;
    }
    if (locale === 'ru' && input.ruDeficit !== true) return rendered;
    signal.throwIfAborted();
    const { fetchEngTinyfishFallback } = await import('./engTinyfishFallback');
    const tinyfish = await fetchEngTinyfishFallback({ url: input.url, companyUrl: input.companyUrl,
      directOutcome: 'empty_success', browserOutcome: browser.kind === 'page' ? 'empty_success' : 'unavailable',
      ...(locale === 'ru' ? { locale, ruDeficit: true } : {}), signal });
    return tinyfish && await allowed(tinyfish) && !isEngHtmlBlocked(tinyfish.html)
      && isEngHtmlImprovement(rendered?.html ?? input.html!, tinyfish.html) ? tinyfish
      : rendered;
  } catch {
    // Fallback has a separate budget; its expiry does not erase the direct response.
    input.signal?.throwIfAborted();
    return rendered;
  }
}
