/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260806_0002_client_report_pipeline_summary.sql',
);

const rawSql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8')
  : '';
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();

const operatorSqlPath = path.resolve(
  __dirname,
  '../../../supabase/operator-sql/20260806_client_report_legacy_indexes_concurrently.sql',
);
const operatorSql = fs.existsSync(operatorSqlPath)
  ? fs.readFileSync(operatorSqlPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()
  : '';

function sqlBetween(startMarker: string, endMarker: string): string {
  const start = sql.indexOf(startMarker);
  const end = start === -1 ? -1 : sql.indexOf(endMarker, start + startMarker.length);
  return start === -1 || end === -1 ? '' : sql.slice(start, end);
}

describe('client report pipeline summary RPC migration', () => {
  it('returns the stable response contract consumed by the reports API', () => {
    expect(sql).toContain(
      'create or replace function public.client_report_pipeline_summary(',
    );

    for (const field of [
      'scored_companies bigint',
      'working_score_companies bigint',
      'email_found_companies bigint',
      'validated_emails bigint',
      'submitted_contacts bigint',
      'confirmed_contacts bigint',
      'legacy_submitted_contacts bigint',
      'event_confirmed_contacts bigint',
      'event_legacy_submitted_contacts bigint',
      'legacy_scored_companies bigint',
      'unattributed_confirmed_contacts bigint',
      'pipeline_at timestamptz',
      'by_campaign jsonb',
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).not.toMatch(/as legacy_submitted_count, from/);
  });

  it('validates client, period, score, allowed campaigns and campaign inputs before querying', () => {
    expect(sql).toContain('p_client_user_id is null');
    expect(sql).toContain('p_from is null or p_to is null or p_from >= p_to');
    expect(sql).toContain("p_to - p_from > interval '367 days'");
    expect(sql).toContain("p_score_code not in ('a', 'b', 'c')");
    expect(sql).toContain('p_allowed_campaign_ids text[]');
    expect(sql).toContain('p_allowed_campaign_ids is null');
    expect(sql).toContain('cardinality(p_allowed_campaign_ids) = 0');
    expect(sql).toContain('unnest(p_allowed_campaign_ids)');
    expect(sql).toContain("nullif(btrim(allowed_campaign_id), '') is null");
    expect(sql).toContain("nullif(btrim(p_campaign_id), '') is null");
    expect(sql).toContain('not (p_campaign_id = any (p_allowed_campaign_ids))');
  });

  it('builds a domain cohort from exact snapshots and every legacy scoring source', () => {
    for (const cte of [
      'exact_domain_facts as',
      'legacy_snapshot_domain_facts as',
      'legacy_auto_domain_facts as',
      'legacy_manual_domain_facts as',
      'legacy_large_domain_facts as',
      'cohort_domain_facts as',
    ]) {
      expect(sql).toContain(cte);
    }

    expect(sql).toContain('public.client_pipeline_domain_snapshots');
    expect(sql).toContain('public.client_auto_pipeline_seen_employers');
    expect(sql).toContain('public.client_manual_score_rows');
    expect(sql).toContain('public.client_manual_score_runs');
    expect(sql).toContain('public.large_score_domains');
    expect(sql).toContain('public.large_score_jobs');
    expect(sql).toContain('public.mailganer_domain_scores');
    expect(sql).toContain('not s.legacy_inferred');
    expect(sql).toContain('s.legacy_inferred');
  });

  it('uses one shared A/B/C threshold definition and does not apply campaign routing to early stages', () => {
    expect(sql).toContain("when score > 1000000 then 'a'");
    expect(sql).toContain("when score >= 15001 then 'b'");
    expect(sql).toContain("when score >= 1001 then 'c'");
    expect(sql).toContain("else 'rejected'");

    const earlyCohort = sqlBetween(
      'cohort_domain_facts as (',
      'exact_contact_cohort as (',
    );
    expect(earlyCohort).toContain('cohort_at >= p_from');
    expect(earlyCohort).toContain('cohort_at < p_to');
    expect(earlyCohort).toContain(
      '(p_score_code is null or facts.score_code = p_score_code)',
    );
    expect(earlyCohort).not.toContain('p_campaign_id');
    expect(earlyCohort).not.toContain('p_allowed_campaign_ids');
  });

  it('counts found and validated email only inside the working A/B/C cohort', () => {
    const funnelTotals = sqlBetween(
      'funnel_totals as (',
      'exact_contact_totals as (',
    );

    expect(funnelTotals).toContain(
      "where facts.score_code in ('a', 'b', 'c') and facts.email_found_count > 0",
    );
    expect(funnelTotals).toContain(
      "sum(facts.email_validated_count) filter ( where facts.score_code in ('a', 'b', 'c') )",
    );
  });

  it('suppresses only the matching legacy source row when an exact snapshot exists', () => {
    expect(sql).toContain('not exists ( select 1 from exact_domain_facts as exact_match');
    expect(sql).toContain('exact_match.source_row_id = a.hh_employer_id');
    expect(sql).toContain('exact_match.source_run_id = r.id::text');
    expect(sql).toContain('exact_match.source_row_id = m.id::text');
    expect(sql).toContain('exact_match.source_job_id = j.id::text');
    expect(sql).toContain('exact_match.source_row_id = d.id::text');
    expect(sql).not.toContain('row_number() over');
  });

  it('builds exact submitted and confirmed cohorts from source-row ledger links', () => {
    const exactContacts = sqlBetween(
      'exact_contact_cohort as (',
      'event_completed_batches as (',
    );

    expect(exactContacts).toContain('public.client_campaign_contact_ledger');
    expect(exactContacts).toContain('public.client_pipeline_domain_snapshots');
    expect(exactContacts).toContain('snapshot.source_kind = contact.source_kind');
    expect(exactContacts).toContain(
      'snapshot.source_run_id is not distinct from contact.source_run_id',
    );
    expect(exactContacts).toContain(
      'snapshot.source_job_id is not distinct from contact.source_job_id',
    );
    expect(exactContacts).toContain('snapshot.source_row_id = contact.source_row_id');
    expect(exactContacts).toContain("contact.append_status in ('submitted', 'accepted')");
    expect(exactContacts).toContain('contact.campaign_id = any (p_allowed_campaign_ids)');
    expect(exactContacts).toContain(
      '(p_campaign_id is null or contact.campaign_id = p_campaign_id)',
    );
    expect(sql).toContain(
      "count(*) filter (where append_status = 'submitted')::bigint as submitted_count",
    );
    expect(sql).toContain(
      "count(*) filter (where append_status = 'accepted')::bigint as confirmed_count",
    );
  });

  it('keeps provider-confirmed event totals separate from the scoring cohort', () => {
    const eventBatches = sqlBetween(
      'event_completed_batches as (',
      'funnel_totals as (',
    );

    expect(eventBatches).toContain('public.client_campaign_append_batches');
    expect(eventBatches).toContain("batch.status = 'completed'");
    expect(eventBatches).toContain('batch.finished_at >= p_from');
    expect(eventBatches).toContain('batch.finished_at < p_to');
    expect(eventBatches).toContain('batch.campaign_id = any (p_allowed_campaign_ids)');
    expect(eventBatches).toContain(
      '(p_campaign_id is null or batch.campaign_id = p_campaign_id)',
    );
    expect(sql).toContain(
      'coalesce(sum(batch.accepted_count), 0)::bigint as event_confirmed_count',
    );
  });

  it('keeps inferred legacy submissions separate from provider-confirmed totals', () => {
    expect(sql).toContain("source_kind = 'legacy_auto'");
    expect(sql).toContain('legacy_submitted_count');
    expect(sql).toContain('legacy_submitted_contacts');
    expect(sql).toContain('event_legacy_submitted_contacts');
    expect(sql).toContain("status = 'routed'");
    expect(sql).toContain('legacy_scored_companies');
    expect(sql).toContain('unattributed_confirmed_contacts');
  });

  it('returns a deterministic campaign breakdown from exact ledger rows and legacy facts', () => {
    expect(sql).toContain('campaign_breakdown as');
    expect(sql).toContain('campaign_rows as');
    expect(sql).toContain('from exact_contact_cohort as contacts');
    expect(sql).toContain('facts.legacy_submitted_count as submitted');
    expect(sql).toContain('0::bigint as confirmed');
    expect(sql).toContain("'campaign_id', campaign_id");
    expect(sql).toContain("'campaign_name', campaign_name");
    expect(sql).toContain("'score_code', score_code");
    expect(sql).toContain("'submitted', submitted");
    expect(sql).toContain("'confirmed', confirmed");
    expect(sql).toContain("coalesce(jsonb_agg(");
    expect(sql).toContain("'[]'::jsonb");
  });

  it('is service-role-only and does not expose a client-id override to authenticated callers', () => {
    expect(sql).toContain('security invoker');
    expect(sql).toContain('set search_path = pg_catalog, public');
    expect(sql).toMatch(
      /revoke all on function public\.client_report_pipeline_summary\([^;]+\) from public/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.client_report_pipeline_summary\([^;]+\) from anon/,
    );
    expect(sql).toMatch(
      /revoke all on function public\.client_report_pipeline_summary\([^;]+\) from authenticated/,
    );
    expect(sql).toMatch(
      /grant execute on function public\.client_report_pipeline_summary\([^;]+\) to service_role/,
    );
  });

  it('keeps only new-table indexes in the transactional migration', () => {
    expect(sql).toMatch(
      /on public\.client_pipeline_domain_snapshots \(\s*client_user_id, source_kind, source_row_id, scored_at desc\s*\).*where not legacy_inferred/,
    );
    expect(sql).not.toContain('on public.large_score_domains');
    expect(sql).not.toContain('on public.client_manual_score_rows');
  });

  it('provides non-blocking operator indexes for existing legacy tables', () => {
    expect(operatorSql).toContain('run outside a transaction');
    expect(operatorSql).toMatch(
      /create index concurrently if not exists [^ ]+ on public\.large_score_domains \(job_id, scored_at desc\).*where scored_at is not null/,
    );
    expect(operatorSql).toMatch(
      /create index concurrently if not exists [^ ]+ on public\.client_manual_score_rows \(run_id, processed_at desc\)/,
    );
  });
});
