import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeUrl } from '@/lib/enrich/websiteParser';
import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';
import { extractActiveJobIds } from '@/lib/enrich/jobLifecycle';

export const dynamic = 'force-dynamic';

type EnqueueRow = { rowIndex: number; url: string };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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
    if (rows.length > 50_000) {
      return jsonError('Too many rows (max 50k)', 400);
    }

    const now = new Date().toISOString();

    // Ensure only one active enrichment per user to avoid stale parallel jobs.
    const { data: existingJobs, error: existingJobsError } = await supabaseAdmin
      .from('website_enrichment_jobs')
      .select('id, status')
      .eq('user_id', user.id)
      .in('status', ['pending', 'running']);

    if (existingJobsError) {
      return jsonError(existingJobsError.message, 500);
    }

    const activeJobIds = extractActiveJobIds((existingJobs ?? []) as Array<{ id: string; status: string | null }>);
    if (activeJobIds.length > 0) {
      const cancelledAt = new Date().toISOString();
      const stopReason = 'Операция остановлена: запущено новое обогащение';

      const { error: cancelJobsError } = await supabaseAdmin
        .from('website_enrichment_jobs')
        .update({
          status: 'cancelled',
          completed_at: cancelledAt,
          error_message: stopReason,
        })
        .in('id', activeJobIds);

      if (cancelJobsError) {
        return jsonError(cancelJobsError.message, 500);
      }

      const { error: cancelQueueError } = await supabaseAdmin
        .from('website_enrichment_queue')
        .update({
          status: 'failed',
          result_text: null,
          last_error: stopReason,
          updated_at: cancelledAt,
          completed_at: cancelledAt,
        })
        .in('job_id', activeJobIds)
        .in('status', ['pending', 'processing']);

      if (cancelQueueError) {
        return jsonError(cancelQueueError.message, 500);
      }
    }

    let invalidCount = 0;

    const queueItems = rows.map((row) => {
      const rawUrl = String(row.url ?? '').trim();
      let normalized = '';
      let status: 'pending' | 'failed' = 'pending';
      let lastError: string | null = null;

      if (!rawUrl) {
        status = 'failed';
        lastError = 'Пустой URL';
        invalidCount += 1;
      } else {
        try {
          normalized = normalizeUrl(rawUrl);
        } catch (err) {
          status = 'failed';
          lastError = err instanceof Error ? err.message : 'Невалидный URL';
          invalidCount += 1;
        }
      }

      return {
        job_id: '', // set later
        user_id: user.id,
        row_index: row.rowIndex,
        url_raw: rawUrl,
        url_normalized: normalized || rawUrl,
        status,
        last_error: lastError,
        attempt_count: 0,
        result_text: null,
        created_at: now,
        updated_at: now,
        completed_at: status === 'failed' ? now : null,
      };
    });

    const { data: job, error: jobError } = await supabaseAdmin
      .from('website_enrichment_jobs')
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
      const { error } = await supabaseAdmin.from('website_enrichment_queue').insert(batch);
      if (error) {
        return jsonError(error.message, 500);
      }
    }

    // Start background worker (non-blocking)
    void runWebsiteEnrichmentJob(jobId);

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
