/** @jest-environment node */

import {
  buildClientReportExportSelectSql,
  buildClientReportExportStorageKey,
  formulaSafeCsvTextSql,
  parseClientReportExportJob,
} from '@/lib/clientReports/exportSql';

const filters = {
  preset: 'custom',
  from: '2026-07-01',
  to: '2026-07-31',
  fromUtc: '2026-06-30T21:00:00.000Z',
  toExclusiveUtc: '2026-07-31T21:00:00.000Z',
  score: 'all',
  campaignId: null,
  allowedCampaignIds: ['campaign-a', 'campaign-b'],
};

function job(kind: 'rejected' | 'working' | 'submitted') {
  return parseClientReportExportJob({
    id: '123e4567-e89b-12d3-a456-426614174000',
    client_user_id: '123e4567-e89b-12d3-a456-426614174001',
    kind,
    filters,
    status: 'running',
  });
}

describe('client report export SQL', () => {
  it('exports rejected domains from the immutable snapshot and legacy scoring sources', () => {
    const sql = buildClientReportExportSelectSql(job('rejected'));

    expect(sql).toContain('client_pipeline_domain_snapshots');
    expect(sql).toContain('client_manual_score_rows');
    expect(sql).toContain('large_score_domains');
    expect(sql).toContain('client_auto_pipeline_seen_employers');
    expect(sql).toContain("s.metadata->>'email'");
    expect(sql).toContain("s.metadata->>'email_validation_status'");
    expect(sql).toContain('source_filename');
    expect(sql).toContain("score_code = 'rejected'");
    expect(sql).toContain("scored_at >= '2026-06-30T21:00:00.000Z'::timestamptz");
    expect(sql).toContain("scored_at < '2026-07-31T21:00:00.000Z'::timestamptz");
  });

  it('exports rejected domains even when the dashboard score filter is A, B or C', () => {
    for (const score of ['A', 'B', 'C'] as const) {
      const parsed = parseClientReportExportJob({
        ...job('rejected'),
        filters: { ...filters, score },
      });
      const sql = buildClientReportExportSelectSql(parsed);

      expect(sql).toContain("source.score_code = 'rejected'");
      expect(sql).not.toMatch(/\bAND false\b/i);
    }
  });

  it('exports working scores by scoring cohort without inventing a pre-routing campaign', () => {
    const parsed = parseClientReportExportJob({
      ...job('working'),
      filters: { ...filters, score: 'B', campaignId: 'campaign-b' },
    });
    const sql = buildClientReportExportSelectSql(parsed);

    expect(sql).toContain("score_code = 'B'");
    expect(sql).not.toContain("source.campaign_id = 'campaign-b'");
    expect(sql).not.toContain('source.campaign_identity_known AND');
  });

  it('prefers exact accepted identities and labels aggregate-only and legacy submission confidence', () => {
    const sql = buildClientReportExportSelectSql(job('submitted'));

    expect(sql).toContain('client_campaign_contact_ledger');
    expect(sql).toContain('client_campaign_append_batches');
    expect(sql).toContain('client_pipeline_domain_snapshots');
    expect(sql).toContain('client_auto_pipeline_seen_employers');
    expect(sql).toContain("l.append_status = 'accepted'");
    expect(sql).toContain('b.identity_complete = false');
    expect(sql).toContain("'identity_confirmed' AS provider_confidence");
    expect(sql).toContain("'identity_unknown' AS provider_confidence");
    expect(sql).toContain("'not_confirmed' AS provider_confidence");
    expect(sql).toContain("'snapshot_routed' AS provider_status");
    expect(sql).toContain('source.provider_status');
    expect(sql).toContain('source.provider_confidence');
    expect(sql).toContain('address.validation_status IN');
    expect(sql).not.toContain("confirmation_status NOT IN ('skipped', 'failed')");
    expect(sql).not.toMatch(/raw_leads|instantly|provider_contact/i);
  });

  it('never silently widens an inaccessible campaign filter', () => {
    expect(() => parseClientReportExportJob({
      ...job('submitted'),
      filters: { ...filters, campaignId: 'campaign-other' },
    })).toThrow('not in the allowed campaign set');
  });

  it('accepts cancelled as a terminal persisted job status', () => {
    expect(parseClientReportExportJob({ ...job('working'), status: 'cancelled' }).status)
      .toBe('cancelled');
  });

  it('quotes text cells defensively against spreadsheet formulas and embedded newlines', () => {
    const expression = formulaSafeCsvTextSql('source.company_name');
    expect(expression).toContain("regexp_replace");
    expect(expression).toContain("^[[:space:]]*[=+@-]");
    expect(expression).toContain("'''' ||");
  });

  it('creates a private, tenant-scoped, predictable object key without raw filenames', () => {
    expect(buildClientReportExportStorageKey(job('working'))).toBe(
      'client-reports/123e4567-e89b-12d3-a456-426614174001/'
      + '123e4567-e89b-12d3-a456-426614174000/working-2026-07-01-2026-07-31.csv.gz',
    );
  });
});
