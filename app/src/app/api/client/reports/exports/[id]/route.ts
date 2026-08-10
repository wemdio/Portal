import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { createMainS3DownloadUrl } from '@/lib/mainS3Server';
import { isClientReportExportAccessCurrent } from '@/lib/clientReports/exportSql';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (!supabaseAdmin) return jsonError('Сервис выгрузок не настроен', 500);
  const { id } = await context.params;

  const { data, error } = await supabaseAdmin
    .from('client_report_export_jobs')
    .select('id, client_user_id, kind, filters, status, row_count, storage_key, checksum_sha256, error_message, created_at, finished_at, expires_at')
    .eq('id', id)
    .eq('client_user_id', result.auth.userId)
    .maybeSingle();
  if (error) return jsonError(`Не удалось проверить выгрузку: ${error.message}`, 500);
  if (!data) return jsonError('Выгрузка не найдена', 404);
  const currentCampaignIds = result.auth.accessRows
    .filter((row) => row.resource_type === 'campaign')
    .map((row) => row.resource_id);
  if (!isClientReportExportAccessCurrent(data.filters, currentCampaignIds)) {
    return jsonError('Доступ к кампании был отозван. Создайте новую выгрузку.', 403);
  }

  let downloadUrl: string | undefined;
  const expiresAt = data.expires_at ? new Date(String(data.expires_at)) : null;
  const canDownload = expiresAt !== null
    && Number.isFinite(expiresAt.getTime())
    && expiresAt.getTime() > Date.now();
  if (data.status === 'completed' && data.storage_key && canDownload) {
    downloadUrl = await createMainS3DownloadUrl({
      key: data.storage_key,
      expiresInSeconds: 10 * 60,
      downloadFilename: `mailganer-${data.kind}-${String(data.created_at).slice(0, 10)}.csv.gz`,
    });
  }

  return NextResponse.json({
    job: {
      id: data.id,
      kind: data.kind,
      status: data.status,
      rowCount: data.row_count ?? null,
      checksumSha256: data.checksum_sha256 ?? null,
      createdAt: data.created_at,
      completedAt: data.finished_at ?? null,
      error: data.error_message ?? null,
      downloadUrl,
    },
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}
