import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { getWebsiteInnLookupUser } from '@/lib/enrich/websiteInnLookupAuth';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

const MAX_ITEMS_PER_JOB = 50_000;
const INSERT_CHUNK_SIZE = 500;
const JOB_LIST_LIMIT = 10;

type CreateItem = { rowIndex?: number; url?: string };
type CreateBody = {
  tabId?: string;
  urlColumn?: number;
  innColumn?: number;
  companyColumn?: number;
  items?: CreateItem[];
};

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
  const activeJob = jobs.find((job) => ['pending', 'running'].includes(job.status)) ?? null;
  const unappliedJob = jobs.find(
    (job) => ['completed', 'cancelled', 'failed'].includes(job.status) && !job.results_applied_at,
  ) ?? null;
  return NextResponse.json({ jobs, active_job: activeJob, unapplied_job: unappliedJob });
}

export async function POST(req: NextRequest) {
  const user = await getWebsiteInnLookupUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  if (!supabaseAdmin) return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });

  const { data: active, error: activeError } = await supabaseAdmin
    .from('website_inn_lookup_jobs')
    .select(JOB_FIELDS)
    .eq('user_id', user.id)
    .in('status', ['pending', 'running'])
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

  let body: CreateBody;
  try {
    body = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const tabId = typeof body.tabId === 'string' ? body.tabId.trim() : '';
  const columns = [body.urlColumn, body.innColumn, body.companyColumn];
  if (!tabId || columns.some((value) => !Number.isInteger(value) || Number(value) < 0)) {
    return NextResponse.json({ error: 'Некорректная вкладка или колонки' }, { status: 400 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'Нет сайтов для обработки' }, { status: 400 });
  }
  if (body.items.length > MAX_ITEMS_PER_JOB) {
    return NextResponse.json(
      { error: `Максимум ${MAX_ITEMS_PER_JOB} сайтов за один запуск` },
      { status: 400 },
    );
  }

  const seenRows = new Set<number>();
  const items: Array<{ row_index: number; url: string }> = [];
  for (const raw of body.items) {
    const rowIndex = Number(raw.rowIndex);
    const url = typeof raw.url === 'string' ? raw.url.trim() : '';
    if (!Number.isInteger(rowIndex) || rowIndex <= 0 || !url || seenRows.has(rowIndex)) {
      return NextResponse.json({ error: 'Некорректный список сайтов' }, { status: 400 });
    }
    seenRows.add(rowIndex);
    items.push({ row_index: rowIndex, url });
  }

  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const { data: job, error: jobError } = await supabaseAdmin
    .from('website_inn_lookup_jobs')
    .insert({
      id: jobId,
      user_id: user.id,
      status: 'pending',
      tab_id: tabId,
      url_column: body.urlColumn,
      inn_column: body.innColumn,
      company_column: body.companyColumn,
      total: items.length,
      processed: 0,
      found: 0,
      updated_at: now,
    })
    .select(JOB_FIELDS)
    .single();

  if (jobError) {
    const conflict = jobError.code === '23505';
    return NextResponse.json(
      { error: conflict ? 'Поиск ИНН уже выполняется' : jobError.message },
      { status: conflict ? 409 : 500 },
    );
  }

  for (let offset = 0; offset < items.length; offset += INSERT_CHUNK_SIZE) {
    const chunk = items.slice(offset, offset + INSERT_CHUNK_SIZE).map((item) => ({
      job_id: jobId,
      row_index: item.row_index,
      url: item.url,
      status: 'pending',
      updated_at: now,
    }));
    const { error: itemsError } = await supabaseAdmin
      .from('website_inn_lookup_items')
      .insert(chunk);
    if (itemsError) {
      await supabaseAdmin.from('website_inn_lookup_jobs').delete().eq('id', jobId);
      return NextResponse.json({ error: itemsError.message }, { status: 500 });
    }
  }

  return NextResponse.json({ job }, { status: 201 });
}
