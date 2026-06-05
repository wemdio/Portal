import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { extractNormalizedUrls, normalizeUrl } from '@/lib/enrich/websiteParser';
import { ALL_EXTRACTOR_KEYS, ExtractorKey } from '@/lib/enrich/extractors/types';

export const dynamic = 'force-dynamic';

type EnqueueRow = { rowIndex: number; url: string };

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(req: NextRequest) {
  try {
    const token = getBearerToken(req.headers.get('authorization'));
    if (!token) return jsonError('Unauthorized', 401);
    if (!supabaseAdmin) return jsonError('Server misconfigured', 500);

    const supabase = createAuthedSupabaseClient(token);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return jsonError('Unauthorized', 401);

    const url = new URL(req.url);
    const typeFilter = url.searchParams.get('extraction_type');

    let query = supabaseAdmin
      .from('website_enrichment_jobs')
      .select('id, status, extraction_type, total, processed, created_at, spreadsheet_tab_id, result_col_index, result_col_header, result_col_index_2, result_col_header_2, extractors, extra_cols')
      .eq('user_id', user.id)
      .in('status', ['pending', 'running']);
    if (typeFilter && ['text', 'email', 'signals'].includes(typeFilter)) {
      query = query.eq('extraction_type', typeFilter);
    }
    const { data: jobs } = await query
      .order('created_at', { ascending: false })
      .limit(1);

    const activeJob = (jobs ?? [])[0] as {
      id: string; status: string; extraction_type: string;
      total: number; processed: number;
      created_at: string;
      spreadsheet_tab_id: string | null;
      result_col_index: number | null;
      result_col_header: string | null;
      result_col_index_2: number | null;
      result_col_header_2: string | null;
      extractors: string[] | null;
      extra_cols: unknown;
    } | undefined;

    if (!activeJob) {
      return NextResponse.json({ active_job: null });
    }

    const progress = activeJob.total > 0
      ? Math.round((activeJob.processed / activeJob.total) * 100)
      : 0;

    // Validate extra_cols defensively: never trust DB JSON to round-trip
    // exactly the shape the UI expects (e.g. a manual SQL edit could leave
    // garbage). Drop entries that don't have all required fields.
    const extraColsValidated: Array<{ key: ExtractorKey; colIndex: number; header: string }> | null =
      Array.isArray(activeJob.extra_cols)
        ? (activeJob.extra_cols as unknown[])
            .map((entry): { key: ExtractorKey; colIndex: number; header: string } | null => {
              if (!entry || typeof entry !== 'object') return null;
              const k = (entry as { key?: unknown }).key;
              const c = (entry as { colIndex?: unknown }).colIndex;
              const h = (entry as { header?: unknown }).header;
              if (typeof k !== 'string' || !(ALL_EXTRACTOR_KEYS as string[]).includes(k)) return null;
              if (typeof c !== 'number' || !Number.isFinite(c) || c < 0) return null;
              if (typeof h !== 'string') return null;
              return { key: k as ExtractorKey, colIndex: c, header: h };
            })
            .filter((x): x is { key: ExtractorKey; colIndex: number; header: string } => x !== null)
        : null;

    return NextResponse.json({
      active_job: {
        id: activeJob.id,
        extraction_type: activeJob.extraction_type,
        total: activeJob.total,
        processed: activeJob.processed,
        progress,
        // Нужно UI'ю чтобы показать «Процесс начат в HH:MM»
        // при resume'е (когда пользователь закрыл и вернулся).
        created_at: activeJob.created_at,
        spreadsheet_tab_id: activeJob.spreadsheet_tab_id,
        result_col_index: activeJob.result_col_index,
        result_col_header: activeJob.result_col_header,
        result_col_index_2: activeJob.result_col_index_2,
        result_col_header_2: activeJob.result_col_header_2,
        extractors: activeJob.extractors,
        extra_cols: extraColsValidated,
      },
    });
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

    let body: {
      rows?: EnqueueRow[];
      extraction_type?: string;
      spreadsheet_tab_id?: string;
      result_col_index?: number;
      result_col_header?: string;
      result_col_index_2?: number;
      result_col_header_2?: string;
      extractors?: unknown;
      extra_cols?: unknown;
    };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return jsonError('Invalid JSON body', 400);
    }

    const extractionType: 'text' | 'email' | 'signals' =
      body.extraction_type === 'email'
        ? 'email'
        : body.extraction_type === 'signals'
          ? 'signals'
          : 'text';

    if (extractionType === 'signals' && body.result_col_index_2 == null) {
      return jsonError('result_col_index_2 (Profile column) is required for signals extraction', 400);
    }

    // Validate optional per-extractor configuration. Whitelist enforces that
    // unknown keys are silently dropped (defensive — don't fail the job for
    // a typo in the UI; just process the recognized subset).
    const extractorsValidated: ExtractorKey[] | null =
      Array.isArray(body.extractors)
        ? (body.extractors.filter(
            (k): k is ExtractorKey => typeof k === 'string' && (ALL_EXTRACTOR_KEYS as string[]).includes(k),
          ) as ExtractorKey[])
        : null;

    const extraColsValidated: Array<{ key: ExtractorKey; colIndex: number; header: string }> | null =
      Array.isArray(body.extra_cols)
        ? body.extra_cols
            .map((entry): { key: ExtractorKey; colIndex: number; header: string } | null => {
              if (!entry || typeof entry !== 'object') return null;
              const key = (entry as { key?: unknown }).key;
              const colIndex = (entry as { colIndex?: unknown }).colIndex;
              const header = (entry as { header?: unknown }).header;
              if (typeof key !== 'string' || !(ALL_EXTRACTOR_KEYS as string[]).includes(key)) return null;
              if (typeof colIndex !== 'number' || !Number.isFinite(colIndex) || colIndex < 0) return null;
              if (typeof header !== 'string') return null;
              return { key: key as ExtractorKey, colIndex, header };
            })
            .filter((x): x is { key: ExtractorKey; colIndex: number; header: string } => x !== null)
        : null;

    const rows = body.rows ?? [];
    if (!Array.isArray(rows) || rows.length === 0) {
      return jsonError('No rows provided', 400);
    }
    if (rows.length > 50_000) {
      return jsonError('Too many rows (max 50k)', 400);
    }

    const now = new Date().toISOString();

    // Block if user already has an active job of THE SAME extraction_type.
    // Different types (text + email + signals) can run concurrently in their own queues.
    const { data: existingJobs, error: existingJobsError } = await supabaseAdmin
      .from('website_enrichment_jobs')
      .select('id, status, extraction_type, total, processed, created_at')
      .eq('user_id', user.id)
      .eq('extraction_type', extractionType)
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
      const typeLabel =
        activeJob.extraction_type === 'email'
          ? 'Поиск почт'
          : activeJob.extraction_type === 'signals'
            ? 'Сигналы с сайтов'
            : 'Обогащение с сайта';
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
          normalized = extractionType === 'email'
            ? extractNormalizedUrls(rawUrl)[0] ?? ''
            : normalizeUrl(rawUrl);
          if (!normalized) {
            throw new Error('Невалидный URL');
          }
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
        spreadsheet_tab_id: body.spreadsheet_tab_id ?? null,
        result_col_index: body.result_col_index ?? null,
        result_col_header: body.result_col_header ?? null,
        result_col_index_2: body.result_col_index_2 ?? null,
        result_col_header_2: body.result_col_header_2 ?? null,
        extractors: extractorsValidated && extractorsValidated.length > 0 ? extractorsValidated : null,
        extra_cols: extraColsValidated && extraColsValidated.length > 0 ? extraColsValidated : null,
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
