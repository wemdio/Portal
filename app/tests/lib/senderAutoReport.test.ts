/** @jest-environment node */
/**
 * «Автоотчёты» по «Рассылке»: цифры из базы в форме аналитики Instantly
 * собираются тем же построителем, что и отчёт по Instantly.
 */

jest.mock('@/lib/instantly/usageCounters', () => ({
  instantlyUsageEndpoint: () => 'other',
  instantlyUsageStatusFromHttp: () => 'ok',
  recordInstantlyApiUsage: jest.fn(),
}));

import { buildAutoReportFromProviderItems } from '@/lib/tools/autoReportBuilder';

const summary = (name: string, contacted: number, sent: number, human: number, auto: number, base: number, bounced: number) => ({
  campaign_name: name,
  new_leads_contacted_count: contacted,
  contacted_count: contacted,
  emails_sent_count: sent,
  reply_count_unique: human,
  reply_count_automatic_unique: auto,
  leads_count: base,
  bounced_count: bounced,
  open_count: 0,
  open_count_unique: 0,
});

describe('buildAutoReportFromProviderItems', () => {
  it('держит кампанию и её шаги вместе, даже если у соседней шагов нет', () => {
    const report = buildAutoReportFromProviderItems([
      {
        summary: summary('RU · клиники', 100, 250, 3, 1, 140, 2),
        steps: [
          { step: 0, variant: 0, sent: 60, unique_replies: 2, opportunities: 1 },
          { step: 0, variant: 1, sent: 40, unique_replies: 1, opportunities: 0 },
          { step: 1, variant: 0, sent: 90, unique_replies: 0, opportunities: 0 },
        ],
      },
      { summary: summary('RU · новая', 0, 0, 0, 0, 50, 0), steps: [] },
    ]);

    expect(report.summary).toMatchObject({
      totalCampaigns: 2,
      totalContacts: 100,
      totalEmailsSent: 250,
      totalReplies: 4,
      totalBounced: 2,
      totalRemaining: 90,
    });
    const steps = Object.values(report.campaignData)[0].steps;
    expect(steps[1]).toMatchObject({ totalSent: 100, totalReplied: 3, totalOpportunities: 1 });
    expect(Object.keys(steps[1].variants)).toEqual(['A', 'B']);
    expect(Object.values(report.campaignData)[1]).toMatchObject({ name: 'RU · новая', steps: {} });
  });
});
