/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';
import { buildClientReportExportSelectSql, parseClientReportExportJob } from '@/lib/clientReports/exportSql';

const sql = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20261009_0001_client_no_email_retry_reporting.sql',
), 'utf8').replace(/\s+/g, ' ').toLowerCase();

const retentionSql = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20261009_0002_client_no_email_retry_retention.sql',
), 'utf8').replace(/\s+/g, ' ').toLowerCase();

describe('no-email retry reporting isolation', () => {
  it('requires an explicit run marker and keeps names idempotent', () => {
    expect(sql).toContain('is_no_email_retry boolean not null default false');
    expect(sql).toContain('on public.client_manual_score_runs (client_user_id, source_filename)');
    expect(sql).toContain('where is_no_email_retry');
  });

  it('subtracts exact snapshots and interim manual rows once, not campaign ledger events', () => {
    expect(sql).toContain('create or replace function public.client_report_no_email_retry_delta(');
    expect(sql).toContain('from public.client_pipeline_domain_snapshots as s');
    expect(sql).toContain('from public.client_manual_score_rows as m');
    expect(sql).toContain('and not exists ( select 1 from public.client_pipeline_domain_snapshots as s');
    expect(sql).toContain("r.source_filename like 'no-email-retry-%-20261008.txt'");
    expect(sql).not.toContain('client_campaign_contact_ledger');
    expect(sql).not.toContain('client_campaign_append_batches');
  });

  it('grants the delta only to the service role', () => {
    expect(sql).toContain('grant execute on function public.client_report_no_email_retry_delta');
    expect(sql).toContain('to service_role');
  });

  it('keeps expired retry snapshots in the delta without requiring the deleted run', () => {
    const snapshotBranch = retentionSql.split('union all')[0];
    expect(snapshotBranch).toContain('left join public.client_manual_score_runs as r');
    expect(snapshotBranch).toContain("s.source_kind = 'manual_scoring'");
    expect(snapshotBranch).toContain("s.metadata->>'is_no_email_retry' = 'true'");
    expect(snapshotBranch).toContain("s.metadata->>'source_filename' like 'no-email-retry-%'");
    expect(retentionSql).toContain('and not exists');
    expect(retentionSql).not.toContain('20261008');
    expect(retentionSql).not.toContain('client_campaign_contact_ledger');
  });

  it('keeps the retry label in exports after run cleanup for later dates too', () => {
    const exportSql = buildClientReportExportSelectSql(parseClientReportExportJob({
      id: '123e4567-e89b-12d3-a456-426614174000',
      client_user_id: '123e4567-e89b-12d3-a456-426614174001',
      kind: 'working', status: 'pending',
      filters: {
        preset: 'custom', from: '2026-10-01', to: '2026-10-31',
        fromUtc: '2026-09-30T21:00:00.000Z', toExclusiveUtc: '2026-10-31T21:00:00.000Z',
        score: 'all', campaignId: null, allowedCampaignIds: [],
      },
    }));
    expect(exportSql).toContain('LEFT JOIN public.client_manual_score_runs retry_run');
    expect(exportSql).toContain("s.metadata->>'is_no_email_retry' = 'true'");
    expect(exportSql).toContain("s.metadata->>'source_filename' LIKE 'no-email-retry-%'");
    expect(exportSql).toContain("THEN 'no_email_retry'");
    expect(exportSql).not.toContain('20261008');
  });
});
