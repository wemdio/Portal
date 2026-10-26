import { sliceWholeChars, stripUnstorableJsonChars } from '../jsonbSafe';
import { validLei } from './engRegistryIdentity';

/**
 * One bounded request for a public registry file or list (PRA CSV, ESMA and
 * EBA registers). Same rules as the JSON registry pages: a fixed URL chosen by
 * our code, no redirects, size and time limits, and the registry_* error codes
 * the collection treats as transient (timeout, network, 408/429/5xx) or final.
 * A body (the EBA register's search) makes it a POST.
 */
export async function readHeEngRegistryText(url: string, options: {
  signal?: AbortSignal; fetch?: typeof fetch; accept: string; maxBytes: number; timeoutMs: number;
  body?: string; contentType?: string;
}): Promise<string> {
  const fail = (code: string): never => { throw new Error(code); };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (options.signal?.aborted) fail('registry_aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await (options.fetch ?? fetch)(url, { method: options.body === undefined ? 'GET' : 'POST', redirect: 'error',
      signal: controller.signal, ...(options.body === undefined ? {} : { body: options.body }),
      headers: { Accept: options.accept, 'User-Agent': 'Portal ENG public-company-discovery/1.0 (+https://app.outreachos.xyz)',
        ...(options.contentType ? { 'Content-Type': options.contentType } : {}) } });
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

/**
 * The same number for a register that carries no LEI (EBA): GLEIF's record of
 * the entity with exactly this legal name, ignoring case, in this country. A
 * name with a comma is not asked (GLEIF reads a comma as «or»); two records of
 * the name, an inactive entity or no number give ''. A failed read throws.
 */
export async function readHeEngGleifRegisteredAsByName(name: string, iso2: string, options: {
  signal?: AbortSignal; fetch?: typeof fetch; maxBytes: number; timeoutMs: number;
}): Promise<string> {
  const text = (raw: unknown, max = 60) => typeof raw === 'string'
    ? sliceWholeChars(stripUnstorableJsonChars(raw).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim(), 0, max) : '';
  const key = (raw: unknown) => text(raw, 500).normalize('NFKC').toLowerCase();
  if (!name || name.includes(',') || !/^[a-z]{2}$/i.test(iso2)) return '';
  const url = new URL(GLEIF);
  url.searchParams.set('filter[entity.legalName]', name);
  url.searchParams.set('filter[entity.legalAddress.country]', iso2.toUpperCase());
  url.searchParams.set('page[size]', '5');
  let body: { data?: unknown } | null = null;
  try { body = JSON.parse(await readHeEngRegistryText(url.href, { ...options, accept: 'application/vnd.api+json' })) as { data?: unknown }; }
  catch (error) { if (error instanceof SyntaxError) throw new Error('registry_invalid_response'); throw error; }
  if (!Array.isArray(body?.data)) throw new Error('registry_invalid_response');
  const same = (body.data as unknown[]).map(raw => (raw as { attributes?: { lei?: unknown; entity?: {
    legalName?: { name?: unknown }; registeredAs?: unknown; status?: unknown } } } | null)?.attributes)
    .filter(attributes => key(attributes?.entity?.legalName?.name) === key(name));
  const entity = same.length === 1 && validLei(text(same[0]?.lei).toUpperCase()) ? same[0]?.entity : undefined;
  const number = entity?.status === 'ACTIVE' ? text(entity.registeredAs) : '';
  return number.toUpperCase() === text(same[0]?.lei).toUpperCase() ? '' : number;
}
