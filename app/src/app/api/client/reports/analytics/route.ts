import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { requireClientAuth, jsonError } from '@/lib/clientApiHelper';
import { resolveClientReportFilters, ClientReportFilterError } from '@/lib/clientReports/filters';
import { loadClientReportAnalytics } from '@/lib/clientReports/analytics';

export const dynamic = 'force-dynamic';

function demoResponse() {
  const today = new Date().toISOString().slice(0, 10);
  return NextResponse.json({
    campaigns: [],
    filters: { preset: 'last_30_days', from: today, to: today, score: 'all', campaignId: null },
    metrics: {
      contactsAddedConfirmed: 0, contactsSubmittedLegacy: 0, uniqueRecipients: 0,
      emailsSent: 0, liveReplies: 0, processedReplies: 0, targetLeads: 0,
    },
    funnel: {
      scoredCompanies: 0, workingScoreCompanies: 0, emailFoundCompanies: 0,
      validatedEmails: 0, submittedContacts: 0, confirmedContacts: 0, byCampaign: [],
    },
    freshness: { analyticsAt: null, pipelineAt: null },
    legacyNotice: null,
    qualityNotices: [],
  }, { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function GET(req: NextRequest) {
  const result = await requireClientAuth(req);
  if ('error' in result) return result.error;
  if (result.auth.isDemo) return demoResponse();

  const params = req.nextUrl.searchParams;
  let filters;
  try {
    filters = resolveClientReportFilters({
      preset: params.get('preset') ?? 'last_30_days',
      from: params.get('from') ?? undefined,
      to: params.get('to') ?? undefined,
      score: params.get('score') ?? 'all',
      campaignId: params.has('campaign') ? params.get('campaign') : undefined,
    });
  } catch (error) {
    return jsonError(error instanceof ClientReportFilterError ? error.message : 'Некорректные фильтры', 400);
  }

  const allowedCampaignIds = result.auth.accessRows
    .filter((row) => row.resource_type === 'campaign')
    .map((row) => row.resource_id);
  if (filters.campaignId && !allowedCampaignIds.includes(filters.campaignId)) {
    return jsonError('Кампания недоступна', 403);
  }
  const campaignIds = filters.campaignId ? [filters.campaignId] : allowedCampaignIds;
  if (campaignIds.length === 0) return jsonError('Нет доступных кампаний', 400);

  try {
    const payload = await loadClientReportAnalytics({
      clientUserId: result.auth.userId,
      allowedCampaignIds,
      campaignIds,
      filters,
    });
    return NextResponse.json(payload, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : 'Не удалось собрать статистику', 500);
  }
}
