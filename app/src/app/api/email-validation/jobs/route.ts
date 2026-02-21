import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeEmail, checkSyntax } from '@/lib/emailValidation/shared';

export const dynamic = 'force-dynamic';

type EnqueueRow = { rowIndex: number; email: string };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function POST(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);
    if (!supabaseAdmin) return jsonError('Server misconfigured: missing service role key', 500);

    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    let body: { rows?: EnqueueRow[] };
    try {
      body = (await req.json()) as { rows?: EnqueueRow[] };
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

    // Block if user already has an active validation job
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

    const now = new Date().toISOString();
    let invalidCount = 0;

    const queueItems = rows.map((row) => {
      const rawEmail = String(row.email ?? '').trim();
      const normalized = normalizeEmail(rawEmail);
      let status: 'pending' | 'failed' = 'pending';
      let lastError: string | null = null;
      let result: string | null = null;
      let quality: string | null = null;

      if (!rawEmail) {
        status = 'failed';
        lastError = 'Пустой email';
        result = 'invalid';
        quality = 'bad';
        invalidCount += 1;
      } else if (!normalized) {
        status = 'failed';
        lastError = 'Невалидный формат';
        result = 'invalid';
        quality = 'bad';
        invalidCount += 1;
      } else {
        const syntaxCheck = checkSyntax(normalized);
        if (!syntaxCheck.valid) {
          status = 'failed';
          lastError = syntaxCheck.error ?? 'Невалидный формат';
          result = 'invalid';
          quality = 'bad';
          invalidCount += 1;
        }
      }

      return {
        job_id: '',
        user_id: user.id,
        row_index: row.rowIndex,
        email_raw: rawEmail,
        email_normalized: normalized || rawEmail.toLowerCase(),
        status,
        last_error: lastError,
        result,
        quality,
        attempt_count: 0,
        created_at: now,
        updated_at: now,
        completed_at: status === 'failed' ? now : null,
      };
    });

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

    const batchSize = 500;
    for (let i = 0; i < itemsToInsert.length; i += batchSize) {
      const batch = itemsToInsert.slice(i, i + batchSize);
      const { error } = await supabaseAdmin.from('email_validation_queue').insert(batch);
      if (error) {
        return jsonError(error.message, 500);
      }
    }

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
