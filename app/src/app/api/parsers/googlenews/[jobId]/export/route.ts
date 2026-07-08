import { NextResponse, type NextRequest } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/parsers/googleParsersRouteAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { newsToCsv } from '@/lib/parsers/googleParsersExport';

export const dynamic = 'force-dynamic';

const PAGE = 5000;

type NewsResultRow = {
  query: string | null;
  position: number | null;
  title: string | null;
  body: string | null;
  posted: string | null;
  source: string | null;
  link: string | null;
  created_at?: string;
};

export async function GET(req: NextRequest, ctx: { params: Promise<{ jobId: string }> }) {
  const auth = await authenticateRequest(req);
  if (auth.error) return auth.error;
  const { supabase } = auth;

  if (!supabaseAdmin) return jsonError('Service unavailable', 503);

  const { jobId } = await ctx.params;
  const format = (req.nextUrl.searchParams.get('format') ?? 'csv').toLowerCase();

  // Ownership check respects RLS.
  const { data: job, error: jobError } = await supabase
    .from('google_news_jobs')
    .select('id')
    .eq('id', jobId)
    .maybeSingle();
  if (jobError) return jsonError(jobError.message, 500);
  if (!job) return jsonError('Not found', 404);

  // Load ALL results — pagination through the ranges to avoid Supabase's cap.
  const rows: NewsResultRow[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from('google_news_results')
      .select('*')
      .eq('job_id', jobId)
      .order('created_at', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) return jsonError(error.message, 500);
    if (!data || data.length === 0) break;
    rows.push(...(data as NewsResultRow[]));
    if (data.length < PAGE) break;
    offset += data.length;
  }

  if (format === 'json') {
    return new NextResponse(JSON.stringify(rows), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="google-news-${jobId}.json"`,
      },
    });
  }

  const results = rows.map((r) => ({
    query: r.query ?? '',
    position: r.position ?? 0,
    title: r.title ?? '',
    body: r.body ?? '',
    posted: r.posted ?? '',
    source: r.source ?? '',
    link: r.link ?? '',
  }));
  const bom = '﻿';
  const csv = bom + newsToCsv(results);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="google-news-${jobId}.csv"`,
    },
  });
}
