import 'server-only';
import { isIP } from 'node:net';
import { isPublicIpAddress } from './publicAddress';
import { parseRuTinyfishAccounts } from './engTinyfishAccounts';
import { reserveRuTinyfishSearch } from './ruTinyfishSearchBudget';

export interface RuTinyfishSearchResult { title: string; link: string; snippet: string }
const ENDPOINT = 'https://api.search.tinyfish.ai';
const WALLET = 'https://agent.tinyfish.ai/v1/wallet';

async function readJson(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (!response.ok || !response.body) { void response.body?.cancel().catch(() => {}); return null; }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectOnAbort: (reason: unknown) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectOnAbort = reject; });
  const abort = () => {
    rejectOnAbort(signal.reason ?? new Error('Search cancelled'));
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const { value, done } = await Promise.race([reader.read(), aborted]);
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) return null;
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
  }
}

/** Search discovers candidate sources, never company identities or email
 * guesses. Callers must persist their scarcity receipt before invoking it and
 * verify the company on its own guarded website before canonical row import.
 * null is unavailable/uncertain; [] is a successful empty search. No retries,
 * account rotation, paid Search fallback, Agent or combined Search+Fetch. */
export async function searchRuTinyfish(input: {
  query: string; deficit: true; signal?: AbortSignal;
}): Promise<RuTinyfishSearchResult[] | null> {
  input.signal?.throwIfAborted();
  if (input.deficit !== true || process.env.RU_TINYFISH_SEARCH_ENABLED !== '1') return null;
  const accounts = parseRuTinyfishAccounts(process.env);
  if (!accounts || accounts.length !== 1) return null;
  const { key, accountId } = accounts[0];
  if (typeof input.query !== 'string') return null;
  const query = input.query.trim();
  if (!query || query.length > 2000 || /[\x00-\x1f\x7f]/.test(query)) return null;
  const signal = input.signal
    ? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
  const day = new Date().toISOString().slice(0, 10);
  const headers = { 'X-API-Key': key };
  const usageUrl = new URL('/usage', ENDPOINT);
  usageUrl.searchParams.set('start_after', `${day}T00:00:00Z`);
  usageUrl.searchParams.set('limit', '1');
  try {
    const metadataSignal = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    const read = async (url: string): Promise<unknown> => readJson(await fetch(url,
      { headers, redirect: 'error', signal: metadataSignal }), metadataSignal, 128 * 1024);
    const [wallet, usage] = await Promise.all([read(WALLET), read(usageUrl.href)]);
    if (!wallet || typeof wallet !== 'object' || !usage || typeof usage !== 'object') return null;
    const rates = (wallet as { rates?: { meters?: unknown; as_of?: unknown } }).rates;
    if (!rates || !Array.isArray(rates.meters) || typeof rates.as_of !== 'string') return null;
    const age = Date.now() - Date.parse(rates.as_of);
    if (!Number.isFinite(age) || age > 300_000 || age < -60_000) return null;
    const meters = rates.meters.filter((m: unknown) => m && typeof m === 'object'
      && (m as { label?: unknown }).label === 'TinyFish Search');
    if (meters.length !== 1) return null;
    const meter = meters[0] as { currency?: unknown; per?: unknown; unit_amount?: unknown };
    if (meter.currency !== 'USD' || meter.per !== 'query' || typeof meter.unit_amount !== 'string'
      || !/^0(?:\.0{1,6})?$/.test(meter.unit_amount)) return null;
    const total = (usage as { total?: unknown }).total;
    if (typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 || total >= 12_000
      || new Date().toISOString().slice(0, 10) !== day) return null;
    if (!await reserveRuTinyfishSearch(accountId, signal)) return null;
    if (new Date().toISOString().slice(0, 10) !== day) return null;
    const url = new URL(ENDPOINT);
    url.searchParams.set('query', query);
    url.searchParams.set('location', 'RU');
    url.searchParams.set('language', 'ru');
    url.searchParams.set('page', '0');
    const data = await readJson(await fetch(url, { headers, redirect: 'error', signal }), signal, 512 * 1024);
    if (!data || typeof data !== 'object') return null;
    const body = data as { query?: unknown; page?: unknown; results?: unknown };
    if (body.query !== query || body.page !== 0 || !Array.isArray(body.results) || body.results.length > 50) return null;
    const seen = new Set<string>();
    const results: RuTinyfishSearchResult[] = [];
    for (const value of body.results) {
      if (!value || typeof value !== 'object') continue;
      const row = value as { url?: unknown; title?: unknown; snippet?: unknown };
      if (typeof row.url !== 'string' || typeof row.title !== 'string' || typeof row.snippet !== 'string') continue;
      try {
        const link = new URL(row.url);
        const host = link.hostname.replace(/^\[|\]$/g, '');
        if (!['http:', 'https:'].includes(link.protocol) || link.username || link.password
          || link.port && !['80', '443'].includes(link.port) || isIP(host) && !isPublicIpAddress(host)) continue;
        link.hash = '';
        if (seen.has(link.href)) continue;
        seen.add(link.href);
        results.push({ link: link.href, title: row.title.slice(0, 1000), snippet: row.snippet.slice(0, 4000) });
      } catch { /* An invalid result never becomes a constructor input. */ }
    }
    signal.throwIfAborted();
    return results;
  } catch { input.signal?.throwIfAborted(); return null; }
}
