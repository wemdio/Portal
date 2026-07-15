import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { logAudit, logError, logInfo } from '@/lib/loggerServer';
import { fetchVacancies, HHApiError, ParserJobCancelledError, withTimeout, type ParserProgressStage, type PartitionProgress } from '@/lib/parsers/hhParser';
import type { HHSearchConfig, HHVacancy } from '@/lib/parsers/hhParser';
import { startTrace } from '@/lib/tracer';

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
  db: NonNullable<typeof supabaseAdmin>,
  rows: Array<Record<string, unknown>>,
  onBatch?: (saved: number, total: number) => Promise<void> | void,
) {
  const batchSize = 250;
  let saved = 0;
  const total = rows.length;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const { error } = await db.from('hh_vacancies').upsert(batch, { onConflict: 'job_id,vacancy_id' });
    if (error) throw error;
    saved += batch.length;
    if (onBatch) await onBatch(saved, total);
  }
}

export async function runHHParserJob(jobId: string, drainTimeoutMs: number): Promise<void> {
  if (!supabaseAdmin) {
    console.error('[hhRunner] supabaseAdmin not configured');
    return;
  }
  const db = supabaseAdmin;

  const { data: job, error: jobError } = await db
    .from('parser_jobs')
    .select('*')
    .eq('id', jobId)
    .single();

  if (jobError || !job) {
    console.error('[hhRunner] Job not found:', jobId);
    return;
  }

  if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
    return;
  }

  const config = job.config as HHSearchConfig;
  const searchText = config.text ?? config.url ?? '';
  const fetchParam = config.url ?? config;
  // Manual + Telegram-agent HH parsing reproduces HH's own result set ("as on
  // HH") by default — whatever count HH shows for the pasted URL (title-only or
  // +description) is what we collect, instead of over-collecting via the per-term
  // split. collection_mode:'split' is the escape hatch to the old exhaustive mode.
  // Automated pipelines (Mailganer/Nash/OutreachOS) don't use this runner, so
  // they are unaffected either way.
  const collectionMode = (config as { collection_mode?: unknown }).collection_mode === 'split' ? 'split' : 'combined';
  const startedAt = Date.now();
  const requestId = crypto.randomUUID();
  const logMeta = { userId: job.user_id as string, requestId, route: 'hh_runner_worker' };

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

  let lastPartitionDetail: string | null = null;
  const updatePartitionProgress = async (info: PartitionProgress) => {
    const detail = JSON.stringify(info);
    if (detail === lastPartitionDetail) return;
    lastPartitionDetail = detail;
    const { error } = await db
      .from('parser_jobs')
      .update({ progress_detail: info })
      .eq('id', jobId);
    if (error) {
      await logError('parser.hh.partition_detail.update.failed', error, { jobId, searchText, info }, logMeta);
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

  if (startError) {
    await logError('parser.hh.execute.start_failed', startError, { jobId }, logMeta);
    return;
  }

  await logAudit('parser.hh.execute.start', 'HH parser execution started', { jobId, searchText, config }, logMeta);

  const trace = await startTrace({
    name: 'hh.execute',
    input: { jobId, searchText, config, requestId, route: 'hh_runner_worker', userId: job.user_id as string },
    message: `Парсинг HH: ${searchText}`,
    userId: job.user_id as string,
    jobId,
  });

  const shouldCancel = async () => {
    try {
      const { data, error } = await db.from('parser_jobs').select('status').eq('id', jobId).single();
      if (error || !data) return false;
      return data.status !== 'running';
    } catch {
      return false;
    }
  };

  let lastPercent: number | null = 0;

  try {
    await withTimeout(
      (async () => {
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

        await updateStage('partitioning');
        const fetchSpan = await trace?.startChild({
          name: 'hh.fetch_vacancies',
          input: { searchText, config },
          message: 'Загрузка вакансий с HH API',
        });

        let incrementalSaved = 0;
        const { found, vacancies } = await fetchVacancies(fetchParam, {
          jobId,
          logMeta,
          searchText,
          trace,
          collectionMode,
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
          onPartitionProgress: (info) => {
            void updatePartitionProgress(info);
          },
          onBatch: async (batch) => {
            const rows = batch.map((v) => toDbRow(jobId, v));
            const { error } = await db.from('hh_vacancies').upsert(rows, { onConflict: 'job_id,vacancy_id' });
            if (error) {
              await logError('parser.hh.incremental_upsert.failed', error, { jobId, searchText, batchSize: rows.length }, logMeta);
            } else {
              incrementalSaved += rows.length;
            }
          },
        });

        const employersTotal = new Set(
          vacancies.map((vacancy) => vacancy.employer_id).filter((id): id is string => Boolean(id)),
        ).size;
        await updateProgress({ found, parsed: vacancies.length, employersTotal, employersDone: employersTotal }, true);
        await fetchSpan?.end(
          { found, fetched: vacancies.length, uniqueEmployers: employersTotal },
          `Загружено ${vacancies.length} вакансий из ${found} найденных`,
        );
        await logInfo('parser.hh.fetch.completed', 'HH vacancies fetched', { jobId, searchText, found, fetched: vacancies.length }, logMeta);

        await updateStage('saving');
        const saveSpan = await trace?.startChild({
          name: 'hh.save_to_db',
          input: { rows: vacancies.length, incrementalSaved },
          message: 'Сохранение в базу данных (финальный upsert с деталями работодателей)',
        });

        const rows = vacancies.map((v) => toDbRow(jobId, v));
        await updateProgress({ savedTotal: rows.length, savedDone: 0 }, true);
        await logInfo('parser.hh.upsert.start', 'HH vacancies upsert started', { jobId, searchText, rows: rows.length, incrementalSaved }, logMeta);
        await upsertInBatches(db, rows, (saved, total) =>
          updateProgress({ savedTotal: total, savedDone: saved }, saved === total),
        );
        await saveSpan?.end({ savedRows: rows.length }, `Сохранено ${rows.length} записей`);
        await logInfo('parser.hh.upsert.completed', 'HH vacancies upsert completed', { jobId, searchText }, logMeta);

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
            progress_detail: null,
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
        await logAudit('parser.hh.execute.completed', 'HH parser execution completed', {
          jobId, searchText, found, parsed: vacancies.length, elapsed_ms: Date.now() - startedAt,
        }, logMeta);
      })(),
      drainTimeoutMs,
      () => new ParserJobCancelledError('Job timed out'),
    );
  } catch (err: unknown) {
    if (err instanceof ParserJobCancelledError) {
      await updateStage('cancelled');
      const { data: currentStatusRow } = await db.from('parser_jobs').select('status').eq('id', jobId).single();
      const currentStatus = String((currentStatusRow as { status?: unknown } | null)?.status ?? '');

      // Deployment pause flow: running -> pending should not fail the job.
      if (currentStatus === 'pending') {
        await db
          .from('parser_jobs')
          .update({
            status: 'pending',
            completed_at: null,
            error_message: null,
            progress_percent: lastPercent ?? null,
          })
          .eq('id', jobId);
        await trace?.cancel('Пауза на время технических работ. Задача автоматически продолжится после деплоя.');
        await logAudit(
          'parser.hh.execute.paused',
          'HH parser execution paused for deploy',
          { jobId, searchText, progress_percent: lastPercent ?? null },
          logMeta,
        );
        return;
      }

      const timeoutLabel = drainTimeoutMs >= 3_600_000
        ? `${Math.round(drainTimeoutMs / 3_600_000)} ч.`
        : `${Math.round(drainTimeoutMs / 60_000)} мин.`;
      const message = err.message === 'Job timed out'
        ? `Задача превысила лимит времени выполнения (${timeoutLabel}). Пожалуйста, попробуйте запустить парсинг еще раз.`
        : 'Задача отменена пользователем';
      await trace?.cancel(message);
      await logAudit('parser.hh.execute.cancelled', 'HH parser execution cancelled', { jobId, searchText, message }, logMeta);
      const { error: updateError } = await db
        .from('parser_jobs')
        .update({
          status: 'failed',
          completed_at: new Date().toISOString(),
          error_message: message,
          progress_percent: lastPercent ?? null,
          progress_stage: 'failed',
          progress_detail: null,
        })
        .eq('id', jobId);
      if (updateError) {
        await logError('parser.hh.execute.update_failed_on_cancel', updateError, { jobId, searchText, message }, logMeta);
      }
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
        progress_detail: null,
      })
      .eq('id', jobId);

    await trace?.fail(err, extra);
    await logError('parser.hh.execute.failed', err, {
      jobId, searchText, elapsed_ms: Date.now() - startedAt, message, ...(extra ?? {}),
    }, logMeta);
  }
}
