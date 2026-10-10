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

const liveEmailSql = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20261010_0001_client_no_email_retry_live_email_counts.sql',
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

  it('counts interim single addresses without nullable status arithmetic', () => {
    const interimBranch = liveEmailSql.split('union all')[1];
    expect(interimBranch).toContain('email_counts.found_count, email_counts.validated_count');
    expect(interimBranch).toContain('count(*) filter (where normalized_email.is_ready)');
    expect(interimBranch).toContain("(nullif(btrim(m.email), ''), m.email_validation_status)");
    expect(interimBranch).toContain("(nullif(btrim(m.email2), ''), m.email2_validation_status)");
    expect(interimBranch).toContain('bool_or( candidate.validation_status in');
    expect(interimBranch).toContain('group by lower(btrim(candidate.email))');
    expect(interimBranch).toContain("where nullif(btrim(candidate.email), '') is not null");
    expect(interimBranch).toContain("and nullif(btrim(m.domain), '') is not null");
    expect(interimBranch).not.toContain(')::int +');
  });

  it('preserves durable retry classification, snapshot dedup and restricted grants in the live fix', () => {
    expect(liveEmailSql).toContain('left join public.client_manual_score_runs as r');
    expect(liveEmailSql).toContain("s.metadata->>'is_no_email_retry' = 'true'");
    expect(liveEmailSql).toContain("s.metadata->>'source_filename' like 'no-email-retry-%'");
    expect(liveEmailSql).toContain('and not exists');
    expect(liveEmailSql).toContain('s.source_row_id = m.id::text');
    expect(liveEmailSql).toContain('grant execute on function public.client_report_no_email_retry_delta');
    expect(liveEmailSql).toContain('to service_role');
    expect(liveEmailSql).not.toContain('client_campaign_contact_ledger');
    expect(liveEmailSql).not.toContain('client_campaign_append_batches');
  });

  it('requires the live-count fix before the generated SQL can enqueue more runs', () => {
    const prepareScript = fs.readFileSync(path.resolve(
      __dirname, '../../scripts/no-email-retry/prepare-enqueue.mjs',
    ), 'utf8');
    expect(prepareScript).toContain('SELECT 1 FROM public.portal_migrations');
    expect(prepareScript).toContain('20261010_0001_client_no_email_retry_live_email_counts.sql');
    expect(prepareScript.indexOf('Deploy the no-email retry live email-count fix'))
      .toBeLessThan(prepareScript.indexOf('INSERT INTO public.client_manual_score_runs'));
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
