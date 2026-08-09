/** @jest-environment node */

const datasetQueryMock = jest.fn();
const pipelineRpcMock = jest.fn();

jest.mock('@/lib/instantlyDataset', () => ({
  datasetQuery: (...args: unknown[]) => datasetQueryMock(...args),
}));
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => pipelineRpcMock(...args) },
}));

import {
  buildReportQualityNotices,
  buildOutreachMetricsQuery,
  loadClientReportAnalytics,
  mapOutreachMetricsRow,
  resolvePipelineCampaignNames,
} from '@/lib/clientReports/analytics';

describe('client reports outreach analytics', () => {
  const input = {
    campaignIds: ['campaign-a', 'campaign-b'],
    fromUtc: '2026-07-01T00:00:00.000Z',
    toExclusiveUtc: '2026-08-01T00:00:00.000Z',
    score: 'B' as const,
  };

  beforeEach(() => {
    datasetQueryMock.mockReset();
    pipelineRpcMock.mockReset();
  });

  it('builds one parameterized query for the allowed campaigns and period', () => {
    const query = buildOutreachMetricsQuery(input);

    expect(query.params).toEqual([
      input.campaignIds,
      input.fromUtc,
      input.toExclusiveUtc,
      input.score,
    ]);
    expect(query.text).toContain('campaign_id = ANY($1::text[])');
    expect(query.text).toContain('timestamp_email >= $2::timestamptz');
    expect(query.text).toContain('timestamp_email < $3::timestamptz');
    expect(query.text).toContain("score_code = $4::text");
  });

  it('counts every outbound step and deduplicates normalized recipients', () => {
    const { text } = buildOutreachMetricsQuery(input);

    expect(text).toMatch(/ue_type\s*=\s*1/);
    expect(text).toMatch(/count\(\*\)[\s\S]*emails_sent/i);
    expect(text).toMatch(/count\(distinct\s+lower\(/i);
  });

  it('reports score-attribution coverage before applying the score filter', () => {
    const { text } = buildOutreachMetricsQuery(input);

    expect(text).toContain('outbound_base AS');
    expect(text).toContain('outbound_coverage AS');
    expect(text).toMatch(/count\(\*\)[\s\S]*score_total_emails/i);
    expect(text).toMatch(/count\(\*\)\s+filter\s*\(where\s+score_code\s+is\s+not\s+null\)[\s\S]*score_mapped_emails/i);
  });

  it('counts canonical reply facts but excludes automatic replies', () => {
    const { text } = buildOutreachMetricsQuery(input);

    expect(text).toContain('v_reply_facts');
    expect(text).toContain('reply_outcome_labels');
    expect(text).toMatch(/auto_reply/i);
    expect(text).toMatch(/<>\s*'auto_reply'/i);
    expect(text).toContain('unclassified_replies');
  });

  it('treats only final qualifications as processed and unions manual target leads', () => {
    const { text } = buildOutreachMetricsQuery(input);

    expect(text).toContain('portal_lead_qualifications');
    expect(text).toContain('portal_forwarded_leads');
    expect(text).toContain("'lead','not_lead','needs_review','objection'");
    expect(text).not.toMatch(/status\s+in\s*\([^)]*'pending'/i);
    expect(text).toMatch(/count\(distinct\s+target_key\)/i);
  });

  it('uses the latest qualification and counts a recipient only once as processed', () => {
    const { text } = buildOutreachMetricsQuery(input);

    expect(text).toMatch(/distinct\s+on\s*\(reply_key\)/i);
    expect(text).toMatch(/order\s+by\s+reply_key,\s*qualified_at\s+desc/i);
    expect(text).toMatch(/count\(distinct\s+reply_key\)[\s\S]*processed_replies/i);
  });

  it('maps nullable database aggregates to stable zero-valued metrics', () => {
    expect(mapOutreachMetricsRow({})).toEqual({
      uniqueRecipients: 0,
      emailsSent: 0,
      liveReplies: 0,
      processedReplies: 0,
      targetLeads: 0,
      scoreMappedEmails: 0,
      scoreTotalEmails: 0,
      unclassifiedReplies: 0,
      analyticsAt: null,
    });
  });

  it('explains every material limitation without hiding exact counters', () => {
    expect(buildReportQualityNotices({
      campaignId: 'campaign-a',
      score: 'B',
      legacyScoredCompanies: 125,
      legacySubmittedContacts: 9,
      unattributedConfirmedContacts: 4,
      scoreMappedEmails: 80,
      scoreTotalEmails: 100,
      unclassifiedReplies: 3,
    })).toEqual(expect.arrayContaining([
      expect.stringMatching(/историческ/i),
      expect.stringMatching(/этапа передачи/i),
      expect.stringMatching(/80 из 100/i),
      expect.stringMatching(/3 ответ/i),
      expect.stringMatching(/4 подтвержд/i),
    ]));
  });

  it('does not show quality warnings for a fully covered exact report', () => {
    expect(buildReportQualityNotices({
      campaignId: null,
      score: 'all',
      legacyScoredCompanies: 0,
      legacySubmittedContacts: 0,
      unattributedConfirmedContacts: 0,
      scoreMappedEmails: 100,
      scoreTotalEmails: 100,
      unclassifiedReplies: 0,
    })).toEqual([]);
  });

  it('replaces legacy campaign-id labels with the current accessible campaign name', () => {
    expect(resolvePipelineCampaignNames([
      {
        campaignId: 'campaign-a',
        campaignName: 'campaign-a',
        scoreCode: 'A',
        submitted: 12,
        confirmed: 0,
      },
    ], [
      { id: 'campaign-a', name: 'Mailganer — высокий скор' },
    ])).toEqual([
      expect.objectContaining({ campaignName: 'Mailganer — высокий скор' }),
    ]);
  });

  it('separates event-period additions from cohort conversion and scopes the RPC to allowed campaigns', async () => {
    datasetQueryMock
      .mockResolvedValueOnce([{
        unique_recipients: 8,
        emails_sent: 15,
        live_replies: 3,
        processed_replies: 2,
        target_leads: 1,
        score_mapped_emails: 12,
        score_total_emails: 15,
        unclassified_replies: 1,
        analytics_at: '2026-07-31T12:00:00.000Z',
      }])
      .mockResolvedValueOnce([{ id: 'campaign-a', name: 'Кампания A' }]);
    pipelineRpcMock.mockResolvedValue({
      data: [{
        scored_companies: 100,
        working_score_companies: 30,
        email_found_companies: 20,
        validated_emails: 18,
        submitted_contacts: 10,
        confirmed_contacts: 7,
        event_confirmed_contacts: 9,
        event_legacy_submitted_contacts: 2,
        legacy_scored_companies: 5,
        unattributed_confirmed_contacts: 1,
        pipeline_at: '2026-07-31T11:00:00.000Z',
        by_campaign: [],
      }],
      error: null,
    });

    const result = await loadClientReportAnalytics({
      clientUserId: 'client-1',
      allowedCampaignIds: ['campaign-a', 'campaign-b'],
      campaignIds: ['campaign-a'],
      filters: {
        period: {
          preset: 'custom',
          from: '2026-07-01',
          to: '2026-07-31',
          fromUtc: new Date('2026-06-30T21:00:00.000Z'),
          toExclusiveUtc: new Date('2026-07-31T21:00:00.000Z'),
        },
        score: 'B',
        campaignId: 'campaign-a',
      },
    });

    expect(datasetQueryMock.mock.calls[0]?.[1]?.[0]).toEqual(['campaign-a']);
    expect(datasetQueryMock.mock.calls[1]?.[1]).toEqual([
      ['campaign-a', 'campaign-b'],
    ]);

    expect(pipelineRpcMock).toHaveBeenCalledWith(
      'client_report_pipeline_summary',
      expect.objectContaining({
        p_allowed_campaign_ids: ['campaign-a', 'campaign-b'],
        p_campaign_id: 'campaign-a',
        p_score_code: 'B',
      }),
    );
    expect(result.metrics.contactsAddedConfirmed).toBe(9);
    expect(result.metrics.contactsSubmittedLegacy).toBe(2);
    expect(result.funnel.confirmedContacts).toBe(7);
    expect(result.qualityNotices).toEqual(expect.arrayContaining([
      expect.stringMatching(/историческ/i),
      expect.stringMatching(/этапа передачи/i),
      expect.stringMatching(/12 из 15/i),
      expect.stringMatching(/1 ответ/i),
      expect.stringMatching(/1 подтвержд/i),
    ]));
  });
});
