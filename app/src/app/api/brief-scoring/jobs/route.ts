import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type EnqueueRow = { idx: number; data: Record<string, string> };
type BriefScoringJobRequest = {
  briefText?: string;
  companies?: EnqueueRow[];
  total?: number;
  mode?: 'staged';
  job_id?: string;
  finalize?: boolean;
  spreadsheet_tab_id?: string;
  score_col_index?: number;
  reason_col_index?: number;
};

type PreparedQueueItem = {
  job_id: string;
  user_id: string;
  row_index: number;
  company_data: Record<string, string>;
  status: 'pending' | 'failed';
  attempt_count: number;
  score: null;
  reason: null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

const MAX_FIELDS_PER_COMPANY = 20;
const MAX_CHARS_PER_FIELD = 280;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function prepareQueueItems(
  companies: EnqueueRow[],
  userId: string,
  now: string,
): { items: PreparedQueueItem[]; invalidCount: number } {
  let invalidCount = 0;
  const items = companies.map((row, index) => {
    const idx = Number(row.idx);
    const rowIndex = Number.isFinite(idx) && idx >= 0 ? Math.trunc(idx) : -1;
    const rawData = row.data && typeof row.data === 'object' ? row.data : {};
    const normalizedData: Record<string, string> = {};
    let fieldsAdded = 0;
    for (const [key, raw] of Object.entries(rawData)) {
      if (fieldsAdded >= MAX_FIELDS_PER_COMPANY) break;
      const value = String(raw ?? '').trim();
      if (value.length === 0) continue;
      const safeValue = value.length > MAX_CHARS_PER_FIELD ? value.slice(0, MAX_CHARS_PER_FIELD) : value;
      normalizedData[key] = safeValue;
      fieldsAdded += 1;
    }

    let status: 'pending' | 'failed' = 'pending';
    let lastError: string | null = null;
    if (rowIndex < 0) {
      status = 'failed';
      lastError = 'Некорректный индекс строки';
      invalidCount += 1;
    } else if (Object.keys(normalizedData).length === 0) {
      status = 'failed';
      lastError = 'Пустые данные строки';
      invalidCount += 1;
    }

    return {
      job_id: '',
      user_id: userId,
      row_index: rowIndex >= 0 ? rowIndex : -(index + 1),
      company_data: normalizedData,
      status,
      attempt_count: 0,
      score: null,
      reason: null,
      last_error: lastError,
      created_at: now,
      updated_at: now,
      completed_at: status === 'failed' ? now : null,
    };
  });

  return { items, invalidCount };
}

export async function GET(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    const activeOnly = new URL(req.url).searchParams.get('active') === '1';
    let query = supabase
      .from('brief_scoring_jobs')
      .select(
        'id, status, total, processed, success_count, error_count, error_message, created_at, started_at, completed_at',
      )
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(activeOnly ? 1 : 20);

    if (activeOnly) query = query.in('status', ['pending', 'running']);
    const { data: jobs, error } = await query;
    if (error) return jsonError(error.message, 500);

    return NextResponse.json({ jobs: jobs ?? [] });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);
    if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

    const supabase = createAuthedSupabaseClient(token);
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    let body: BriefScoringJobRequest;
    try {
      body = (await req.json()) as BriefScoringJobRequest;
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    const isAppendMode = typeof body.job_id === 'string' && body.job_id.trim().length > 0;
    if (isAppendMode) {
      const jobId = String(body.job_id).trim();
      const companies = Array.isArray(body.companies) ? body.companies : [];
      const finalize = Boolean(body.finalize);

      if (companies.length === 0 && !finalize) {
        return jsonError('No rows provided', 400);
      }
      if (companies.length > 20_000) {
        return jsonError('Too many rows in one chunk (max 20k)', 400);
      }

      const { data: existingJob, error: existingJobError } = await supabaseAdmin
        .from('brief_scoring_jobs')
        .select('id, status, total')
        .eq('id', jobId)
        .eq('user_id', user.id)
        .single<{ id: string; status: string; total: number }>();

      if (existingJobError || !existingJob) {
        return jsonError('Job not found', 404);
      }

      if (!['running', 'pending'].includes(existingJob.status)) {
        return jsonError('Job is not accepting rows', 409);
      }

      const now = new Date().toISOString();
      let invalidCount = 0;

      if (companies.length > 0) {
        const prepared = prepareQueueItems(companies, user.id, now);
        invalidCount = prepared.invalidCount;
        const itemsToInsert = prepared.items.map((item) => ({ ...item, job_id: jobId }));

        const batchSize = 500;
        for (let i = 0; i < itemsToInsert.length; i += batchSize) {
          const batch = itemsToInsert.slice(i, i + batchSize);
          const { error } = await supabaseAdmin
            .from('brief_scoring_queue')
            .upsert(batch, { onConflict: 'job_id,row_index', ignoreDuplicates: true });
          if (error) return jsonError(error.message, 500);
        }
      }

      if (finalize) {
        const [{ count: queueCount, error: queueCountError }, { count: failedCount, error: failedCountError }] = await Promise.all([
          supabaseAdmin
            .from('brief_scoring_queue')
            .select('id', { count: 'exact', head: true })
            .eq('job_id', jobId),
          supabaseAdmin
            .from('brief_scoring_queue')
            .select('id', { count: 'exact', head: true })
            .eq('job_id', jobId)
            .eq('status', 'failed'),
        ]);
        if (queueCountError) return jsonError(queueCountError.message, 500);
        if (failedCountError) return jsonError(failedCountError.message, 500);

        const requestedTotal = Number.isFinite(Number(body.total))
          ? Math.max(0, Math.trunc(Number(body.total)))
          : existingJob.total;
        const total = Math.max(requestedTotal, queueCount ?? 0);
        const failed = failedCount ?? 0;

        const { error: finalizeError } = await supabaseAdmin
          .from('brief_scoring_jobs')
          .update({
            status: 'pending',
            total,
            processed: failed,
            success_count: 0,
            error_count: failed,
            started_at: null,
            completed_at: null,
            error_message: null,
          })
          .eq('id', jobId)
          .eq('user_id', user.id);
        if (finalizeError) return jsonError(finalizeError.message, 500);

        return NextResponse.json({
          job_id: jobId,
          total,
          processed: failed,
          error_count: failed,
          finalized: true,
        });
      }

      return NextResponse.json({
        job_id: jobId,
        queued: companies.length,
        invalid_count: invalidCount,
        finalized: false,
      });
    }

    const briefText = String(body.briefText ?? '').trim();
    const companies = body.companies ?? [];
    const isStagedMode = body.mode === 'staged';
    const requestedTotal = Number.isFinite(Number(body.total))
      ? Math.max(0, Math.trunc(Number(body.total)))
      : companies.length;

    if (!briefText) return jsonError('Missing required field: briefText', 400);
    if (isStagedMode && requestedTotal <= 0) {
      return jsonError('Missing required field: total (positive integer)', 400);
    }
    if (!isStagedMode && (!Array.isArray(companies) || companies.length === 0)) {
      return jsonError('Missing required field: companies (non-empty array)', 400);
    }
    if (requestedTotal > 100_000) {
      return jsonError('Too many rows (max 100k)', 400);
    }

    const { data: existingJobs } = await supabaseAdmin
      .from('brief_scoring_jobs')
      .select('id, status, total, processed, created_at')
      .eq('user_id', user.id)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1);

    const activeJob = (existingJobs ?? [])[0] as {
      id: string;
      status: string;
      total: number;
      processed: number;
    } | undefined;

    if (activeJob) {
      const progress = activeJob.total > 0
        ? Math.round((activeJob.processed / activeJob.total) * 100)
        : 0;
      return NextResponse.json(
        {
          error: `У вас уже выполняется оценка ЦА (${progress}% — ${activeJob.processed}/${activeJob.total}). Дождитесь завершения или остановите вручную.`,
          active_job: {
            id: activeJob.id,
            total: activeJob.total,
            processed: activeJob.processed,
            progress,
          },
        },
        { status: 409 },
      );
    }

    const now = new Date().toISOString();
    const prepared = prepareQueueItems(Array.isArray(companies) ? companies : [], user.id, now);
    const invalidCount = prepared.invalidCount;

    const { data: job, error: jobError } = await supabaseAdmin
      .from('brief_scoring_jobs')
      .insert({
        user_id: user.id,
        status: isStagedMode ? 'running' : 'pending',
        brief_text: briefText,
        total: requestedTotal,
        processed: invalidCount,
        success_count: 0,
        error_count: invalidCount,
        created_at: now,
        started_at: isStagedMode ? now : null,
        spreadsheet_tab_id: body.spreadsheet_tab_id ?? null,
        score_col_index: body.score_col_index ?? null,
        reason_col_index: body.reason_col_index ?? null,
      })
      .select('id')
      .single<{ id: string }>();

    if (jobError || !job) {
      return jsonError(jobError?.message ?? 'Failed to create job', 500);
    }

    const jobId = job.id;
    if (!isStagedMode) {
      const itemsToInsert = prepared.items.map((item) => ({ ...item, job_id: jobId }));
      const batchSize = 500;
      for (let i = 0; i < itemsToInsert.length; i += batchSize) {
        const batch = itemsToInsert.slice(i, i + batchSize);
        const { error } = await supabaseAdmin.from('brief_scoring_queue').insert(batch);
        if (error) return jsonError(error.message, 500);
      }
    }

    return NextResponse.json({
      job_id: jobId,
      total: requestedTotal,
      processed: invalidCount,
      error_count: invalidCount,
      staged: isStagedMode,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

