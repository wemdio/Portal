import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getWebsiteInnLookupUser } from '@/lib/enrich/websiteInnLookupAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const MAX_RESULT_PAGE = 500;
type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: Context) {
  const user = await getWebsiteInnLookupUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { id } = await context.params;
  const { data: job, error: jobError } = await supabaseAdmin
    .from('website_inn_lookup_jobs')
    .select(
      'id, user_id, status, tab_id, url_column, inn_column, company_column, total, processed, found, error_message, results_applied_at',
    )
    .eq('id', id)
    .maybeSingle();
  if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });
  if (!job || job.user_id !== user.id) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const url = new URL(req.url);
  const afterRowIndex = Math.max(0, Number(url.searchParams.get('afterRowIndex') ?? '0') || 0);
  const limit = Math.max(1, Math.min(MAX_RESULT_PAGE, Number(url.searchParams.get('limit') ?? '500') || 500));
  const { data: results, error: resultsError } = await supabaseAdmin
    .from('website_inn_lookup_items')
    .select('id, row_index, url, status, inn, company_name, error_message')
    .eq('job_id', id)
    .in('status', ['completed', 'failed'])
    .gt('row_index', afterRowIndex)
    .order('row_index', { ascending: true })
    .limit(limit);
  if (resultsError) return NextResponse.json({ error: resultsError.message }, { status: 500 });

  const safeJob = { ...job };
  delete (safeJob as { user_id?: string }).user_id;
  const nextRowIndex = results?.length ? results[results.length - 1].row_index : null;
  return NextResponse.json({ job: safeJob, results: results ?? [], next_row_index: nextRowIndex });
}
