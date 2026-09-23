/** @jest-environment node */

/**
 * 23.09.2026 (nginx, 12:05:38–12:38:02 MSK): hints of ve_company_fact_pages
 * were requested for 200 companies at once. Each key is a 64-character hash,
 * the URL grew to ~13.6 KB, the gateway answered 414, and the loop gave up —
 * every hint of the tick was lost.
 */
import { createClient } from '@supabase/supabase-js';
import { readVeCandidateHints } from '@/lib/verticalEngineV2/candidatePriority';
import { veCompanyFactKey } from '@/lib/verticalEngineV2/companyFacts';

/** nginx rejects a request line longer than its header buffer (8 KB) with 414. */
const GATEWAY_URL_LIMIT = 8 * 1024;

function gateway() {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.length > GATEWAY_URL_LIMIT) return new Response('<html>414 Request-URI Too Large</html>', { status: 414 });
    const keys = decodeURIComponent(new URL(url).searchParams.get('company_key') ?? '').replace(/^in\.\(|\)$/g, '').split(',');
    const rows = keys.map((key) => ({
      company_key: key, observed_at: new Date().toISOString(), website: 'https://clinic.example.ru',
      facts: 'Медицинский центр генетики и развития', inns: [], owner_inns: [],
    }));
    return new Response(JSON.stringify(rows), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { urls, db: createClient('https://supabase.polza.example', 'k', { auth: { persistSession: false }, global: { fetch: fetchImpl } }) };
}

const candidates = Array.from({ length: 200 }, (_, i) => ({
  company: `Клиника развития ${i}`, inn: String(7_700_000_000 + i * 7), website: '', address: '', email: '', category: 'медицинский центр',
}));

describe('readVeCandidateHints', () => {
  it('keeps every request URL under 6 KB and loses no hint', async () => {
    const keys = candidates.map((row) => veCompanyFactKey(row));
    expect(new Set(keys).size).toBe(200);
    expect(keys.every((key) => /^[0-9a-f]{64}$/.test(key ?? ''))).toBe(true);
    const { urls, db } = gateway();
    const hints = await readVeCandidateHints(candidates, db);
    expect(urls.length).toBeGreaterThan(1);
    for (const url of urls) expect(url.length).toBeLessThan(6_000);
    expect(new Set(hints.map((hint) => hint.key))).toEqual(new Set(keys));
  });
});
