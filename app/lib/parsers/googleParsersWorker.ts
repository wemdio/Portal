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

/**
 * Общий пул прокси на прод-сервере — используется как fallback, если у
 * джобы не заполнено поле «Прокси» в форме. Ту же переменную читают
 * Яндекс.Карты / HH / ENG-hiring / прочие скрейперы. Формат: JSON-массив
 * строк "http://user:pass@host:port". Парсится один раз при импорте
 * модуля — без runtime-запроса и без throw на пустом/сломанном значении.
 */
function loadDefaultProxies(): string[] {
  const raw = process.env.PROXY_URLS?.trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === 'string' && s.length > 0) : [];
  } catch {
    console.warn('[gp-worker] PROXY_URLS is set but not valid JSON, ignoring');
    return [];
  }
}
const DEFAULT_PROXIES = loadDefaultProxies();

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

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type JobKind = 'maps' | 'news';

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

/**
 * Persist a diagnostic log line for a running parser job. Also echoes to stdout
 * so `docker logs portal-worker-googleparsers` remains readable.
 *
 * NEVER throws — a failed log insert must not fail the parent job. Errors are
 * logged to stderr and swallowed.
 */
export async function writeLog(
  jobId: string,
  jobKind: JobKind,
  level: LogLevel,
  message: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const line = `[gp-worker][${jobKind}][${jobId.slice(0, 8)}][${level}] ${message}`;
  if (level === 'error' || level === 'warn') console.error(line, meta ?? '');
  else console.log(line, meta ?? '');
  try {
    await db().from('google_parsers_logs').insert({
      job_id: jobId,
      job_kind: jobKind,
      level,
      message,
      meta: meta ?? null,
    });
  } catch (err) {
    // Never fail the job because a log write failed.
    console.error(`[gp-worker] failed to persist log for ${jobId}:`, err);
  }
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

  const perJobProxies =
    job.proxy_enabled && job.proxy_encrypted
      ? decryptJsonAes256Gcm<string[]>(job.proxy_encrypted, PROXY_KEY)
      : [];
  // Если оператор не указал персональный прокси-пул для этой джобы —
  // валимся на общий PROXY_URLS. Без прокси Google ловит капчу почти
  // мгновенно (пример: News уходит в captcha на 2-й запрос).
  const proxies = perJobProxies.length > 0 ? perJobProxies : DEFAULT_PROXIES;

  const settings = { ...job.config, cities: [], categories: [], keyword: '', proxies };

  await writeLog(jobId, 'maps', 'info', 'Worker picked up job', {
    proxies: proxies.length,
    proxiesSource: perJobProxies.length > 0 ? 'per-job' : (DEFAULT_PROXIES.length > 0 ? 'env-default' : 'none'),
    config: job.config,
  });

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
  // Track whether the parser emitted an error and whether it followed up with
  // a `done` event. If we saw `error` but never `done`, the job must land in
  // 'failed' — otherwise it would silently return the initial 'completed'.
  let parserErrored = false;
  let doneSeen = false;

  try {
    await streamSse(
      `${SERVICE_URL}/run/maps`,
      { jobId, settings },
      {
        log: async (data) => {
          const l = data as { level: LogLevel; message: string; meta?: Record<string, unknown> };
          await writeLog(jobId, 'maps', l.level, l.message, l.meta);
        },
        place: async (data) => {
          const p = data as ParserPlace;
          placeBatch.push(placeResultToRow(jobId, p));
          await writeLog(jobId, 'maps', 'debug', 'Result received', { name: p.name });
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
          await writeLog(jobId, 'maps', 'info', p.message, {
            currentTargetIndex: p.currentTargetIndex,
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
          parserErrored = true;
          await writeLog(jobId, 'maps', 'error', e.message);
        },
        done: async (data) => {
          const d = data as { status: GoogleParserStatus; message: string };
          finalStatus = d.status;
          finalMessage = d.message || finalMessage;
          doneSeen = true;
          await writeLog(jobId, 'maps', 'info', 'Job finished', {
            status: d.status,
            message: d.message,
          });
        },
      },
    );
  } catch (err) {
    // fetch failure, torn SSE stream, or a JSON.parse throw — surface it.
    const msg = err instanceof Error ? err.message : String(err);
    finalStatus = 'failed';
    finalMessage = msg;
    parserErrored = true;
    await writeLog(jobId, 'maps', 'error', `Stream failed: ${msg}`);
  }

  // If the parser emitted `error` but never a `done`, promote to 'failed'.
  // The cast is required because TS control-flow narrowing collapses
  // finalStatus to `'completed' | 'failed'` (it can't see the assignment
  // to 'stopped' inside the async progress-handler closure above).
  if (!doneSeen && parserErrored && (finalStatus as GoogleParserStatus) !== 'stopped') {
    finalStatus = 'failed';
  }

  await flush();
  await updateMapsJob(jobId, {
    status: finalStatus,
    message: finalMessage,
    completed_at: new Date().toISOString(),
  });
  await writeLog(jobId, 'maps', 'info', 'Worker finished', {
    status: finalStatus,
    message: finalMessage,
  });
}

export async function runGoogleNewsJob(jobId: string): Promise<void> {
  const { data: job } = await db()
    .from('google_news_jobs')
    .select('*')
    .eq('id', jobId)
    .single<GoogleNewsJobRow>();
  if (!job) throw new Error(`job ${jobId} not found`);

  const perJobProxies =
    job.proxy_enabled && job.proxy_encrypted
      ? decryptJsonAes256Gcm<string[]>(job.proxy_encrypted, PROXY_KEY)
      : [];
  // Если оператор не указал персональный прокси-пул для этой джобы —
  // валимся на общий PROXY_URLS. Без прокси Google ловит капчу почти
  // мгновенно (пример: News уходит в captcha на 2-й запрос).
  const proxies = perJobProxies.length > 0 ? perJobProxies : DEFAULT_PROXIES;

  const settings = { ...job.config, proxies };

  await writeLog(jobId, 'news', 'info', 'Worker picked up job', {
    proxies: proxies.length,
    proxiesSource: perJobProxies.length > 0 ? 'per-job' : (DEFAULT_PROXIES.length > 0 ? 'env-default' : 'none'),
    config: job.config,
  });

  const batch: ReturnType<typeof newsResultToRow>[] = [];
  const flush = async () => {
    if (!batch.length) return;
    const rows = batch.splice(0);
    await db().from('google_news_results').insert(rows);
    await updateNewsJob(jobId, { total_results: await countRows('google_news_results', jobId) });
  };

  let finalStatus: GoogleParserStatus = 'completed';
  let finalMessage = '';
  let parserErrored = false;
  let doneSeen = false;

  try {
    await streamSse(
      `${SERVICE_URL}/run/news`,
      { jobId, settings },
      {
        log: async (data) => {
          const l = data as { level: LogLevel; message: string; meta?: Record<string, unknown> };
          await writeLog(jobId, 'news', l.level, l.message, l.meta);
        },
        result: async (data) => {
          const n = data as ParserNews;
          batch.push(newsResultToRow(jobId, n));
          await writeLog(jobId, 'news', 'debug', 'Result received', { title: n.title });
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
          await writeLog(jobId, 'news', 'info', p.message, {
            currentTargetIndex: p.currentTargetIndex,
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
          parserErrored = true;
          await writeLog(jobId, 'news', 'error', e.message);
        },
        done: async (data) => {
          const d = data as { status: GoogleParserStatus; message: string };
          finalStatus = d.status;
          finalMessage = d.message || finalMessage;
          doneSeen = true;
          await writeLog(jobId, 'news', 'info', 'Job finished', {
            status: d.status,
            message: d.message,
          });
        },
      },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    finalStatus = 'failed';
    finalMessage = msg;
    parserErrored = true;
    await writeLog(jobId, 'news', 'error', `Stream failed: ${msg}`);
  }

  if (!doneSeen && parserErrored && (finalStatus as GoogleParserStatus) !== 'stopped') {
    finalStatus = 'failed';
  }

  await flush();
  await updateNewsJob(jobId, {
    status: finalStatus,
    message: finalMessage,
    completed_at: new Date().toISOString(),
  });
  await writeLog(jobId, 'news', 'info', 'Worker finished', {
    status: finalStatus,
    message: finalMessage,
  });
}
