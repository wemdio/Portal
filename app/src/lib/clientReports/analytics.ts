import 'server-only';

import { datasetQuery } from '@/lib/instantlyDataset';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { ClientReportFilters, ClientReportScoreFilter } from './filters';
import type { ClientReportAnalyticsResponse, ClientReportCampaign } from './types';

export type OutreachMetricsQueryInput = {
  campaignIds: string[];
  fromUtc: string;
  toExclusiveUtc: string;
  score: ClientReportScoreFilter;
};

export type OutreachMetricsRow = Partial<{
  unique_recipients: number | string | null;
  emails_sent: number | string | null;
  live_replies: number | string | null;
  processed_replies: number | string | null;
  target_leads: number | string | null;
  score_mapped_emails: number | string | null;
  score_total_emails: number | string | null;
  unclassified_replies: number | string | null;
  analytics_at: string | Date | null;
}>;

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

export function mapOutreachMetricsRow(row: OutreachMetricsRow) {
  return {
    uniqueRecipients: numberValue(row.unique_recipients),
    emailsSent: numberValue(row.emails_sent),
    liveReplies: numberValue(row.live_replies),
    processedReplies: numberValue(row.processed_replies),
    targetLeads: numberValue(row.target_leads),
    scoreMappedEmails: numberValue(row.score_mapped_emails),
    scoreTotalEmails: numberValue(row.score_total_emails),
    unclassifiedReplies: numberValue(row.unclassified_replies),
    analyticsAt: row.analytics_at ? new Date(row.analytics_at).toISOString() : null,
  };
}

export function buildReportQualityNotices(input: {
  campaignId: string | null;
  score: ClientReportScoreFilter;
  legacyScoredCompanies: number;
  legacySubmittedContacts: number;
  unattributedConfirmedContacts: number;
  scoreMappedEmails: number;
  scoreTotalEmails: number;
  unclassifiedReplies: number;
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
  if (
    input.score !== 'all'
    && input.scoreTotalEmails > 0
    && input.scoreMappedEmails < input.scoreTotalEmails
  ) {
    notices.push(
      `Скор удалось сопоставить для ${input.scoreMappedEmails} из ${input.scoreTotalEmails} фактически отправленных писем. Статистика рассылки по скору может быть неполной.`,
    );
  }
  if (input.unclassifiedReplies > 0) {
    const replyWord = russianPlural(input.unclassifiedReplies, 'ответ', 'ответа', 'ответов');
    const classification = replyWord === 'ответ'
      ? 'ещё не классифицирован и пока входит'
      : 'ещё не классифицированы и пока входят';
    notices.push(
      `${input.unclassifiedReplies} ${replyWord} ${classification} в показатель живых ответов.`,
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

/**
 * One database-side aggregation keeps a 366-day report bounded. Historical
 * lead rows supply the score dimension where it exists; the query also returns
 * attribution coverage so an A/B/C slice cannot look silently complete.
 */
export function buildOutreachMetricsQuery(input: OutreachMetricsQueryInput) {
  return {
    params: [input.campaignIds, input.fromUtc, input.toExclusiveUtc, input.score],
    text: `
WITH scored_leads AS (
  SELECT DISTINCT ON (l.id)
    l.id AS lead_id,
    l.campaign_id,
    lower(btrim(l.email)) AS lead_email,
    CASE
      WHEN coalesce(l.custom_variables->>'score', '') !~ '^-?[0-9]+(\\.[0-9]+)?$' THEN NULL
      WHEN (l.custom_variables->>'score')::numeric > 1000000 THEN 'A'
      WHEN (l.custom_variables->>'score')::numeric >= 15001 THEN 'B'
      WHEN (l.custom_variables->>'score')::numeric >= 1001 THEN 'C'
      ELSE 'rejected'
    END AS score_code
  FROM raw_leads l
  WHERE l.campaign_id = ANY($1::text[])
), outbound_base AS (
  SELECT e.*, sl.lead_email, sl.score_code
  FROM raw_emails e
  LEFT JOIN scored_leads sl
    ON sl.lead_id = e.lead_id AND sl.campaign_id = e.campaign_id
  WHERE e.campaign_id = ANY($1::text[])
    AND e.ue_type = 1
    AND e.timestamp_email >= $2::timestamptz
    AND e.timestamp_email < $3::timestamptz
), outbound AS (
  SELECT *
  FROM outbound_base
  WHERE ($4::text = 'all' OR score_code = $4::text)
), outbound_coverage AS (
  SELECT
    count(*) AS score_total_emails,
    count(*) FILTER (WHERE score_code IS NOT NULL) AS score_mapped_emails
  FROM outbound_base
), sends AS (
  SELECT
    count(*) AS emails_sent,
    count(DISTINCT lower(coalesce(nullif(btrim(to_email), ''), lead_email))) AS unique_recipients,
    max(pulled_at) AS analytics_at
  FROM outbound
), live AS (
  SELECT
    count(*) FILTER (WHERE coalesce(labels.label, '') <> 'auto_reply') AS live_replies,
    count(*) FILTER (WHERE labels.label IS NULL) AS unclassified_replies
  FROM v_reply_facts f
  LEFT JOIN scored_leads sl
    ON sl.lead_id = f.lead_id AND sl.campaign_id = f.campaign_id
  LEFT JOIN reply_outcome_labels labels
    ON labels.campaign_id = f.campaign_id AND labels.lead_id = f.lead_id
  WHERE f.campaign_id = ANY($1::text[])
    AND f.first_reply_at >= $2::timestamptz
    AND f.first_reply_at < $3::timestamptz
    AND ($4::text = 'all' OR sl.score_code = $4::text)
), qualification_events AS (
  SELECT
    q.campaign_id || ':' || lower(btrim(q.lead_email)) AS reply_key,
    q.status,
    coalesce(q.reply_timestamp, q.created_at) AS qualified_at,
    q.created_at AS recorded_at
  FROM portal_lead_qualifications q
  LEFT JOIN scored_leads sl
    ON sl.campaign_id = q.campaign_id AND sl.lead_email = lower(btrim(q.lead_email))
  WHERE q.campaign_id = ANY($1::text[])
    AND q.status IN ('lead','not_lead','needs_review','objection')
    AND coalesce(q.reply_timestamp, q.created_at) >= $2::timestamptz
    AND coalesce(q.reply_timestamp, q.created_at) < $3::timestamptz
    AND ($4::text = 'all' OR sl.score_code = $4::text)
), qualified AS (
  SELECT DISTINCT ON (reply_key)
    reply_key,
    status,
    qualified_at
  FROM qualification_events
  ORDER BY reply_key, qualified_at DESC, recorded_at DESC, status
), target_union AS (
  SELECT reply_key AS target_key FROM qualified WHERE status = 'lead'
  UNION
  SELECT DISTINCT
    f.campaign_id || ':' || lower(btrim(f.lead_email)) AS target_key
  FROM portal_forwarded_leads f
  LEFT JOIN scored_leads sl
    ON sl.campaign_id = f.campaign_id AND sl.lead_email = lower(btrim(f.lead_email))
  WHERE f.campaign_id = ANY($1::text[])
    AND f.status = 'lead'
    AND coalesce(f.reply_timestamp, f.created_at) >= $2::timestamptz
    AND coalesce(f.reply_timestamp, f.created_at) < $3::timestamptz
    AND ($4::text = 'all' OR sl.score_code = $4::text)
)
SELECT
  sends.unique_recipients,
  sends.emails_sent,
  live.live_replies,
  live.unclassified_replies,
  coverage.score_mapped_emails,
  coverage.score_total_emails,
  (SELECT count(DISTINCT reply_key) FROM qualified) AS processed_replies,
  (SELECT count(DISTINCT target_key) FROM target_union) AS target_leads,
  sends.analytics_at
FROM sends
CROSS JOIN live
CROSS JOIN outbound_coverage AS coverage`,
  };
}

type PipelineRpcRow = Partial<{
  scored_companies: number | string;
  working_score_companies: number | string;
  email_found_companies: number | string;
  validated_emails: number | string;
  submitted_contacts: number | string;
  confirmed_contacts: number | string;
  legacy_submitted_contacts: number | string;
  event_confirmed_contacts: number | string;
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

export async function loadClientReportAnalytics(input: {
  clientUserId: string;
  allowedCampaignIds: string[];
  campaignIds: string[];
  filters: ClientReportFilters;
}): Promise<ClientReportAnalyticsResponse> {
  if (!supabaseAdmin) throw new Error('Основная база статистики не настроена');

  const fromUtc = input.filters.period.fromUtc.toISOString();
  const toExclusiveUtc = input.filters.period.toExclusiveUtc.toISOString();
  const outreachQuery = buildOutreachMetricsQuery({
    campaignIds: input.campaignIds,
    fromUtc,
    toExclusiveUtc,
    score: input.filters.score,
  });

  const [outreachRows, campaignRows, pipelineResult] = await Promise.all([
    datasetQuery<OutreachMetricsRow>(outreachQuery.text, outreachQuery.params),
    datasetQuery<{ id: string; name: string | null }>(
      'SELECT id, coalesce(name, id) AS name FROM raw_campaigns WHERE id = ANY($1::text[]) ORDER BY name, id',
      [input.allowedCampaignIds],
    ),
    supabaseAdmin.rpc('client_report_pipeline_summary', {
      p_client_user_id: input.clientUserId,
      p_from: fromUtc,
      p_to: toExclusiveUtc,
      p_score_code: input.filters.score === 'all' ? null : input.filters.score,
      p_campaign_id: input.filters.campaignId,
      p_allowed_campaign_ids: input.allowedCampaignIds,
    }),
  ]);

  if (pipelineResult.error) throw new Error(`Не удалось собрать воронку: ${pipelineResult.error.message}`);

  const outreach = mapOutreachMetricsRow(outreachRows[0] ?? {});
  const pipeline = unwrapPipelineRpc(pipelineResult.data);
  const campaigns: ClientReportCampaign[] = campaignRows.map((row) => ({ id: row.id, name: row.name ?? row.id }));
  const legacySubmitted = numberValue(pipeline.event_legacy_submitted_contacts);
  const cohortConfirmed = numberValue(pipeline.confirmed_contacts);
  const eventConfirmed = numberValue(pipeline.event_confirmed_contacts);
  const qualityNotices = buildReportQualityNotices({
    campaignId: input.filters.campaignId,
    score: input.filters.score,
    legacyScoredCompanies: numberValue(pipeline.legacy_scored_companies),
    legacySubmittedContacts: legacySubmitted,
    unattributedConfirmedContacts: numberValue(pipeline.unattributed_confirmed_contacts),
    scoreMappedEmails: outreach.scoreMappedEmails,
    scoreTotalEmails: outreach.scoreTotalEmails,
    unclassifiedReplies: outreach.unclassifiedReplies,
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
    metrics: {
      contactsAddedConfirmed: eventConfirmed,
      contactsSubmittedLegacy: legacySubmitted,
      uniqueRecipients: outreach.uniqueRecipients,
      emailsSent: outreach.emailsSent,
      liveReplies: outreach.liveReplies,
      processedReplies: outreach.processedReplies,
      targetLeads: outreach.targetLeads,
    },
    funnel: {
      scoredCompanies: numberValue(pipeline.scored_companies),
      workingScoreCompanies: numberValue(pipeline.working_score_companies),
      emailFoundCompanies: numberValue(pipeline.email_found_companies),
      validatedEmails: numberValue(pipeline.validated_emails),
      submittedContacts: numberValue(pipeline.submitted_contacts),
      confirmedContacts: cohortConfirmed,
      byCampaign: resolvePipelineCampaignNames(
        parseCampaignBreakdown(pipeline.by_campaign),
        campaigns,
      ),
    },
    freshness: {
      analyticsAt: outreach.analyticsAt,
      pipelineAt: pipeline.pipeline_at ? new Date(pipeline.pipeline_at).toISOString() : null,
    },
    legacyNotice: qualityNotices.find((notice) => notice.includes('исторической воронки')) ?? null,
    qualityNotices,
  };
}
