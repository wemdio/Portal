import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeEmail, checkSyntax } from '@/lib/emailValidation/shared';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);
  if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

  const supabase = createAuthedSupabaseClient(token);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { data } = await supabaseAdmin
    .from('email_validation_jobs')
    .select('id, status, total, processed, success_count, error_count, created_at')
    .eq('user_id', user.id)
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1);

  const job = (data ?? [])[0];

  // Последняя завершённая задача — для бэкфилла результатов: если UI умер
  // посреди polling'а (закрытая вкладка, старый watchdog «зависла»), вердикты,
  // записанные воркером после отвала, можно подтянуть в таблицу заново.
  const { data: completed } = await supabaseAdmin
    .from('email_validation_jobs')
    .select('id, status, total, processed, success_count, error_count, completed_at')
    .eq('user_id', user.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false })
    .limit(1);

  const lastCompleted = (completed ?? [])[0] ?? null;

  if (!job) {
    return NextResponse.json({
      active_job: null,
      last_completed_job: lastCompleted
        ? {
            id: lastCompleted.id,
            total: lastCompleted.total,
            processed: lastCompleted.processed,
            success_count: lastCompleted.success_count,
            error_count: lastCompleted.error_count,
            completed_at: lastCompleted.completed_at,
          }
        : null,
    });
  }

  const progress = job.total > 0 ? Math.round((job.processed / job.total) * 100) : 0;
  return NextResponse.json({
    active_job: { id: job.id, status: job.status, total: job.total, processed: job.processed, progress },
    last_completed_job: null,
  });
}

type EnqueueRow = { rowIndex: number; email: string };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function buildQueueItems(
  rows: EnqueueRow[],
  userId: string,
  now: string,
): { items: ReturnType<typeof buildOneItem>[]; invalidCount: number } {
  let invalidCount = 0;
  const items = rows.map((row) => {
    const item = buildOneItem(row, userId, now);
    if (item.status === 'failed') invalidCount += 1;
    return item;
  });
  return { items, invalidCount };
}

function buildOneItem(row: EnqueueRow, userId: string, now: string) {
  const rawEmail = String(row.email ?? '').trim();
  const normalized = normalizeEmail(rawEmail);
  let status: 'pending' | 'failed' = 'pending';
  let lastError: string | null = null;
  let result: string | null = null;
  let quality: string | null = null;

  if (!rawEmail) {
    status = 'failed'; lastError = 'Пустой email'; result = 'invalid'; quality = 'bad';
  } else if (!normalized) {
    status = 'failed'; lastError = 'Невалидный формат'; result = 'invalid'; quality = 'bad';
  } else {
    const syntaxCheck = checkSyntax(normalized);
    if (!syntaxCheck.valid) {
      status = 'failed'; lastError = syntaxCheck.error ?? 'Невалидный формат'; result = 'invalid'; quality = 'bad';
    }
  }

  return {
    job_id: '',
    user_id: userId,
    row_index: row.rowIndex,
    email_raw: rawEmail,
    email_normalized: normalized || rawEmail.toLowerCase(),
    status, last_error: lastError, result, quality,
    attempt_count: 0, created_at: now, updated_at: now,
    completed_at: status === 'failed' ? now : null,
  };
}

async function insertQueueBatches(
  items: { job_id: string }[],
  batchSize = 500,
): Promise<string | null> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const { error } = await supabaseAdmin!.from('email_validation_queue').insert(batch);
    if (error) return error.message;
  }
  return null;
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);
    if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    let body: { rows?: EnqueueRow[]; job_id?: string };
    try {
      body = (await req.json()) as { rows?: EnqueueRow[]; job_id?: string };
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    const rows = body.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return jsonError('No rows provided', 400);
    }
    if (rows.length > 100_000) {
      return jsonError('Too many rows (max 100k)', 400);
    }

    const now = new Date().toISOString();
    const { items: queueItems, invalidCount } = buildQueueItems(rows, user.id, now);

    // Append to existing job
    if (body.job_id) {
      const { data: existing, error: lookupErr } = await supabaseAdmin
        .from('email_validation_jobs')
        .select('id, user_id, total, processed, error_count')
        .eq('id', body.job_id)
        .single<{ id: string; user_id: string; total: number; processed: number; error_count: number }>();

      if (lookupErr || !existing) return jsonError('Job not found', 404);
      if (existing.user_id !== user.id) return jsonError('Unauthorized', 403);

      const itemsToInsert = queueItems.map((item) => ({ ...item, job_id: existing.id }));
      const insertErr = await insertQueueBatches(itemsToInsert);
      if (insertErr) return jsonError(insertErr, 500);

      await supabaseAdmin
        .from('email_validation_jobs')
        .update({
          total: existing.total + rows.length,
          processed: existing.processed + invalidCount,
          error_count: existing.error_count + invalidCount,
        })
        .eq('id', existing.id);

      return NextResponse.json({
        job_id: existing.id,
        total: existing.total + rows.length,
        processed: existing.processed + invalidCount,
        error_count: existing.error_count + invalidCount,
      });
    }

    // Create new job
    const { data: existingJobs } = await supabaseAdmin
      .from('email_validation_jobs')
      .select('id, status, total, processed, created_at')
      .eq('user_id', user.id)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1);

    const activeJob = (existingJobs ?? [])[0] as {
      id: string; status: string; total: number; processed: number;
    } | undefined;

    if (activeJob) {
      const progress = activeJob.total > 0
        ? Math.round((activeJob.processed / activeJob.total) * 100) : 0;
      return NextResponse.json(
        {
          error: `У вас уже выполняется валидация почт (${progress}% — ${activeJob.processed}/${activeJob.total}). Дождитесь завершения или остановите вручную.`,
          active_job: { id: activeJob.id, total: activeJob.total, processed: activeJob.processed, progress },
        },
        { status: 409 },
      );
    }

    const { data: job, error: jobError } = await supabaseAdmin
      .from('email_validation_jobs')
      .insert({
        user_id: user.id,
        status: 'pending',
        total: rows.length,
        processed: invalidCount,
        success_count: 0,
        error_count: invalidCount,
        created_at: now,
      })
      .select('id')
      .single<{ id: string }>();

    if (jobError || !job) {
      return jsonError(jobError?.message ?? 'Failed to create job', 500);
    }

    const jobId = job.id;
    const itemsToInsert = queueItems.map((item) => ({ ...item, job_id: jobId }));
    const insertErr = await insertQueueBatches(itemsToInsert);
    if (insertErr) return jsonError(insertErr, 500);

    return NextResponse.json({
      job_id: jobId,
      total: rows.length,
      processed: invalidCount,
      error_count: invalidCount,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}
