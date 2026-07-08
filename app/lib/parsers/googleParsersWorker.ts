import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { decryptJsonAes256Gcm } from '@/lib/cryptoGcm';
import type {
  GoogleMapsJobRow,
  GoogleNewsJobRow,
  GoogleMapsPlaceRow,
  GoogleNewsResultRow,
  GoogleParserStatus,
} from '@/types/googleParsers';

const SERVICE_URL = process.env.GOOGLEPARSERS_SERVICE_URL ?? 'http://googleparsers:8001';
const PROXY_KEY = process.env.GOOGLEPARSERS_PROXY_ENCRYPTION_KEY ?? '';

// Parser types mirror the ones in services/googleparsers/src/shared/types.ts.
// Kept as a local shape (not imported) so the portal build stays decoupled
// from the parser-service package.
type ParserPlace = {
  query: string;
  city: string;
  category: string;
  name: string;
  address: string;
  phone: string;
  website: string;
  emails: string[];
  socials: string[];
  linkedInUrl: string;
  rating: string;
  reviewsCount: string;
  googleMapsUrl: string;
  placeId: string;
  googleId: string;
  latitude: string;
  longitude: string;
  dedupeKey: string;
  sourceUrl: string;
  status: string;
};

type ParserNews = {
  query: string;
  position: number;
  title: string;
  body: string;
  posted: string;
  source: string;
  link: string;
};

/**
 * `supabaseAdmin` from `@/lib/supabaseAdmin` is a nullable value (null when the
 * service-role env vars are missing). Worker jobs must fail loudly in that case,
 * so we wrap access in a small helper that either returns the live client or
 * throws.
 */
function db() {
  if (!supabaseAdmin) throw new Error('supabaseAdmin not configured');
  return supabaseAdmin;
}

export function placeResultToRow(
  jobId: string,
  p: ParserPlace,
): Omit<GoogleMapsPlaceRow, 'id' | 'created_at'> {
  return {
    job_id: jobId,
    query: p.query || null,
    name: p.name || null,
    category: p.category || null,
    address: p.address || null,
    phone: p.phone || null,
    website: p.website || null,
    emails: p.emails.length ? p.emails : null,
    linkedin_url: p.linkedInUrl || null,
    google_maps_url: p.googleMapsUrl || null,
    place_id: p.placeId || null,
    rating: p.rating || null,
    reviews_count: p.reviewsCount ? Number(p.reviewsCount) : null,
    latitude: p.latitude ? Number(p.latitude) : null,
    longitude: p.longitude ? Number(p.longitude) : null,
    dedupe_key: p.dedupeKey,
    status: p.status || null,
  };
}

export function newsResultToRow(
  jobId: string,
  n: ParserNews,
): Omit<GoogleNewsResultRow, 'id' | 'created_at'> {
  return {
    job_id: jobId,
    query: n.query,
    position: n.position ?? null,
    title: n.title || null,
    body: n.body || null,
    posted: n.posted || null,
    source: n.source || null,
    link: n.link || null,
  };
}

async function updateMapsJob(jobId: string, patch: Partial<GoogleMapsJobRow>) {
  const { error } = await db().from('google_maps_jobs').update(patch).eq('id', jobId);
  if (error) throw error;
}

async function updateNewsJob(jobId: string, patch: Partial<GoogleNewsJobRow>) {
  const { error } = await db().from('google_news_jobs').update(patch).eq('id', jobId);
  if (error) throw error;
}

async function checkControlSignal(
  table: 'google_maps_jobs' | 'google_news_jobs',
  jobId: string,
): Promise<{ pause: boolean; stop: boolean }> {
  const { data } = await db().from(table).select('status').eq('id', jobId).maybeSingle();
  const status = (data as { status?: string } | null)?.status;
  return { pause: status === 'paused', stop: status === 'stopped' };
}

async function countRows(table: string, jobId: string): Promise<number> {
  const { count } = await db()
    .from(table)
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId);
  return count ?? 0;
}

async function streamSse(
  url: string,
  body: unknown,
  handlers: Record<string, (data: unknown) => Promise<void> | void>,
) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.body) throw new Error('service returned empty stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split('\n\n');
    buffer = parts.pop() ?? '';
    for (const chunk of parts) {
      const lines = chunk.split('\n');
      const event = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message';
      const dataLine = lines.find((l) => l.startsWith('data: '))?.slice(6) ?? '';
      if (!dataLine) continue;
      const handler = handlers[event];
      if (handler) await handler(JSON.parse(dataLine));
    }
  }
}

export async function runGoogleMapsJob(jobId: string): Promise<void> {
  const { data: job } = await db()
    .from('google_maps_jobs')
    .select('*')
    .eq('id', jobId)
    .single<GoogleMapsJobRow>();
  if (!job) throw new Error(`job ${jobId} not found`);

  const proxies =
    job.proxy_enabled && job.proxy_encrypted
      ? decryptJsonAes256Gcm<string[]>(job.proxy_encrypted, PROXY_KEY)
      : [];

  const settings = { ...job.config, cities: [], categories: [], keyword: '', proxies };

  const placeBatch: ReturnType<typeof placeResultToRow>[] = [];
  const flush = async () => {
    if (!placeBatch.length) return;
    const rows = placeBatch.splice(0);
    await db()
      .from('google_maps_places')
      .upsert(rows, { onConflict: 'job_id,dedupe_key', ignoreDuplicates: true });
    await updateMapsJob(jobId, { total_results: await countRows('google_maps_places', jobId) });
  };

  let finalStatus: GoogleParserStatus = 'completed';
  let finalMessage = '';

  await streamSse(
    `${SERVICE_URL}/run/maps`,
    { jobId, settings },
    {
      place: async (data) => {
        placeBatch.push(placeResultToRow(jobId, data as ParserPlace));
        if (placeBatch.length >= 20) await flush();
      },
      progress: async (data) => {
        const p = data as {
          currentTargetIndex: number;
          processedPlaces: number;
          totalDiscovered: number;
          message: string;
        };
        await updateMapsJob(jobId, {
          processed_targets: p.currentTargetIndex,
          message: p.message,
        });
        const sig = await checkControlSignal('google_maps_jobs', jobId);
        if (sig.stop) {
          finalStatus = 'stopped';
          await fetch(`${SERVICE_URL}/control/${jobId}/stop`, { method: 'POST' });
        } else if (sig.pause) {
          await fetch(`${SERVICE_URL}/control/${jobId}/pause`, { method: 'POST' });
        }
      },
      error: async (data) => {
        const e = data as { message: string };
        finalMessage = e.message;
      },
      done: async (data) => {
        const d = data as { status: GoogleParserStatus; message: string };
        finalStatus = d.status;
        finalMessage = d.message || finalMessage;
      },
    },
  );

  await flush();
  await updateMapsJob(jobId, {
    status: finalStatus,
    message: finalMessage,
    completed_at: new Date().toISOString(),
  });
}

export async function runGoogleNewsJob(jobId: string): Promise<void> {
  const { data: job } = await db()
    .from('google_news_jobs')
    .select('*')
    .eq('id', jobId)
    .single<GoogleNewsJobRow>();
  if (!job) throw new Error(`job ${jobId} not found`);

  const proxies =
    job.proxy_enabled && job.proxy_encrypted
      ? decryptJsonAes256Gcm<string[]>(job.proxy_encrypted, PROXY_KEY)
      : [];

  const settings = { ...job.config, proxies };

  const batch: ReturnType<typeof newsResultToRow>[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = batch.splice(0);
    await db().from('google_news_results').insert(rows);
    await updateNewsJob(jobId, { total_results: await countRows('google_news_results', jobId) });
  };

  let finalStatus: GoogleParserStatus = 'completed';
  let finalMessage = '';

  await streamSse(
    `${SERVICE_URL}/run/news`,
    { jobId, settings },
    {
      result: async (data) => {
        batch.push(newsResultToRow(jobId, data as ParserNews));
        if (batch.length >= 20) await flush();
      },
      progress: async (data) => {
        // NewsJob only exposes currentTargetIndex, processedResults and message.
        const p = data as {
          currentTargetIndex: number;
          processedResults: number;
          message: string;
        };
        await updateNewsJob(jobId, {
          processed_targets: p.currentTargetIndex,
          message: p.message,
        });
        const sig = await checkControlSignal('google_news_jobs', jobId);
        if (sig.stop) {
          finalStatus = 'stopped';
          await fetch(`${SERVICE_URL}/control/${jobId}/stop`, { method: 'POST' });
        } else if (sig.pause) {
          await fetch(`${SERVICE_URL}/control/${jobId}/pause`, { method: 'POST' });
        }
      },
      error: async (data) => {
        const e = data as { message: string };
        finalMessage = e.message;
      },
      done: async (data) => {
        const d = data as { status: GoogleParserStatus; message: string };
        finalStatus = d.status;
        finalMessage = d.message || finalMessage;
      },
    },
  );

  await flush();
  await updateNewsJob(jobId, {
    status: finalStatus,
    message: finalMessage,
    completed_at: new Date().toISOString(),
  });
}
