import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { getInnEnrichUser } from '@/lib/innEnrich/auth';
import { INN_ENRICH_BUCKET, MAX_SOURCE_FILE_BYTES } from '@/lib/innEnrich/inn';
import { spreadsheetExt } from '@/lib/innEnrich/readFile';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const ALLOWED_EXT = new Set(['xlsx', 'xls', 'csv', 'tsv', 'txt']);
const JOB_LIST_LIMIT = 30;

export async function GET(req: NextRequest) {
  const user = await getInnEnrichUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabaseAdmin!
    .from('inn_enrich_jobs')
    .select(
      'id, status, file_name, total, processed, stats, error_message, created_at, completed_at',
    )
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(JOB_LIST_LIMIT);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data ?? [] });
}

export async function POST(req: NextRequest) {
  const user = await getInnEnrichUser(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data: active } = await supabaseAdmin!
    .from('inn_enrich_jobs')
    .select('id, status, file_name, processed, total')
    .eq('user_id', user.id)
    .in('status', ['pending', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (active) {
    return NextResponse.json(
      {
        error: 'Уже идёт обогащение — дождитесь окончания или откройте его в истории ниже.',
        active_job: active,
      },
      { status: 409 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Ожидался multipart/form-data' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Добавьте файл' }, { status: 400 });
  }
  if (file.size > MAX_SOURCE_FILE_BYTES) {
    return NextResponse.json(
      { error: `Файл слишком большой (${Math.round(file.size / 1024 / 1024)} МБ), максимум 80 МБ` },
      { status: 400 },
    );
  }
  const ext = spreadsheetExt(file.name);
  if (!ALLOWED_EXT.has(ext)) {
    return NextResponse.json({ error: 'Поддерживаются форматы: CSV, TSV, XLSX, XLS' }, { status: 400 });
  }

  const columnIndex = Number(form.get('columnIndex'));
  if (!Number.isInteger(columnIndex) || columnIndex < 0) {
    return NextResponse.json({ error: 'Не выбрана колонка с ИНН' }, { status: 400 });
  }
  const hasHeader = String(form.get('hasHeader') ?? 'true') !== 'false';

  const jobId = crypto.randomUUID();
  const sourcePath = `${jobId}/source.${ext}`;
  const bytes = Buffer.from(await file.arrayBuffer());

  const { error: upErr } = await supabaseAdmin!.storage.from(INN_ENRICH_BUCKET).upload(sourcePath, bytes, {
    contentType: file.type || 'application/octet-stream',
    upsert: false,
  });
  if (upErr) return NextResponse.json({ error: upErr.message }, { status: 500 });

  const { data: job, error: insErr } = await supabaseAdmin!
    .from('inn_enrich_jobs')
    .insert({
      id: jobId,
      user_id: user.id,
      status: 'pending',
      file_name: file.name,
      source_path: sourcePath,
      column_index: columnIndex,
      has_header: hasHeader,
    })
    .select('id, status, file_name, total, processed, created_at')
    .single();

  if (insErr) {
    await supabaseAdmin!.storage.from(INN_ENRICH_BUCKET).remove([sourcePath]);
    return NextResponse.json({ error: insErr.message }, { status: 500 });
  }

  return NextResponse.json({ job }, { status: 201 });
}
