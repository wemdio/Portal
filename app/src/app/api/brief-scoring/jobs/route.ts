import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

type EnqueueRow = { idx: number; data: Record<string, string> };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
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

    let body: { briefText?: string; companies?: EnqueueRow[] };
    try {
      body = (await req.json()) as { briefText?: string; companies?: EnqueueRow[] };
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    const briefText = String(body.briefText ?? '').trim();
    const companies = body.companies ?? [];

    if (!briefText) return jsonError('Missing required field: briefText', 400);
    if (!Array.isArray(companies) || companies.length === 0) {
      return jsonError('Missing required field: companies (non-empty array)', 400);
    }
    if (companies.length > 100_000) {
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
    let invalidCount = 0;

    const queueItems = companies.map((row, index) => {
      const idx = Number(row.idx);
      const rowIndex = Number.isFinite(idx) && idx >= 0 ? Math.trunc(idx) : -1;
      const rawData = row.data && typeof row.data === 'object' ? row.data : {};
      const normalizedData = Object.entries(rawData).reduce<Record<string, string>>((acc, [key, raw]) => {
        const value = String(raw ?? '').trim();
        if (value.length > 0) acc[key] = value;
        return acc;
      }, {});

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
        user_id: user.id,
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

    const { data: job, error: jobError } = await supabaseAdmin
      .from('brief_scoring_jobs')
      .insert({
        user_id: user.id,
        status: 'pending',
        brief_text: briefText,
        total: companies.length,
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
      const { error } = await supabaseAdmin.from('brief_scoring_queue').insert(batch);
      if (error) return jsonError(error.message, 500);
    }

    return NextResponse.json({
      job_id: jobId,
      total: companies.length,
      processed: invalidCount,
      error_count: invalidCount,
    });
  } catch (err) {
    return jsonError(err instanceof Error ? err.message : 'Internal error', 500);
  }
}

