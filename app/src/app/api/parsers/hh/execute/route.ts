import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError, logInfo } from '@/lib/loggerServer';
import { fetchVacancies, HHApiError, ParserJobCancelledError, type ParserProgressStage } from '@/lib/parsers/hhParser';
import type { HHSearchConfig, HHVacancy } from '@/lib/parsers/hhParser';
import { startTrace } from '@/lib/tracer';

export const dynamic = 'force-dynamic';

const PARSER_TYPE = 'hh_vacancies' as const;

const PROGRESS_WEIGHTS = {
  vacancies: 0.4,
  employers: 0.5,
  saving: 0.1,
} as const;

function clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function computeFraction(done?: number | null, total?: number | null) {
  if (total == null) return 0;
  if (total <= 0) return 1;
  if (done == null) return 0;
  return Math.min(1, Math.max(0, done / total));
}

function computeProgressPercent({
  found,
  parsed,
  employersTotal,
  employersDone,
  savedTotal,
  savedDone,
}: {
  found?: number | null;
  parsed?: number | null;
  employersTotal?: number | null;
  employersDone?: number | null;
  savedTotal?: number | null;
  savedDone?: number | null;
}) {
  const vacancyProgress = computeFraction(parsed, found);
  const employersProgress = computeFraction(employersDone, employersTotal);
  const savingProgress = computeFraction(savedDone, savedTotal);
  return clampPercent(
    100 *
      (vacancyProgress * PROGRESS_WEIGHTS.vacancies +
        employersProgress * PROGRESS_WEIGHTS.employers +
        savingProgress * PROGRESS_WEIGHTS.saving),
  );
}

function jsonError(message: string, status: number, extra?: Record<string, unknown>) {
  return NextResponse.json({ error: message, ...(extra ?? {}) }, { status });
}

async function getSupabase(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return { error: jsonError('Unauthorized', 401, { request_id: req.headers.get('x-request-id') ?? null }) };

  const supabase = createAuthedSupabaseClient(token);
  const requestId = req.headers.get('x-request-id') ?? null;
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { requestId, route, ip };

  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user) {
      await logError('parser.hh.auth.failed', error ?? 'User not found', { hasUser: Boolean(data?.user) }, logMeta);
      return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
    }
    return { supabase, user: data.user };
  } catch (err) {
    await logError('parser.hh.auth.exception', err, undefined, logMeta);
    return { error: jsonError('Unauthorized', 401, { request_id: requestId }) };
  }
}

function toDbRow(jobId: string, v: HHVacancy) {
  return {
    job_id: jobId,
    vacancy_id: v.vacancy_id,
    name: v.name,
    url: v.url,
    salary_from: v.salary_from ?? null,
    salary_to: v.salary_to ?? null,
    salary_currency: v.salary_currency ?? null,
    company_name: v.company_name,
    company_url: v.company_url ?? null,
    company_site_url: v.company_site_url ?? null,
    company_description: v.company_description ?? null,
    area: v.area,
    industries: v.industries ?? [],
    published_at: v.published_at ?? null,
  };
}

async function upsertInBatches(
  supabase: ReturnType<typeof createAuthedSupabaseClient> | NonNullable<typeof supabaseAdmin>,
  rows: Array<Record<string, unknown>>,
  onBatch?: (saved: number, total: number) => Promise<void> | void,
) {
  const batchSize = 250;
  let saved = 0;
  const total = rows.length;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await supabase
      .from('hh_vacancies')
      .upsert(batch, { onConflict: 'job_id,vacancy_id' });
    if (error) throw error;
    saved += batch.length;
    if (onBatch) await onBatch(saved, total);
  }
}

export async function POST(req: NextRequest) {
  const auth = await getSupabase(req);
  if ('error' in auth) return auth.error;

  const { supabase, user } = auth;
  const requestId = req.headers.get('x-request-id') ?? crypto.randomUUID();
  const route = req.nextUrl.pathname;
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
  const logMeta = { userId: user.id, requestId, route, ip };

  let body: { job_id?: string };
  try {
    body = (await req.json()) as { job_id?: string };
  } catch {
    return jsonError('Invalid JSON body', 400, { request_id: requestId });
  }

  const jobId = body.job_id;
  if (!jobId) return jsonError('Missing required field: job_id', 400, { request_id: requestId });

  const { data: job, error: jobError } = await supabase
    .from('parser_jobs')
    .select('*')
    .eq('id', jobId)
    .eq('user_id', user.id)
    .single();

  if (jobError || !job) return jsonError('Job not found', 404, { request_id: requestId });
  if (job.parser_type !== PARSER_TYPE) return jsonError('Unsupported parser_type', 400, { request_id: requestId });

  const config = job.config as HHSearchConfig;
  const searchText = config.text;
  const startedAt = Date.now();

  // Use admin client for all background DB operations so the job doesn't die
  // when the user's JWT expires (which happens after ~1h on large jobs).
  const db = supabaseAdmin ?? supabase;

  const updateStage = async (stage: ParserProgressStage) => {
    const { error } = await db
      .from('parser_jobs')
      .update({
        progress_stage: stage,
        ...(stage === 'partitioning' ? { progress_percent: null } : {}),
      })
      .eq('id', jobId);
    if (error) {
      await logError('parser.hh.stage.update.failed', error, { jobId, searchText, stage }, logMeta);
    }
  };

  const { error: startError } = await db
    .from('parser_jobs')
    .update({
      status: 'running',
      started_at: new Date().toISOString(),
      error_message: null,
      progress_percent: 0,
      progress_stage: 'fetching_vacancies',
    })
    .eq('id', jobId);
  if (startError) return jsonError(startError.message, 500, { request_id: requestId });

  await logAudit(
    'parser.hh.execute.start',
    'HH parser execution started',
    { jobId, searchText, config },
    logMeta,
  );

  const runJob = async () => {
    // Start root trace span for this job execution
    const trace = await startTrace({
      name: 'hh.execute',
      input: {
        jobId,
        searchText,
        config,
        requestId,
        route,
        ip,
        userId: user.id,
      },
      message: `Парсинг HH: ${searchText}`,
      userId: user.id,
      jobId,
    });

    const shouldCancel = async () => {
      try {
        const { data, error } = await db
          .from('parser_jobs')
          .select('status')
          .eq('id', jobId)
          .single();
        if (error || !data) return false; // don't cancel on transient DB errors
        return data.status !== 'running';
      } catch {
        return false; // don't cancel on network errors
      }
    };

    let lastPercent: number | null = 0;

    try {
      let lastProgressAt = 0;
      let lastFound: number | null = null;
      let lastParsed: number | null = null;
      let lastEmployersTotal: number | null = null;
      let lastEmployersDone: number | null = null;
      let lastSavedTotal: number | null = null;
      let lastSavedDone: number | null = null;
      const updateProgress = async (
        progress: {
          found?: number;
          parsed?: number;
          employersTotal?: number;
          employersDone?: number;
          savedTotal?: number;
          savedDone?: number;
        },
        force = false,
      ) => {
        const now = Date.now();
        const nextFound = progress.found ?? lastFound ?? null;
        const nextParsed = progress.parsed ?? lastParsed ?? null;
        const nextEmployersTotal = progress.employersTotal ?? lastEmployersTotal ?? null;
        const nextEmployersDone = progress.employersDone ?? lastEmployersDone ?? null;
        const nextSavedTotal = progress.savedTotal ?? lastSavedTotal ?? null;
        const nextSavedDone = progress.savedDone ?? lastSavedDone ?? null;
        const computedPercent = computeProgressPercent({
          found: nextFound,
          parsed: nextParsed,
          employersTotal: nextEmployersTotal,
          employersDone: nextEmployersDone,
          savedTotal: nextSavedTotal,
          savedDone: nextSavedDone,
        });
        const nextPercent = lastPercent == null ? computedPercent : Math.max(lastPercent, computedPercent);
        if (!force && now - lastProgressAt < 2000) return;
        if (
          !force &&
          nextFound === lastFound &&
          nextParsed === lastParsed &&
          nextEmployersTotal === lastEmployersTotal &&
          nextEmployersDone === lastEmployersDone &&
          nextSavedTotal === lastSavedTotal &&
          nextSavedDone === lastSavedDone &&
          nextPercent === lastPercent
        ) return;
        lastProgressAt = now;
        lastFound = nextFound;
        lastParsed = nextParsed;
        lastEmployersTotal = nextEmployersTotal;
        lastEmployersDone = nextEmployersDone;
        lastSavedTotal = nextSavedTotal;
        lastSavedDone = nextSavedDone;
        lastPercent = nextPercent;
        const { error } = await db
          .from('parser_jobs')
          .update({ total_found: nextFound, total_parsed: nextParsed, progress_percent: nextPercent })
          .eq('id', jobId);
        if (error) {
          await logError('parser.hh.progress.update.failed', error, { jobId, searchText }, logMeta);
        }
      };

      // --- Phase 1: Fetch vacancies ---
      await updateStage('partitioning');
      const fetchSpan = await trace?.startChild({
        name: 'hh.fetch_vacancies',
        input: { searchText, config },
        message: 'Загрузка вакансий с HH API',
      });

      const { found, vacancies } = await fetchVacancies(config, {
        jobId,
        logMeta,
        searchText,
        trace,
        shouldCancel,
        onProgress: (progress) => {
          void updateProgress({
            found: progress.found,
            parsed: progress.parsed,
            employersTotal: progress.employersTotal,
            employersDone: progress.employersFetched,
          });
        },
        onStage: (stage) => {
          void updateStage(stage);
        },
      });
      const employersTotal = new Set(
        vacancies.map((vacancy) => vacancy.employer_id).filter((id): id is string => Boolean(id)),
      ).size;
      await updateProgress(
        { found, parsed: vacancies.length, employersTotal, employersDone: employersTotal },
        true,
      );
      await fetchSpan?.end(
        { found, fetched: vacancies.length, uniqueEmployers: employersTotal },
        `Загружено ${vacancies.length} вакансий из ${found} найденных`,
      );
      await logInfo(
        'parser.hh.fetch.completed',
        'HH vacancies fetched',
        { jobId, searchText, found, fetched: vacancies.length },
        logMeta,
      );

      // --- Phase 2: Deduplicate ---
      const dedupeSpan = await trace?.startChild({
        name: 'hh.deduplicate',
        input: { totalFetched: vacancies.length },
        message: 'Дедупликация вакансий',
      });
      await dedupeSpan?.end(
        { unique: vacancies.length },
        `${vacancies.length} уникальных вакансий`,
      );
      await logInfo(
        'parser.hh.dedupe.completed',
        'HH vacancies deduplicated',
        { jobId, searchText, parsed: vacancies.length },
        logMeta,
      );

      // --- Phase 3: Save to DB ---
      await updateStage('saving');
      const saveSpan = await trace?.startChild({
        name: 'hh.save_to_db',
        input: { rows: vacancies.length },
        message: 'Сохранение в базу данных',
      });

      const rows = vacancies.map((v) => toDbRow(jobId, v));
      await updateProgress({ savedTotal: rows.length, savedDone: 0 }, true);
      await logInfo(
        'parser.hh.upsert.start',
        'HH vacancies upsert started',
        { jobId, searchText, rows: rows.length },
        logMeta,
      );
      await upsertInBatches(db, rows, (saved, total) =>
        updateProgress({ savedTotal: total, savedDone: saved }, saved === total),
      );
      await saveSpan?.end(
        { savedRows: rows.length },
        `Сохранено ${rows.length} записей`,
      );
      await logInfo(
        'parser.hh.upsert.completed',
        'HH vacancies upsert completed',
        { jobId, searchText },
        logMeta,
      );

      // --- Finalize job ---
      const { error: doneError } = await db
        .from('parser_jobs')
        .update({
          status: 'completed',
          total_found: found,
          total_parsed: vacancies.length,
          completed_at: new Date().toISOString(),
          error_message: null,
          progress_percent: 100,
          progress_stage: 'completed',
        })
        .eq('id', jobId);
      if (doneError) {
        await logError('parser.hh.execute.update_failed', doneError, { jobId, searchText }, logMeta);
        await trace?.fail(doneError);
        return;
      }

      await trace?.end(
        { found, parsed: vacancies.length, elapsed_ms: Date.now() - startedAt },
        `Завершено: ${vacancies.length} вакансий за ${Math.round((Date.now() - startedAt) / 1000)}с`,
      );

      await logAudit(
        'parser.hh.execute.completed',
        'HH parser execution completed',
        {
          jobId,
          searchText,
          found,
          parsed: vacancies.length,
          elapsed_ms: Date.now() - startedAt,
        },
        logMeta,
      );
    } catch (err: unknown) {
      if (err instanceof ParserJobCancelledError) {
        await updateStage('cancelled');
        await trace?.cancel('Задача отменена пользователем');
        await logAudit(
          'parser.hh.execute.cancelled',
          'HH parser execution cancelled',
          { jobId, searchText },
          logMeta,
        );
        return;
      }

      let message = err instanceof Error ? err.message : (typeof err === 'string' ? err : 'Unknown error');
      let extra: Record<string, unknown> | undefined;
      let jobMessage = message;

      if (err instanceof HHApiError) {
        message = err.message;
        jobMessage = err.captchaUrl ? 'HH API требует капчу' : message;
        extra = {
          ...(err.captchaUrl ? { captcha_url: err.captchaUrl } : {}),
          ...(err.requestId ? { request_id: err.requestId } : {}),
        };
      }

      await db
        .from('parser_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: jobMessage,
          progress_percent: lastPercent ?? null,
          progress_stage: 'failed',
        })
        .eq('id', jobId);

      await trace?.fail(err, extra);

      await logError(
        'parser.hh.execute.failed',
        err,
        {
          jobId,
          searchText,
          elapsed_ms: Date.now() - startedAt,
          message,
          ...(extra ?? {}),
        },
        logMeta,
      );
    }
  };

  void runJob();
  return NextResponse.json({ status: 'running', job_id: jobId }, { status: 202 });
}

