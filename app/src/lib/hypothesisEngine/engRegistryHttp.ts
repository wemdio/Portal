import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { validLei } from './engRegistryIdentity';

/**
 * One bounded GET of a public registry file or list (PRA CSV, ESMA register).
 * Same rules as the JSON registry pages: a fixed URL chosen by our code, no
 * redirects, size and time limits, and the registry_* error codes the
 * collection treats as transient (timeout, network, 408/429/5xx) or final.
 */
export async function readHeEngRegistryText(url: string, options: {
  signal?: AbortSignal; fetch?: typeof fetch; accept: string; maxBytes: number; timeoutMs: number;
}): Promise<string> {
  const fail = (code: string): never => { throw new Error(code); };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) fail('registry_aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(url, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: options.accept, 'User-Agent': 'Portal ENG public-company-discovery/1.0 (+https://app.outreachos.xyz)' } });
    if (!response.ok) fail(`registry_http_${response.status}`);
    if (!response.body) fail('registry_invalid_response');
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > options.maxBytes) { await reader.cancel(); fail('registry_response_too_large'); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return Buffer.concat(chunks).toString('utf8');
  } catch (error) {
    if (options.signal?.aborted) return fail('registry_aborted');
    if (controller.signal.aborted) return fail('registry_timeout');
    if (error instanceof Error && /^registry_[a-z0-9_]+$/.test(error.message)) throw error;
    return fail('registry_network_error');
  } finally { clearTimeout(timer); options.signal?.removeEventListener('abort', onAbort); }
}

// Free, keyless LEI register API; 100 LEIs fit one filter well inside URL limits.
const GLEIF = 'https://api.gleif.org/api/v1/lei-records';
const GLEIF_BATCH = 100;

/**
 * The local register number of each LEI from GLEIF («HRB 13814», «B 28679»,
 * a Companies House number): a firm's own site rarely prints its LEI, but its
 * legal notice names the entity with this number. A failed read throws; the
 * callers then go on without numbers and do not cache that list, so the next
 * page asks again. A loaded page's candidates are frozen in the wave
 * checkpoint, so a later answer never changes a candidate being resolved.
 */
export async function readHeEngGleifRegisteredAs(leis: readonly string[], options: {
  signal?: AbortSignal; fetch?: typeof fetch; maxBytes: number; timeoutMs: number;
}): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  // Stored in jsonb and fingerprinted with the candidate: same cleaning as every registry field.
  const text = (raw: unknown) => typeof raw === 'string'
    ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, 60) : '';
  for (let start = 0; start < leis.length; start += GLEIF_BATCH) {
    const url = new URL(GLEIF);
    url.searchParams.set('filter[lei]', leis.slice(start, start + GLEIF_BATCH).join(','));
    url.searchParams.set('page[size]', String(GLEIF_BATCH));
    let body: { data?: unknown } | null = null;
    try { body = JSON.parse(await readHeEngRegistryText(url.href, { ...options, accept: 'application/vnd.api+json' })) as { data?: unknown }; }
    catch (error) { if (error instanceof SyntaxError) throw new Error('registry_invalid_response'); throw error; }
    if (!Array.isArray(body?.data)) throw new Error('registry_invalid_response');
    for (const raw of body.data as unknown[]) {
      const attributes = (raw as { attributes?: { lei?: unknown; entity?: { registeredAs?: unknown } } } | null)?.attributes;
      const lei = text(attributes?.lei).toUpperCase();
      const number = text(attributes?.entity?.registeredAs);
      if (validLei(lei) && number && number.toUpperCase() !== lei) found.set(lei, number);
    }
  }
  return found;
}
