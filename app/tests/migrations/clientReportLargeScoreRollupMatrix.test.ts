/** @jest-environment node */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260814_0001_client_report_large_score_rollup_matrix.sql',
);
const protectedMigrations = [
  {
    name: '20260806_0002_client_report_pipeline_summary.sql',
    sha256: 'a6d00d3d243c23128e9da77fe8a6d1caea9ae65bb5352b82628893e5125ec771',
  },
  {
    name: '20260811_0002_client_report_large_score_rollup.sql',
    sha256: 'c5c5b9c4a3e17101f5eae968c281cb2eec55f6b15b8a104fb1569d55bf5e457c',
  },
  {
    name: '20260813_0001_client_report_large_score_rollup_activation.sql',
    sha256: '8dc2359c6e636c20ff07264f7854a2666e2a856f03dcb474edb91dff471c8d57',
  },
];

const rawSql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8')
  : '';
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();

function protectedFunctionBodyHash(fileName: string, name: string): string {
  const protectedPath = path.resolve(
    __dirname,
    '../../../supabase/migrations',
    fileName,
  );
  const source = fs.readFileSync(protectedPath, 'utf8');
  const lower = source.toLowerCase();
  const declaration = lower.indexOf(
    `create or replace function public.${name.toLowerCase()}(`,
  );
  const bodyStart = declaration === -1
    ? -1
    : lower.indexOf('as $$', declaration);
  const bodyEnd = bodyStart === -1
    ? -1
    : lower.indexOf('$$;', bodyStart + 5);
  if (declaration === -1 || bodyStart === -1 || bodyEnd === -1) return '';

  const normalized = source
    .slice(bodyStart + 5, bodyEnd)
    .replace(/\s+/g, ' ')
    .trim();
  return crypto.createHash('md5').update(normalized, 'utf8').digest('hex');
}

function functionSql(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const end = start === -1 ? -1 : sql.indexOf('$$;', start);
  return start === -1 || end === -1 ? '' : sql.slice(start, end + 3);
}

describe('large-score rollup set-based parity matrix migration', () => {
  it('is a new forward-only migration and leaves every applied report migration byte-stable', () => {
    expect(rawSql).not.toBe('');

    for (const protectedMigration of protectedMigrations) {
      const protectedPath = path.resolve(
        __dirname,
        '../../../supabase/migrations',
        protectedMigration.name,
      );
      const digest = crypto
        .createHash('sha256')
        .update(fs.readFileSync(protectedPath, 'utf8').replace(/\r\n/g, '\n'))
        .digest('hex');
      expect(digest).toBe(protectedMigration.sha256);
    }

    expect(sql).not.toContain(
      'create or replace function public.client_report_pipeline_summary(',
    );
    expect(sql).not.toContain(
      'create or replace function public.client_report_pipeline_summary_shadow(',
    );
    expect(sql).not.toContain(
      'create or replace function public.activate_client_report_large_score_rollup(',
    );
  });

  it('exposes one read-only JSON matrix RPC with the agreed exact signature', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    expect(verify).toMatch(
      /verify_client_report_large_score_rollup_matrix\( p_client_user_id uuid, p_rollup_run_id uuid, p_windows jsonb, p_allowed_campaign_ids text\[\] \) returns jsonb/,
    );
    expect(verify).toMatch(/language plpgsql volatile security invoker/);
    expect(verify).toContain('security invoker');
    expect(verify).toContain('set search_path = pg_catalog, public');
    expect(verify).not.toMatch(/\b(insert|update|delete|merge|truncate)\b/);
    expect(verify).not.toContain(
      'public.activate_client_report_large_score_rollup(',
    );
  });

  it('fails closed unless it receives six unique Moscow-day windows and three campaigns', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    for (const fragment of [
      "jsonb_typeof(p_windows) <> 'array'",
      'jsonb_array_length(p_windows) <> 6',
      'count(distinct window_key) as distinct_keys',
      'window_stats.distinct_keys <> 6',
      'count(distinct (from_at, to_at)) as distinct_ranges',
      'window_stats.distinct_ranges <> 6',
      "at time zone 'europe/moscow'",
      "interval '367 days'",
      'cardinality(p_allowed_campaign_ids) <> 3',
      'count( distinct pg_catalog.btrim(allowed_campaign_id) ) <> 3',
    ]) {
      expect(verify).toContain(fragment);
    }
    expect(verify).toMatch(
      /array\[\s*'1d',\s*'7d',\s*'30d',\s*'current_month',\s*'previous_month',\s*'full'\s*\]::text\[\]/,
    );
    expect(verify).toMatch(
      /jsonb_typeof\(\s*window_value->'labels'\s*\) = 'array'/,
    );
    expect(verify).toContain("raise exception 'invalid parity matrix windows'");
    expect(verify).toContain("raise exception 'parity matrix requires three unique campaigns'");
  });

  it('builds the complete 6 x 4 x 4 matrix and verifies exact unique cardinality', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    for (const score of ['null::text', "'a'::text", "'b'::text", "'c'::text"]) {
      expect(verify).toContain(score);
    }
    expect(verify).toContain('cross join score_filters');
    expect(verify).toContain('cross join campaign_filters');
    expect(verify).toContain('v_expected_cells constant integer := 96');
    expect(verify).toContain('v_checked_cells <> v_expected_cells');
    expect(verify).toContain('v_unique_contexts <> v_expected_cells');
    expect(verify).toContain("raise exception 'parity matrix cardinality invariant failed'");
    expect(verify).toContain("'contract_verified', v_contract_verified");
  });

  it('pins every label to its exact clipped dashboard preset at the RR timestamp', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    expect(verify).toContain('transaction_timestamp()');
    expect(verify).toMatch(/date_trunc\(\s*'month'/);
    expect(verify).toContain("interval '1 day'");
    expect(verify).toContain("interval '7 days'");
    expect(verify).toContain("interval '30 days'");
    expect(verify).toContain("interval '1 month'");
    expect(verify).toMatch(/greatest\(\s*full_bounds\.from_at/);
    expect(verify).toMatch(/least\(\s*full_bounds\.to_at/);
    expect(verify).toContain(
      "raise exception 'parity matrix windows do not match dashboard presets'",
    );
  });

  it('takes one non-blocking transaction lock scoped to the exact client', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    expect(verify).toContain('pg_try_advisory_xact_lock');
    expect(verify).toContain('p_client_user_id::text');
    expect(verify).toContain("raise exception 'client report parity verification is already running'");
  });

  it('materializes the live large-score source once with current score/error semantics', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    expect(verify).toContain('large_source as materialized');
    expect(verify.match(/public\.large_score_domains/g)).toHaveLength(1);
    expect(verify).toContain('job.id as source_job_id');
    expect(verify).toContain('domain_row.id as source_row_id');
    expect(verify).toContain('source_window_facts as (');
    expect(verify).not.toContain('source_window_facts as materialized');
    expect(verify).toContain('public.large_score_jobs');
    expect(verify).toContain('public.mailganer_domain_scores');
    expect(verify).toContain("domain_row.status in ('scored', 'error')");
    expect(verify).toContain("when domain_row.status = 'error' then 'error'");
    expect(verify).toContain('public.client_report_score_code(cache.score)');
    expect(verify).not.toContain("job.status = 'completed'");
    expect(verify).not.toMatch(
      /domain_row\.scored_at\s*<=\s*[^\s]*source_watermark/,
    );
    expect(verify).toContain("'source_scans', 1");
    expect(verify).toContain("'coverage_verified', true");
    expect(verify).toContain('outside_full_count');
    expect(verify).toContain(
      "raise exception 'live large-score source falls outside full parity window'",
    );
  });

  it('suppresses exact counterparts independently inside every half-open window', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    expect(verify).toContain('source.scored_at >= window_row.from_at');
    expect(verify).toContain('source.scored_at < window_row.to_at');
    expect(verify).toContain('not exists ( select 1 from public.client_pipeline_domain_snapshots as exact_match');
    expect(verify).toContain('exact_match.client_user_id = p_client_user_id');
    expect(verify).toContain('not exact_match.legacy_inferred');
    expect(verify).toContain("exact_match.source_kind = 'large_score_file'");
    expect(verify).toContain('exact_match.source_job_id = source.source_job_id');
    expect(verify).toContain('exact_match.source_row_id = source.source_row_id');
    expect(verify).toMatch(
      /\(\s*exact_match\.scored_at >= window_row\.from_at/,
    );
    expect(verify).toMatch(
      /or \(\s*exact_match\.routed_at >= window_row\.from_at/,
    );
  });

  it('compares exact bigint counts, timestamp precision and canonical campaign payloads', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    for (const field of [
      'scored_companies',
      'working_score_companies',
      'legacy_scored_companies',
      'pipeline_at',
      'by_campaign',
    ]) {
      expect(verify).toContain(`'${field}'`);
    }
    expect(verify).toContain("'by_campaign', '[]'::jsonb");
    expect(verify).toContain('is not distinct from');
    expect(verify).not.toContain('extract(epoch');
    expect(verify).not.toContain('::double precision');
    expect(verify).toContain("'matched'");
    expect(verify).toContain("'mismatch_context'");
    expect(verify).toContain("'mismatches'");
  });

  it('fails closed if the audited legacy/shadow report contract drifts', () => {
    const verify = functionSql(
      'verify_client_report_large_score_rollup_matrix',
    );

    expect(verify).toMatch(
      /to_regprocedure\(\s*'public\.client_report_pipeline_summary\(uuid,timestamptz,timestamptz,text\[\],text,text\)'\s*\)/,
    );
    expect(verify).toMatch(
      /to_regprocedure\(\s*'public\.client_report_pipeline_summary_shadow\(uuid,uuid,timestamptz,timestamptz,text\[\],text,text\)'\s*\)/,
    );
    expect(verify).toMatch(
      /btrim\(pg_catalog\.regexp_replace\(\s*contract_proc\.prosrc/,
    );
    expect(verify).toContain('contract_proc.provolatile');
    expect(verify).toContain('contract_proc.prosecdef');
    expect(verify).toContain('contract_proc.proconfig');
    expect(verify).toContain('contract_proc.prorettype');
    expect(verify).toContain('contract_proc.proallargtypes');
    expect(verify).toContain('contract_proc.proargmodes');
    expect(verify).toContain('contract_proc.proargnames');
    expect(verify).toContain("'948f5463fd7d60c9fa4fa806102b4de0'");
    expect(verify).toContain("'833ef7d93567b7b5fdbd579c9563f909'");
    expect(verify).toContain("raise exception 'client report parity contract drifted'");
  });

  it('derives both pinned body hashes from the protected migration functions', () => {
    const legacyHash = protectedFunctionBodyHash(
      '20260806_0002_client_report_pipeline_summary.sql',
      'client_report_pipeline_summary',
    );
    const shadowHash = protectedFunctionBodyHash(
      '20260811_0002_client_report_large_score_rollup.sql',
      'client_report_pipeline_summary_shadow',
    );

    expect(legacyHash).toBe('948f5463fd7d60c9fa4fa806102b4de0');
    expect(shadowHash).toBe('833ef7d93567b7b5fdbd579c9563f909');
    expect(sql).toContain(`'${legacyHash}'`);
    expect(sql).toContain(`'${shadowHash}'`);
  });

  it('keeps the verifier owner-only, including service_role', () => {
    const signature =
      'verify_client_report_large_score_rollup_matrix\\(uuid, uuid, jsonb, text\\[\\]\\)';

    for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
      expect(sql).toMatch(new RegExp(
        `revoke all on function public\\.${signature} from ${role}`,
      ));
    }
    expect(sql).not.toMatch(new RegExp(
      `grant execute on function public\\.${signature}`,
    ));
  });
});
