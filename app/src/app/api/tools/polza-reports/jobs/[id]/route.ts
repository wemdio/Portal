import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

import { createAuthedSupabaseClient, getBearerToken } from '@/lib/supabaseRouteClient';
import { getReportDownloadUrl } from '@/lib/tools/polzaReports/storage';

export const dynamic = 'force-dynamic';

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

/**
 * Re-issues a signed download URL for a completed report.
 *
 * The previous signed URL emitted by /coldy/stream or /trigga expires in 10
 * minutes; the history block in the UI calls this endpoint to get a fresh
 * link when the user clicks an older row.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = getBearerToken(req.headers.get('authorization'));
  if (!token) return jsonError('Unauthorized', 401);

  const supabase = createAuthedSupabaseClient(token);
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return jsonError('Unauthorized', 401);

  const { id } = await params;
  if (!id) return jsonError('Missing job id', 400);

  const { data: job, error } = await supabase
    .from('polza_report_jobs')
    .select('id, status, result_xlsx_path, result_filename')
    .eq('id', id)
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) return jsonError(error.message, 500);
  if (!job) return jsonError('Отчёт не найден', 404);
  if (job.status !== 'completed' || !job.result_xlsx_path) {
    return jsonError('Отчёт ещё не готов или завершился с ошибкой', 409);
  }

  const downloadUrl = await getReportDownloadUrl({
    key: job.result_xlsx_path,
    filename: job.result_filename ?? `report-${job.id}.xlsx`,
  });

  return NextResponse.json({
    jobId: job.id,
    filename: job.result_filename,
    downloadUrl,
  });
}
