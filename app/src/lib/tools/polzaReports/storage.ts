import 'server-only';

import { putMainS3Object, createMainS3DownloadUrl } from '@/lib/mainS3Server';

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const KEY_PREFIX = 'polza-reports';

/**
 * Build the S3 key for a rendered report. We bucket by user so that even
 * accidental key leaks can't cross-contaminate tenants:
 *   polza-reports/<userId>/<jobId>.xlsx
 */
export function buildReportKey(userId: string, jobId: string): string {
  return `${KEY_PREFIX}/${userId}/${jobId}.xlsx`;
}

/** Upload xlsx bytes to MAIN S3. Returns the stored key. */
export async function uploadReportXlsx(params: {
  userId: string;
  jobId: string;
  xlsx: Buffer;
}): Promise<string> {
  const key = buildReportKey(params.userId, params.jobId);
  await putMainS3Object({
    key,
    body: params.xlsx,
    contentType: XLSX_MIME,
    cacheControl: 'private, max-age=300',
  });
  return key;
}

/**
 * Generate a short-lived signed URL the browser can hit to download the report.
 * Defaults to 10 min; pass `expiresInSeconds` if the user needs longer (e.g.
 * for the history block we want it to survive a slow click).
 */
export function getReportDownloadUrl(params: {
  key: string;
  filename: string;
  expiresInSeconds?: number;
}): Promise<string> {
  return createMainS3DownloadUrl({
    key: params.key,
    expiresInSeconds: params.expiresInSeconds ?? 60 * 10,
    downloadFilename: params.filename,
  });
}

/** Suggested filename for a Coldy report: coldy_report_2026-05-21_14-30.xlsx */
export function buildReportFilename(source: 'coldy' | 'trigga', createdAt: Date): string {
  const yyyy = createdAt.getFullYear();
  const mm = String(createdAt.getMonth() + 1).padStart(2, '0');
  const dd = String(createdAt.getDate()).padStart(2, '0');
  const hh = String(createdAt.getHours()).padStart(2, '0');
  const min = String(createdAt.getMinutes()).padStart(2, '0');
  return `${source}_report_${yyyy}-${mm}-${dd}_${hh}-${min}.xlsx`;
}
