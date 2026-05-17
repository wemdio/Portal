import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { serveClientDemo } from '@/lib/clientDemo/demoResponse';
import { scopeAutoReportCampaignIds } from '@/lib/clientAccess';
import { readCampaignAnalyticsFromDb, buildClientReport } from '@/lib/tools/instantlyCampaignCatalog';

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return serveClientDemo(req);
  const { accessRows } = result.auth;

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
    const { campaigns } = await readCampaignAnalyticsFromDb(campaignIds);

    if (campaigns.length === 0) {
      return jsonError('Данные кампаний ещё не синхронизированы. Попробуйте через несколько минут.', 503);
    }

    const report = buildClientReport(campaigns);

    return NextResponse.json({
      tableText: report.tableText,
      csvText: report.csvText,
      rows: report.rows,
      summary: report.summary,
      campaignData: {},
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка формирования отчёта';
    return jsonError(message, 500);
  }
}
