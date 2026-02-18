import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { normalizeUrl } from '@/lib/enrich/websiteParser';
import { runWebsiteEnrichmentJob } from '@/lib/enrich/websiteEnrichmentWorker';

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

    let body: { rows?: EnqueueRow[]; extraction_type?: string };
    try {
      body = (await req.json()) as { rows?: EnqueueRow[]; extraction_type?: string };
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    const extractionType = body.extraction_type === 'email' ? 'email' : 'text';
    const rows = body.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return jsonError('No rows provided', 400);
    }
    if (rows.length > 50_000) {
      return jsonError('Too many rows (max 50k)', 400);
    }

    const now = new Date().toISOString();

    // Block if user already has an active enrichment job (don't silently cancel).
    const { data: existingJobs, error: existingJobsError } = await supabaseAdmin
      .from('website_enrichment_jobs')
      .select('id, status, extraction_type, total, processed, created_at')
      .eq('user_id', user.id)
      .in('status', ['pending', 'running'])
      .order('created_at', { ascending: false })
      .limit(1);

    if (existingJobsError) {
      return jsonError(existingJobsError.message, 500);
    }

    const activeJob = (existingJobs ?? [])[0] as {
      id: string;
      status: string;
      extraction_type: string;
      total: number;
      processed: number;
      created_at: string;
    } | undefined;

    if (activeJob) {
      const typeLabel = activeJob.extraction_type === 'email' ? 'Поиск почт' : 'Обогащение с сайта';
      const progress = activeJob.total > 0
        ? Math.round((activeJob.processed / activeJob.total) * 100)
        : 0;
      return NextResponse.json(
        {
          error: `У вас уже выполняется задача: «${typeLabel}» (${progress}% — ${activeJob.processed}/${activeJob.total}). Дождитесь её завершения или остановите вручную.`,
          active_job: {
            id: activeJob.id,
            extraction_type: activeJob.extraction_type,
            total: activeJob.total,
            processed: activeJob.processed,
            progress,
          },
        },
        { status: 409 },
      );
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
        extraction_type: extractionType,
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
