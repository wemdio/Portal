import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getWebsiteInnLookupUser } from '@/lib/enrich/websiteInnLookupAuth';
import { publishWebsiteInnLookupJob } from '@/lib/enrich/websiteInnLookupJobPublisher';
import {
  validateWebsiteInnLookupCreateBody,
  type WebsiteInnLookupCreateBody,
} from '@/lib/enrich/websiteInnLookupRequest';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const JOB_LIST_LIMIT = 10;

type ApiJobRow = {
  id: string;
  status: string;
  tab_id: string;
  url_column: number;
  inn_column: number;
  company_column: number;
  total: number;
  processed: number;
  found: number;
  error_message: string | null;
  results_applied_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

const JOB_FIELDS = [
  'id',
  'status',
  'tab_id',
  'url_column',
  'inn_column',
  'company_column',
  'total',
  'processed',
  'found',
  'error_message',
  'results_applied_at',
  'created_at',
  'started_at',
  'completed_at',
].join(', ');

export async function GET(req: NextRequest) {
  const user = await getWebsiteInnLookupUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data, error } = await supabaseAdmin
    .from('website_inn_lookup_jobs')
    .select(JOB_FIELDS)
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(JOB_LIST_LIMIT);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const jobs = (data ?? []) as unknown as ApiJobRow[];
  const activeJob = jobs.find(
    (job) => ['preparing', 'pending', 'running'].includes(job.status),
  ) ?? null;
  const unappliedJob = jobs.find(
    (job) => ['completed', 'cancelled', 'failed'].includes(job.status) && !job.results_applied_at,
  ) ?? null;
  const latestTerminalJob = jobs.find(
    (job) => ['completed', 'cancelled', 'failed'].includes(job.status),
  ) ?? null;
  return NextResponse.json({
    jobs,
    active_job: activeJob,
    unapplied_job: unappliedJob,
    latest_terminal_job: latestTerminalJob,
  });
}

export async function POST(req: NextRequest) {
  const user = await getWebsiteInnLookupUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  const db = supabaseAdmin;

  const { data: active, error: activeError } = await db
    .from('website_inn_lookup_jobs')
    .select(JOB_FIELDS)
    .eq('user_id', user.id)
    .in('status', ['preparing', 'pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (activeError) return NextResponse.json({ error: activeError.message }, { status: 500 });
  if (active) {
    return NextResponse.json(
      { error: 'Поиск ИНН уже выполняется', active_job: active },
      { status: 409 },
    );
  }

  let body: WebsiteInnLookupCreateBody;
  try {
    body = (await req.json()) as WebsiteInnLookupCreateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const validation = validateWebsiteInnLookupCreateBody(body);
  if (!validation.ok) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }
  const { tabId, urlColumn, innColumn, companyColumn, items } = validation.value;

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    const job = await publishWebsiteInnLookupJob<ApiJobRow>(
      {
        id: jobId,
        total: items.length,
        user_id: user.id,
        tab_id: tabId,
        url_column: urlColumn,
        inn_column: innColumn,
        company_column: companyColumn,
      },
      items,
      {
        async createPreparingJob(payload) {
          const { data, error } = await db
            .from('website_inn_lookup_jobs')
            .insert({
              ...payload,
              status: 'preparing',
              processed: 0,
              found: 0,
              updated_at: now,
            })
            .select('id')
            .single();
          if (error || !data) {
            const publishError = new Error(error?.message ?? 'Не удалось создать задачу') as Error & {
              code?: string;
            };
            publishError.code = error?.code;
            throw publishError;
          }
          return data;
        },
        async insertItems(preparingJobId, chunk) {
          const heartbeatAt = new Date().toISOString();
          const { error } = await db
            .from('website_inn_lookup_items')
            .insert(chunk.map((item) => ({
              job_id: preparingJobId,
              row_index: item.row_index,
              url: item.url,
              status: 'pending',
              updated_at: heartbeatAt,
            })));
          if (error) throw new Error(error.message);
          const { error: heartbeatError } = await db
            .from('website_inn_lookup_jobs')
            .update({ updated_at: heartbeatAt })
            .eq('id', preparingJobId)
            .eq('status', 'preparing');
          if (heartbeatError) throw new Error(heartbeatError.message);
        },
        async countItems(preparingJobId) {
          const { count, error } = await db
            .from('website_inn_lookup_items')
            .select('id', { count: 'exact', head: true })
            .eq('job_id', preparingJobId);
          if (error) throw new Error(error.message);
          return count ?? 0;
        },
        async publishJob(preparingJobId) {
          const publishedAt = new Date().toISOString();
          const { data, error } = await db
            .from('website_inn_lookup_jobs')
            .update({ status: 'pending', updated_at: publishedAt })
            .eq('id', preparingJobId)
            .eq('status', 'preparing')
            .select(JOB_FIELDS)
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!data) throw new Error('Задача перестала находиться в подготовке');
          return data as unknown as ApiJobRow;
        },
        async failPreparingJob(preparingJobId, message) {
          const failedAt = new Date().toISOString();
          const { error } = await db
            .from('website_inn_lookup_jobs')
            .update({
              status: 'failed',
              error_message: message,
              completed_at: failedAt,
              updated_at: failedAt,
            })
            .eq('id', preparingJobId)
            .eq('status', 'preparing');
          if (error) throw new Error(error.message);
        },
      },
    );
    return NextResponse.json({ job }, { status: 201 });
  } catch (error) {
    const code = (error as Error & { code?: string }).code;
    if (code === '23505') {
      const { data: racedActive } = await db
        .from('website_inn_lookup_jobs')
        .select(JOB_FIELDS)
        .eq('user_id', user.id)
        .in('status', ['preparing', 'pending', 'running'])
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      return NextResponse.json(
        { error: 'Поиск ИНН уже выполняется', active_job: racedActive ?? null },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
