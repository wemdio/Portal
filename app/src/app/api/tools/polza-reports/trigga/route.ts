import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { generateTriggaReport } from '@/lib/tools/polzaReports/client';
import {
  buildReportFilename,
  getReportDownloadUrl,
  uploadReportXlsx,
} from '@/lib/tools/polzaReports/storage';

export const dynamic = 'force-dynamic';
// Trigga is just CSV parsing + xlsx render — finishes in seconds.
export const maxDuration = 60;

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

const MAX_CSV_BYTES = 10 * 1024 * 1024; // 10 MB — generous; Trigga exports are small

export async function POST(req: NextRequest) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Необходима авторизация', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Необходима авторизация', 401);

  // Parse the multipart payload. Browser sends `file`, `include_created`,
  // `include_base_left`.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return jsonError('Не удалось прочитать форму', 400);
  }

  const fileEntry = formData.get('file');
  if (!(fileEntry instanceof Blob)) {
    return jsonError('Не загружен CSV-файл', 400);
  }
  if (fileEntry.size === 0) {
    return jsonError('CSV-файл пустой', 400);
  }
  if (fileEntry.size > MAX_CSV_BYTES) {
    return jsonError('CSV больше 10 МБ — слишком велик для отчёта Trigga', 400);
  }

  const include_created = formData.get('include_created') === 'true';
  const include_base_left = formData.get('include_base_left') === 'true';
  const filename = fileEntry instanceof File ? fileEntry.name : 'trigga.csv';

  // Create the job row up front for history consistency.
  const { data: job, error: jobErr } = await supabase
    .from('polza_report_jobs')
    .insert({
      user_id: user.id,
      source: 'trigga',
      status: 'running',
      detailed: false,
      include_created,
      include_base_left,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (jobErr || !job) {
    return jsonError(jobErr?.message || 'Не удалось создать задачу отчёта', 500);
  }

  try {
    const csvBytes = Buffer.from(await fileEntry.arrayBuffer());
    const { xlsx, campaignsCount } = await generateTriggaReport(
      csvBytes,
      filename,
      { include_created, include_base_left },
      req.signal,
    );

    const createdAt = new Date();
    const outFilename = buildReportFilename('trigga', createdAt);
    const key = await uploadReportXlsx({
      userId: user.id,
      jobId: job.id,
      xlsx,
    });

    await supabase
      .from('polza_report_jobs')
      .update({
        status: 'completed',
        result_xlsx_path: key,
        result_filename: outFilename,
        campaigns_count: campaignsCount,
        completed_at: createdAt.toISOString(),
      })
      .eq('id', job.id);

    const downloadUrl = await getReportDownloadUrl({ key, filename: outFilename });

    return NextResponse.json({
      jobId: job.id,
      campaigns_count: campaignsCount,
      filename: outFilename,
      downloadUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Неизвестная ошибка';
    await supabase
      .from('polza_report_jobs')
      .update({
        status: 'failed',
        error_message: message,
        completed_at: new Date().toISOString(),
      })
      .eq('id', job.id);
    return jsonError(message, 500);
  }
}
