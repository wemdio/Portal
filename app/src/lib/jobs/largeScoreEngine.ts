/**
 * Large-file scoring engine.
 *
 * Клиент загрузил большой файл (миллионы доменов) в S3 → создан джоб
 * large_score_jobs. Этот движок:
 *   1. parse:  стримит файл из S3, нормализует домены, чистит мусор, кладёт
 *              уникальные в очередь large_score_domains (status='pending').
 *              Резумируемо через parse_offset.
 *   2. drain:  батчами скорит pending-домены через getOrFetchScore (→ общий
 *              кэш mailganer_domain_scores). Для активных (score>0) ставит
 *              fallback-имя компании в кэше, ЕСЛИ имени ещё нет — тогда домен
 *              становится виден существующему добору (fetchTopUpFromCache
 *              берёт score>0 AND company_name IS NOT NULL). Так файл «капает»
 *              в кампании через ночной пайплайн в темпе daily_limit — без
 *              единой правки боевого ночного кода.
 *
 * Возобновляемость (переживает редеплой):
 *   - всё состояние в БД (large_score_jobs/domains на DB-сервере);
 *   - parse: при рестарте перечитывает файл, пропускает parse_offset строк;
 *   - drain: pending-строки остаются pending → переобрабатываются; повтор
 *     скоринга домена = no-op (getOrFetchScore сначала смотрит кэш).
 *
 * Крутится в воркере portal-worker-bob-scorer (приоритет над фоновым BoB).
 */

import 'server-only';
import readline from 'node:readline';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getMainS3ObjectStream } from '@/lib/mainS3Server';
import { getOrFetchScore, getCachedScores, normalizeDomain, emptyCacheStats } from './mailganerScoreCache';

interface ScoreEndpointConfig {
  url: string;
  apiKey: string;
  authScheme: string;
  timeoutMs: number;
}

interface LargeScoreJob {
  id: string;
  s3_key: string;
  status: string;
  parse_offset: number | null;
  parsed_domains: number | null;
  junk_domains: number | null;
  scored_domains: number | null;
  active_domains: number | null;
  cached_domains: number | null;
}

/** Строк файла за один парс-флеш (вставка в очередь). */
const PARSE_BATCH = 5_000;
/** Доменов за один drain-тик (скорятся с concurrency воркеров). */
const DRAIN_BATCH = 300;
/** Id за один батч-UPDATE статусов (id уходят в URL PostgREST-фильтра). */
const MARK_CHUNK = 150;

function nowIso(): string {
  return new Date().toISOString();
}

/** Имя-кандидат из домена (фоллбек): "stripe.com" → "Stripe". AI потом почистит. */
function domainToNameCandidate(domain: string): string {
  const label = (domain.replace(/^www\./, '').split('.')[0] ?? '').trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : domain;
}

/**
 * Достаёт домен из одной строки файла. Поддерживает: голый домен, URL,
 * CSV (первая колонка), email (часть после @). null если строка — мусор.
 */
function extractDomain(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const first = (trimmed.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
  if (!first) return null;
  const emailMatch = first.match(/@([^\s]+)$/);
  const candidate = emailMatch ? emailMatch[1] : first;
  return normalizeDomain(candidate.replace(/^https?:\/\//, ''));
}

/**
 * Точка входа для воркера. Находит одну работу (parse или drain) и делает
 * её порцию. Возвращает true если что-то делал (воркеру решать про sleep).
 */
export async function processNextLargeScoreWork(
  endpoint: ScoreEndpointConfig,
  concurrency: number,
  log: (msg: string) => void = () => undefined,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  // 1. Парсинг имеет приоритет (быстро довести файл до очереди).
  const { data: parsing } = await supabaseAdmin
    .from('large_score_jobs')
    .select('id, s3_key, status, parse_offset, parsed_domains, junk_domains, scored_domains, active_domains, cached_domains')
    .eq('status', 'parsing')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (parsing) {
    await parseJob(parsing as LargeScoreJob, log);
    return true;
  }

  // 2. Скоринг очереди.
  const { data: scoring } = await supabaseAdmin
    .from('large_score_jobs')
    .select('id, s3_key, status, parse_offset, parsed_domains, junk_domains, scored_domains, active_domains, cached_domains')
    .eq('status', 'scoring')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (scoring) {
    await drainJobBatch(scoring as LargeScoreJob, endpoint, concurrency, log);
    return true;
  }

  return false;
}

async function parseJob(job: LargeScoreJob, log: (msg: string) => void): Promise<void> {
  if (!supabaseAdmin) return;
  const stream = await getMainS3ObjectStream(job.s3_key);
  if (!stream) {
    await supabaseAdmin
      .from('large_score_jobs')
      .update({ status: 'failed', error_message: 'Файл не найден в S3', updated_at: nowIso() })
      .eq('id', job.id);
    return;
  }

  const skip = job.parse_offset ?? 0;
  let lineNo = 0;
  let kept = job.parsed_domains ?? 0;
  let junk = job.junk_domains ?? 0;
  let batch: string[] = [];

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    await supabaseAdmin!
      .from('large_score_domains')
      .upsert(
        batch.map((domain) => ({ job_id: job.id, domain })),
        { onConflict: 'job_id,domain', ignoreDuplicates: true },
      );
    batch = [];
  };

  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const raw of rl) {
      lineNo++;
      if (lineNo <= skip) continue; // resume: пропускаем уже обработанные строки
      const domain = extractDomain(raw);
      if (domain) {
        batch.push(domain);
        kept++;
      } else {
        junk++;
      }
      if (batch.length >= PARSE_BATCH) {
        await flush();
        await supabaseAdmin
          .from('large_score_jobs')
          .update({ parse_offset: lineNo, parsed_domains: kept, junk_domains: junk, updated_at: nowIso() })
          .eq('id', job.id);
      }
    }
    await flush();
  } finally {
    rl.close();
    stream.destroy?.();
  }

  // Реальное число уникальных доменов в очереди (после дедупа ON CONFLICT).
  const { count } = await supabaseAdmin
    .from('large_score_domains')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', job.id);

  await supabaseAdmin
    .from('large_score_jobs')
    .update({
      status: 'scoring',
      parse_offset: lineNo,
      parsed_domains: kept,
      junk_domains: junk,
      total_domains: count ?? kept,
      updated_at: nowIso(),
    })
    .eq('id', job.id);

  log(`large-score parse done: job=${job.id} lines=${lineNo} queued=${count ?? kept} junk=${junk}`);
}

async function drainJobBatch(
  job: LargeScoreJob,
  endpoint: ScoreEndpointConfig,
  concurrency: number,
  log: (msg: string) => void,
): Promise<void> {
  if (!supabaseAdmin) return;

  const { data: pendingData } = await supabaseAdmin
    .from('large_score_domains')
    .select('id, domain')
    .eq('job_id', job.id)
    .eq('status', 'pending')
    .order('id', { ascending: true })
    .limit(DRAIN_BATCH);

  const rows = (pendingData ?? []) as Array<{ id: number; domain: string }>;

  if (rows.length === 0) {
    // Очередь пуста → джоб завершён.
    await supabaseAdmin
      .from('large_score_jobs')
      .update({ status: 'completed', finished_at: nowIso(), updated_at: nowIso() })
      .eq('id', job.id);
    log(`large-score job completed: ${job.id}`);
    return;
  }

  const stats = emptyCacheStats();
  let scored = 0;
  let active = 0;
  let cursor = 0;

  // Кэш-lookup всей пачки одним батчем; промахи добираются getOrFetchScore.
  const cached = await getCachedScores(
    rows.map((r) => normalizeDomain(r.domain)).filter((d): d is string => d !== null),
  );

  // Статусы копим в памяти и пишем пачкой после прогона. UPDATE на каждую
  // строку давал ~70% транзакций всей БД на больших файлах. Если воркер
  // умрёт до записи — строки останутся pending и переобработаются (no-op
  // по кэшу), это штатный resume-путь движка.
  const marks: Record<'scored' | 'error', number[]> = { scored: [], error: [] };

  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= rows.length) return;
      const r = rows[i];
      const domain = normalizeDomain(r.domain);
      if (!domain) {
        marks.error.push(r.id);
        continue;
      }
      try {
        const pre = cached.get(domain);
        if (pre) stats.hits += 1;
        const res = pre ?? (await getOrFetchScore(domain, endpoint, 'background', stats));
        if (!res.ok) {
          marks.error.push(r.id);
          continue;
        }
        scored++;
        if (typeof res.score === 'number' && res.score > 0) {
          active++;
          // Fallback-имя → домен становится виден добору. Не затираем имя из
          // ФНС-кэша (БoB-скорер мог уже поставить настоящее) — только если NULL.
          await supabaseAdmin!
            .from('mailganer_domain_scores')
            .update({ company_name: domainToNameCandidate(domain) })
            .eq('domain', domain)
            .is('company_name', null);
        }
        marks.scored.push(r.id);
      } catch {
        marks.error.push(r.id);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));

  // Один UPDATE на статус (чанками — id уходят в URL фильтра).
  const markedAt = nowIso();
  for (const status of ['scored', 'error'] as const) {
    const ids = marks[status];
    for (let i = 0; i < ids.length; i += MARK_CHUNK) {
      await supabaseAdmin
        .from('large_score_domains')
        .update({ status, scored_at: markedAt })
        .in('id', ids.slice(i, i + MARK_CHUNK));
    }
  }

  await supabaseAdmin
    .from('large_score_jobs')
    .update({
      scored_domains: (job.scored_domains ?? 0) + scored,
      active_domains: (job.active_domains ?? 0) + active,
      cached_domains: (job.cached_domains ?? 0) + stats.hits,
      updated_at: nowIso(),
    })
    .eq('id', job.id);
}
