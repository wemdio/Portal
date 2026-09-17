import 'server-only';
import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeVeCompanyInn, normalizeVeCompanyName } from './collectionIdentity';
import { rankVeEvidenceLinks, selectVeEvidenceText, type VeEvidencePage } from './relevancePage';

/** Only public, identity-verified website observations. Never client input,
 * email deliverability, hypothesis verdicts or model-generated summaries. */
export const VE_COMPANY_FACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const VERSION = 1;
const TIMEOUT_MS = 2_000;
const link = z.object({ url: z.string().url().max(1000), text: z.string().max(240) });
const pageSchema = z.object({
  text: z.string().max(6000), url: z.string().url().max(1000), title: z.string().max(500).optional(),
  document: z.object({ text: z.string().min(60).max(120_000), links: z.array(link).max(400) }),
  inns: z.array(z.string().regex(/^\d{10}(?:\d{2})?$/)).max(100),
  ownerInns: z.array(z.string().regex(/^\d{10}(?:\d{2})?$/)).max(100).optional(),
});
export interface VeCompanyIdentity { inn?: unknown; company?: unknown; address?: unknown }
export interface VeCompanyFactRecord {
  company_key: string; page_key: string; reader_version: number; observed_at: string;
  expires_at: string; page: unknown;
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function veCompanyFactKey(identity: VeCompanyIdentity): string | null {
  const inn = normalizeVeCompanyInn(identity.inn);
  if (inn) return hash(['inn', inn]);
  const name = normalizeVeCompanyName(identity.company);
  const address = String(identity.address ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  // A city alone is not a company identity: similarly named businesses may
  // operate in the same city. Without INN require an address with a building.
  return name.length >= 4 && address.length >= 12 && /[\p{L}]{3}/u.test(address) && /\d/.test(address)
    ? hash(['name-address', name, address]) : null;
}
export function veFactPageKey(url: string): string {
  const parsed = new URL(url);
  parsed.hostname = parsed.hostname.replace(/^www\./, '');
  parsed.hash = '';
  return hash(parsed.href);
}
export function freshVeCompanyFact(record: VeCompanyFactRecord, now = Date.now()): VeEvidencePage | null {
  const age = now - Date.parse(record.observed_at);
  if (record.reader_version !== VERSION || !Number.isFinite(age) || age < 0 || age >= VE_COMPANY_FACT_TTL_MS
    || Date.parse(record.expires_at) <= now || !Number.isFinite(Date.parse(record.expires_at))) return null;
  const parsed = pageSchema.safeParse(record.page);
  if (!parsed.success || veFactPageKey(parsed.data.url) !== record.page_key) return null;
  return { ...parsed.data, text: selectVeEvidenceText(parsed.data.document.text), links: parsed.data.document.links };
}
/** Re-select passages/links for EACH hypothesis from the unabridged stored
 * document. A passage chosen for one hypothesis cannot hide another's facts. */
export function focusVeCompanyFact(page: VeEvidencePage, focus = ''): VeEvidencePage {
  const links = page.document?.links ?? page.links;
  const ranked = [...rankVeEvidenceLinks(links, focus, 'identity').slice(0, 6),
    ...rankVeEvidenceLinks(links, focus), ...links];
  return { ...page, text: selectVeEvidenceText(page.document?.text ?? page.text, focus),
    links: [...new Map(ranked.map((item) => [item.url, item])).values()].slice(0, 80) };
}
const deadline = (signal?: AbortSignal) => signal
  ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

export async function readVeCompanyFacts(keys: string[], signal?: AbortSignal, db: SupabaseClient | null = supabaseAdmin): Promise<VeCompanyFactRecord[]> {
  signal?.throwIfAborted();
  if (!db || !keys.length) return [];
  try {
    const { data, error } = await db.from('ve_company_fact_pages').select('company_key,page_key,reader_version,observed_at,expires_at,page')
      .in('company_key', [...new Set(keys)].slice(0, 200)).gt('expires_at', new Date().toISOString())
      .order('observed_at', { ascending: false }).limit(2000).abortSignal(deadline(signal));
    signal?.throwIfAborted();
    return error ? [] : (data ?? []).filter((row) => freshVeCompanyFact(row));
  } catch { signal?.throwIfAborted(); return []; }
}

export async function writeVeCompanyFacts(key: string, pages: VeEvidencePage[], observedAt: string): Promise<void> {
  if (!supabaseAdmin) return;
  const rows = pages.flatMap((page) => {
    const parsed = pageSchema.safeParse({ ...page, text: selectVeEvidenceText(page.document?.text ?? page.text) });
    return parsed.success ? [{ company_key: key, page_key: veFactPageKey(page.url), reader_version: VERSION,
      observed_at: observedAt, expires_at: new Date(Date.parse(observedAt) + VE_COMPANY_FACT_TTL_MS).toISOString(), page: parsed.data }] : [];
  });
  if (!rows.length) return;
  try {
    // Each page has its own key; independent hypotheses cannot replace the
    // entire company dossier and erase one another's freshly read pages.
    await supabaseAdmin.from('ve_company_fact_pages').upsert(rows, { onConflict: 'company_key,page_key' }).abortSignal(deadline());
  } catch { /* Optional accelerator: the verified result remains usable. */ }
}

/** Share simultaneous HTTP reads, not per-hypothesis decisions. Each waiter
 * may cancel independently; the last cancellation aborts the actual request. */
export function createVeSharedPageReader(reader: (url: URL, signal: AbortSignal) => Promise<VeEvidencePage>) {
  type Flight = { promise: Promise<VeEvidencePage>; controller: AbortController; users: number; settled: boolean };
  const flights = new Map<string, Flight>();
  return (url: URL, signal: AbortSignal): Promise<VeEvidencePage> => {
    signal.throwIfAborted();
    const key = url.href;
    let flight = flights.get(key);
    if (!flight) {
      const controller = new AbortController();
      const created: Flight = { promise: Promise.resolve().then(() => { controller.signal.throwIfAborted(); return reader(url, controller.signal); }), controller, users: 0, settled: false };
      flight = created; flights.set(key, created);
      const done = () => { created.settled = true; if (flights.get(key) === created) flights.delete(key); };
      void created.promise.then(done, done);
    }
    const shared = flight; shared.users += 1;
    return new Promise((resolve, reject) => {
      let done = false;
      const leave = () => { done = true; signal.removeEventListener('abort', abort); shared.users -= 1;
        if (!shared.users && !shared.settled) { if (flights.get(key) === shared) flights.delete(key); shared.controller.abort(); } };
      const abort = () => { if (!done) { leave(); reject(signal.reason); } };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      void shared.promise.then((page) => { if (!done) { leave(); resolve(structuredClone(page)); } },
        (error: unknown) => { if (!done) { leave(); reject(error); } });
    });
  };
}
