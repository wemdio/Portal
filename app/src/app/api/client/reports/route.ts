import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { scopeAutoReportCampaignIds } from '@/lib/clientAccess';
import { buildAutoReport } from '@/lib/tools/autoReportBuilder';

export const dynamic = 'force-dynamic';

const INSTANTLY_API_KEY =
  (process.env.INSTANTLY_API_KEY ?? process.env.INSTANTLY_PORTAL_API_KEY ?? '').trim();

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  const { accessRows } = result.auth;

  if (!INSTANTLY_API_KEY) {
    return jsonError('Сервис отчётов не настроен', 503);
  }

  let body: { campaignIds?: string[] };
  try {
    body = (await req.json()) as { campaignIds?: string[] };
  } catch {
    return jsonError('Неверное тело запроса', 400);
  }

  const requestedIds = Array.isArray(body.campaignIds)
    ? body.campaignIds.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];

  const campaignIds = scopeAutoReportCampaignIds(requestedIds, accessRows);
  if (campaignIds.length === 0) {
    return jsonError('Нет доступных кампаний для отчёта', 400);
  }

  try {
    const report = await buildAutoReport(campaignIds, INSTANTLY_API_KEY);
    return NextResponse.json({
      tableText: report.tableText,
      csvText: report.csvText,
      rows: report.rows,
      summary: report.summary,
      campaignData: report.campaignData,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка формирования отчёта';
    return jsonError(message, 500);
  }
}
