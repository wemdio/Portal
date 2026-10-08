/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const sql = fs.readFileSync(path.resolve(
  __dirname,
  '../../../supabase/migrations/20261009_0001_client_no_email_retry_reporting.sql',
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
});
