import 'server-only';

import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { readCampaignAnalyticsFromDb } from '@/lib/tools/instantlyCampaignCatalog';
import type { ClientReportFilters } from './filters';
import {
  CLIENT_REPORT_PIPELINE_UNAVAILABLE_MESSAGE,
  type ClientReportAnalyticsResponse,
  type ClientReportCampaign,
} from './types';

export class ClientReportPipelineUnavailableError extends Error {
  constructor(readonly internalError: unknown) {
    super(CLIENT_REPORT_PIPELINE_UNAVAILABLE_MESSAGE);
    this.name = 'ClientReportPipelineUnavailableError';
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function russianPlural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function buildReportQualityNotices(input: {
  campaignId: string | null;
  legacyScoredCompanies: number;
  legacySubmittedContacts: number;
  unattributedConfirmedContacts: number;
}): string[] {
  const notices: string[] = [];

  if (input.legacyScoredCompanies > 0 || input.legacySubmittedContacts > 0) {
    notices.push(
      'Часть исторической воронки восстановлена из прежних журналов. Для таких строк состав частично принятых пакетов и отдельные поля могли не сохраняться.',
    );
  }
  if (input.campaignId) {
    notices.push(
      'Фильтр кампании применяется с этапа передачи контактов: до маршрутизации кампания у компании ещё не определена.',
    );
  }
  if (input.unattributedConfirmedContacts > 0) {
    const contactWord = russianPlural(
      input.unattributedConfirmedContacts,
      'подтверждённого контакта',
      'подтверждённых контактов',
      'подтверждённых контактов',
    );
    notices.push(
      `Для ${input.unattributedConfirmedContacts} ${contactWord} старый журнал сохранил количество, но не сохранил точный состав строк.`,
    );
  }

  return notices;
}

type PipelineRpcRow = Partial<{
  scored_companies: number | string;
  working_score_companies: number | string;
  email_found_companies: number | string;
  validated_emails: number | string;
  submitted_contacts: number | string;
  confirmed_contacts: number | string;
  event_legacy_submitted_contacts: number | string;
  legacy_scored_companies: number | string;
  unattributed_confirmed_contacts: number | string;
  pipeline_at: string | null;
  by_campaign: Array<Record<string, unknown>> | string;
}>;

function parseCampaignBreakdown(value: PipelineRpcRow['by_campaign']) {
  let rows: Array<Record<string, unknown>> = [];
  if (Array.isArray(value)) rows = value;
  else if (typeof value === 'string') {
    try { rows = JSON.parse(value) as Array<Record<string, unknown>>; } catch { rows = []; }
  }
  return rows.map((row) => ({
    campaignId: String(row.campaign_id ?? ''),
    campaignName: String(row.campaign_name ?? row.campaign_id ?? 'Кампания'),
    scoreCode: (row.score_code ?? null) as 'A' | 'B' | 'C' | 'rejected' | 'error' | null,
    submitted: numberValue(row.submitted),
    confirmed: numberValue(row.confirmed),
  }));
}

type PipelineCampaignBreakdown = ClientReportAnalyticsResponse['funnel']['byCampaign'];

export function resolvePipelineCampaignNames(
  rows: PipelineCampaignBreakdown,
  campaigns: ClientReportCampaign[],
): PipelineCampaignBreakdown {
  const names = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));
  return rows.map((row) => ({
    ...row,
    campaignName: !row.campaignName || row.campaignName === row.campaignId
      ? names.get(row.campaignId) ?? row.campaignName ?? row.campaignId
      : row.campaignName,
  }));
}

function unwrapPipelineRpc(data: unknown): PipelineRpcRow {
  if (Array.isArray(data)) return (data[0] ?? {}) as PipelineRpcRow;
  return (data ?? {}) as PipelineRpcRow;
}

function hasUsablePipelineRpcRow(data: unknown): boolean {
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== 'object') return false;
  return [
    'scored_companies',
    'working_score_companies',
    'email_found_companies',
    'validated_emails',
    'submitted_contacts',
    'confirmed_contacts',
    'pipeline_at',
    'by_campaign',
  ].every((field) => Object.prototype.hasOwnProperty.call(row, field));
}

function unwrapUuid(data: unknown): string | null {
  const value = Array.isArray(data) ? data[0] : data;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    for (const key of [
      'client_report_large_score_rollup_active_run',
      'rollup_run_id',
      'id',
    ]) {
      if (typeof row[key] === 'string' && row[key].trim()) {
        return row[key].trim();
      }
    }
  }
  return null;
}

async function loadPipelineSummary(input: {
  clientUserId: string;
  fromUtc: string;
  toExclusiveUtc: string;
  scoreCode: string | null;
  campaignId: string | null;
  allowedCampaignIds: string[];
}) {
  const legacyArgs = {
    p_client_user_id: input.clientUserId,
    p_from: input.fromUtc,
    p_to: input.toExclusiveUtc,
    p_score_code: input.scoreCode,
    p_campaign_id: input.campaignId,
    p_allowed_campaign_ids: input.allowedCampaignIds,
  };

  // Activation is deliberately an optional optimization. A missing migration,
  // stale schema cache or broken shadow query must leave the old report usable.
  let activeRunId: string | null = null;
  try {
    const selector = await supabaseAdmin!.rpc(
      'client_report_large_score_rollup_active_run',
      { p_client_user_id: input.clientUserId },
    );
    if (!selector.error) activeRunId = unwrapUuid(selector.data);
  } catch {
    activeRunId = null;
  }

  if (activeRunId) {
    try {
      const shadow = await supabaseAdmin!.rpc(
        'client_report_pipeline_summary_shadow',
        { ...legacyArgs, p_rollup_run_id: activeRunId },
      );
      if (!shadow.error && hasUsablePipelineRpcRow(shadow.data)) return shadow;
    } catch {
      // Fall through to the unchanged production RPC.
    }
  }

  return supabaseAdmin!.rpc('client_report_pipeline_summary', legacyArgs);
}

async function loadAccessibleCampaigns(allowedCampaignIds: string[]): Promise<ClientReportCampaign[]> {
  const uniqueIds = [...new Set(allowedCampaignIds)];
  let catalogNames = new Map<string, string>();

  try {
    const { campaigns } = await readCampaignAnalyticsFromDb(uniqueIds);
    catalogNames = new Map(campaigns.map((campaign) => [campaign.id, campaign.name]));
  } catch {
    // Campaign names enrich the report but must not make pipeline analytics unavailable.
  }

  return uniqueIds.map((id) => ({
    id,
    name: catalogNames.get(id)?.trim() || id,
  }));
}

export async function loadClientReportAnalytics(input: {
  clientUserId: string;
  allowedCampaignIds: string[];
  filters: ClientReportFilters;
}): Promise<ClientReportAnalyticsResponse> {
  if (!supabaseAdmin) throw new Error('Основная база статистики не настроена');

  const fromUtc = input.filters.period.fromUtc.toISOString();
  const toExclusiveUtc = input.filters.period.toExclusiveUtc.toISOString();

  const [campaigns, pipelineResult] = await Promise.all([
    loadAccessibleCampaigns(input.allowedCampaignIds),
    loadPipelineSummary({
      clientUserId: input.clientUserId,
      fromUtc,
      toExclusiveUtc,
      scoreCode: input.filters.score === 'all' ? null : input.filters.score,
      campaignId: input.filters.campaignId,
      allowedCampaignIds: input.allowedCampaignIds,
    }),
  ]);

  if (pipelineResult.error) {
    throw new ClientReportPipelineUnavailableError(pipelineResult.error);
  }

  const pipeline = unwrapPipelineRpc(pipelineResult.data);
  const qualityNotices = buildReportQualityNotices({
    campaignId: input.filters.campaignId,
    legacyScoredCompanies: numberValue(pipeline.legacy_scored_companies),
    legacySubmittedContacts: numberValue(pipeline.event_legacy_submitted_contacts),
    unattributedConfirmedContacts: numberValue(pipeline.unattributed_confirmed_contacts),
  });

  return {
    campaigns,
    filters: {
      preset: input.filters.period.preset,
      from: input.filters.period.from,
      to: input.filters.period.to,
      score: input.filters.score,
      campaignId: input.filters.campaignId,
    },
    funnel: {
      scoredCompanies: numberValue(pipeline.scored_companies),
      workingScoreCompanies: numberValue(pipeline.working_score_companies),
      emailFoundCompanies: numberValue(pipeline.email_found_companies),
      validatedEmails: numberValue(pipeline.validated_emails),
      submittedContacts: numberValue(pipeline.submitted_contacts),
      confirmedContacts: numberValue(pipeline.confirmed_contacts),
      byCampaign: resolvePipelineCampaignNames(
        parseCampaignBreakdown(pipeline.by_campaign),
        campaigns,
      ),
    },
    freshness: {
      pipelineAt: pipeline.pipeline_at ? new Date(pipeline.pipeline_at).toISOString() : null,
    },
    legacyNotice: qualityNotices.find((notice) => notice.includes('исторической воронки')) ?? null,
    qualityNotices,
  };
}
