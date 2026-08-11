/** @jest-environment node */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260811_0002_client_report_large_score_rollup.sql',
);
const currentMigrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260806_0002_client_report_pipeline_summary.sql',
);

const rawSql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8')
  : '';
const sql = rawSql.replace(/\s+/g, ' ').toLowerCase();
const currentSql = fs.existsSync(currentMigrationPath)
  ? fs.readFileSync(currentMigrationPath, 'utf8')
  : '';

function tableSql(name: string): string {
  return (
    sql.match(
      new RegExp(`create table if not exists public\\.${name} \\((.*?)\\);`),
    )?.[1] ?? ''
  );
}

function functionSql(name: string): string {
  const start = sql.indexOf(`create or replace function public.${name}(`);
  const end = start === -1 ? -1 : sql.indexOf('$$;', start);
  return start === -1 || end === -1 ? '' : sql.slice(start, end + 3);
}

describe('large-score client-report rollup migration', () => {
  it('is additive and leaves the current production summary migration untouched', () => {
    const digest = crypto
      .createHash('sha256')
      .update(currentSql.replace(/\r\n/g, '\n'), 'utf8')
      .digest('hex');

    expect(digest).toBe(
      'a6d00d3d243c23128e9da77fe8a6d1caea9ae65bb5352b82628893e5125ec771',
    );
    expect(sql).not.toContain(
      'create or replace function public.client_report_pipeline_summary(',
    );
    expect(sql).not.toContain(
      'drop function if exists public.client_report_pipeline_summary(',
    );
  });

  it('creates runs, Moscow-day score buckets and per-job/day checkpoints', () => {
    for (const table of [
      'client_report_large_score_rollup_runs',
      'client_report_large_score_rollup_buckets',
      'client_report_large_score_rollup_checkpoints',
    ]) {
      expect(sql).toContain(`create table if not exists public.${table}`);
    }

    const runs = tableSql('client_report_large_score_rollup_runs');
    for (const column of [
      'id', 'client_user_id', 'status', 'created_at', 'started_at', 'ready_at',
      'error_message',
    ]) {
      expect(runs).toMatch(new RegExp(`\\b${column}\\b`));
    }
    for (const status of ['building', 'ready', 'failed']) {
      expect(runs).toContain(`'${status}'`);
    }

    const buckets = tableSql('client_report_large_score_rollup_buckets');
    for (const column of [
      'rollup_run_id', 'client_user_id', 'source_job_id', 'cohort_day',
      'score_code', 'domain_count',
    ]) {
      expect(buckets).toMatch(new RegExp(`\\b${column}\\b`));
    }
    for (const code of ['a', 'b', 'c', 'rejected', 'error']) {
      expect(buckets).toContain(`'${code}'`);
    }
    expect(buckets).toMatch(/domain_count bigint not null check \(domain_count >= 0\)/);

    const checkpoints = tableSql(
      'client_report_large_score_rollup_checkpoints',
    );
    for (const column of [
      'rollup_run_id', 'client_user_id', 'source_job_id', 'cohort_day',
      'source_count', 'bucket_count', 'rebuilt_at',
    ]) {
      expect(checkpoints).toMatch(new RegExp(`\\b${column}\\b`));
    }
    expect(checkpoints).toMatch(/check \(source_count = bucket_count\)/);
  });

  it('uses tenant-safe composite keys and ownership-preserving foreign keys', () => {
    const runs = tableSql('client_report_large_score_rollup_runs');
    const buckets = tableSql('client_report_large_score_rollup_buckets');
    const checkpoints = tableSql(
      'client_report_large_score_rollup_checkpoints',
    );

    expect(runs).toMatch(/primary key \(id, client_user_id\)/);
    expect(buckets).toMatch(
      /primary key \(rollup_run_id, client_user_id, source_job_id, cohort_day, score_code\)/,
    );
    expect(checkpoints).toMatch(
      /primary key \(rollup_run_id, client_user_id, source_job_id, cohort_day\)/,
    );
    for (const child of [buckets, checkpoints]) {
      expect(child).toMatch(
        /foreign key \(rollup_run_id, client_user_id\) references public\.client_report_large_score_rollup_runs \(id, client_user_id\) on delete cascade/,
      );
    }
  });

  it('keeps all rollup state behind RLS and service-only grants', () => {
    for (const table of [
      'client_report_large_score_rollup_runs',
      'client_report_large_score_rollup_buckets',
      'client_report_large_score_rollup_checkpoints',
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      for (const role of ['public', 'anon', 'authenticated']) {
        expect(sql).toMatch(
          new RegExp(`revoke all on (table )?public\\.${table} from ${role}`),
        );
      }
      expect(sql).toMatch(
        new RegExp(`grant all on (table )?public\\.${table} to service_role`),
      );
      expect(sql).not.toMatch(
        new RegExp(`grant [^;]+public\\.${table}[^;]+to (anon|authenticated)`),
      );
    }
  });

  it('defines a service-only rebuild for one run, completed job and day', () => {
    const rebuild = functionSql('rebuild_client_report_large_score_rollup_day');

    expect(rebuild).toMatch(
      /rebuild_client_report_large_score_rollup_day\( p_rollup_run_id uuid, p_job_id uuid, p_cohort_day date \)/,
    );
    expect(rebuild).toContain('security invoker');
    expect(rebuild).toContain('set search_path = pg_catalog, public');
    expect(rebuild).toContain('public.client_report_large_score_rollup_runs');
    expect(rebuild).toContain('public.large_score_jobs');
    expect(rebuild).toContain('run.client_user_id = job.client_user_id');
    expect(rebuild).toContain("run.status = 'building'");
    expect(rebuild).toContain("job.status = 'completed'");
    expect(rebuild).toContain("raise exception 'rollup run or completed job not found'");

    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toMatch(
        new RegExp(
          `revoke all on function public\\.rebuild_client_report_large_score_rollup_day\\(uuid, uuid, date\\) from ${role}`,
        ),
      );
    }
    expect(sql).toMatch(
      /grant execute on function public\.rebuild_client_report_large_score_rollup_day\(uuid, uuid, date\) to service_role/,
    );
  });

  it('absolutely rebuilds with Moscow boundaries, score mapping and exact anti-match', () => {
    const rebuild = functionSql('rebuild_client_report_large_score_rollup_day');
    const deleteAt = rebuild.indexOf(
      'delete from public.client_report_large_score_rollup_buckets',
    );
    const insertAt = rebuild.indexOf(
      'insert into public.client_report_large_score_rollup_buckets',
    );

    expect(deleteAt).toBeGreaterThan(-1);
    expect(insertAt).toBeGreaterThan(deleteAt);
    expect(rebuild).toContain('rollup_run_id = p_rollup_run_id');
    expect(rebuild).toContain('source_job_id = p_job_id');
    expect(rebuild).toContain('cohort_day = p_cohort_day');
    expect(rebuild).toContain("d.status in ('scored', 'error')");
    expect(rebuild).toContain("d.status = 'error'");
    expect(rebuild).toContain('public.client_report_score_code(cache.score)');
    expect(rebuild).toContain('public.mailganer_domain_scores');
    expect(rebuild).toContain("at time zone 'europe/moscow'");
    expect(rebuild).toContain('p_cohort_day + 1');
    expect(rebuild).toContain(
      'not exists ( select 1 from public.client_pipeline_domain_snapshots',
    );
    expect(rebuild).toContain('exact_match.client_user_id = run.client_user_id');
    expect(rebuild).toContain('not exact_match.legacy_inferred');
    expect(rebuild).toContain("exact_match.source_kind = 'large_score_file'");
    expect(rebuild).toContain('exact_match.source_job_id = p_job_id::text');
    expect(rebuild).toContain('exact_match.source_row_id = d.id::text');
    expect(rebuild).not.toMatch(
      /exact_match\.scored_at\s*(<=|<|>=|>)/,
    );
    expect(rebuild).not.toMatch(
      /domain_count\s*=\s*[^;]+\+\s*excluded\.domain_count/,
    );
  });

  it('preserves operator validation evidence when the run becomes ready', () => {
    const guard = functionSql('guard_client_report_large_score_rollup_run');

    expect(guard).toContain(
      "new.validation := coalesce(new.validation, '{}'::jsonb) || jsonb_build_object(",
    );
  });

  it('checks the count invariant before atomically marking its checkpoint', () => {
    const rebuild = functionSql('rebuild_client_report_large_score_rollup_day');
    const invariantAt = rebuild.indexOf('v_source_count <> v_bucket_count');
    const checkpointAt = rebuild.indexOf(
      'insert into public.client_report_large_score_rollup_checkpoints',
    );

    expect(rebuild).toContain('v_source_count bigint');
    expect(rebuild).toContain('v_bucket_count bigint');
    expect(invariantAt).toBeGreaterThan(-1);
    expect(rebuild).toContain(
      "raise exception 'large-score rollup count invariant failed'",
    );
    expect(checkpointAt).toBeGreaterThan(invariantAt);
    expect(rebuild).toContain(
      'on conflict (rollup_run_id, client_user_id, source_job_id, cohort_day) do update',
    );
    expect(rebuild).not.toMatch(/\b(commit|rollback)\b/);
  });

  it('adds a shadow RPC with the pinned run-id position and stable 13 fields', () => {
    const shadow = functionSql('client_report_pipeline_summary_shadow');

    expect(shadow).toMatch(
      /client_report_pipeline_summary_shadow\( p_client_user_id uuid, p_rollup_run_id uuid, p_from timestamptz, p_to timestamptz, p_allowed_campaign_ids text\[\], p_score_code text default null, p_campaign_id text default null \)/,
    );
    for (const field of [
      'scored_companies bigint', 'working_score_companies bigint',
      'email_found_companies bigint', 'validated_emails bigint',
      'submitted_contacts bigint', 'confirmed_contacts bigint',
      'legacy_submitted_contacts bigint', 'event_confirmed_contacts bigint',
      'event_legacy_submitted_contacts bigint', 'legacy_scored_companies bigint',
      'unattributed_confirmed_contacts bigint', 'pipeline_at timestamptz',
      'by_campaign jsonb',
    ]) {
      expect(shadow).toContain(field);
    }
  });

  it('fails closed unless the rollup is ready and belongs to this client', () => {
    const shadow = functionSql('client_report_pipeline_summary_shadow');
    for (const validation of [
      'p_client_user_id is null',
      'p_rollup_run_id is null',
      'p_from is null or p_to is null or p_from >= p_to',
      "p_to - p_from > interval '367 days'",
      "p_score_code not in ('a', 'b', 'c')",
      'p_allowed_campaign_ids is null',
      'cardinality(p_allowed_campaign_ids) = 0',
      'unnest(p_allowed_campaign_ids)',
      "nullif(btrim(allowed_campaign_id), '') is null",
      "nullif(btrim(p_campaign_id), '') is null",
      'not (p_campaign_id = any (p_allowed_campaign_ids))',
    ]) {
      expect(shadow).toContain(validation);
    }
    expect(shadow).toContain('public.client_report_large_score_rollup_runs');
    expect(shadow).toContain('run.id = p_rollup_run_id');
    expect(shadow).toContain('run.client_user_id = p_client_user_id');
    expect(shadow).toContain("run.status = 'ready'");
    expect(shadow).toContain(
      "raise exception 'ready rollup run not found for client'",
    );
  });

  it('uses rollup buckets, not multi-million-row sources, in the page query', () => {
    const shadow = functionSql('client_report_pipeline_summary_shadow');
    expect(shadow).toContain('public.client_report_large_score_rollup_buckets');
    expect(shadow).toContain('bucket.rollup_run_id = p_rollup_run_id');
    expect(shadow).toContain('bucket.client_user_id = p_client_user_id');
    expect(shadow).toContain(
      '(p_score_code is null or bucket.score_code = p_score_code)',
    );
    expect(shadow).toContain("at time zone 'europe/moscow'");
    expect(shadow).not.toContain('public.large_score_domains');
    expect(shadow).not.toContain('public.mailganer_domain_scores');
    expect(shadow).not.toContain('legacy_large_domain_facts as');
  });

  it('retains smaller cohorts, exact ledger attribution and campaign filters', () => {
    const shadow = functionSql('client_report_pipeline_summary_shadow');
    for (const source of [
      'public.client_pipeline_domain_snapshots',
      'public.client_auto_pipeline_seen_employers',
      'public.client_manual_score_rows',
      'public.client_manual_score_runs',
      'public.client_campaign_contact_ledger',
      'public.client_campaign_append_batches',
    ]) {
      expect(shadow).toContain(source);
    }
    expect(shadow).toContain('not s.legacy_inferred');
    expect(shadow).toContain('s.legacy_inferred');
    expect(shadow).toContain(
      "contact.append_status in ('submitted', 'accepted')",
    );
    expect(shadow).toContain("batch.status = 'completed'");
    expect(shadow).toContain('contact.campaign_id = any (p_allowed_campaign_ids)');
    expect(shadow).toContain('batch.campaign_id = any (p_allowed_campaign_ids)');
    expect(shadow).toContain(
      '(p_campaign_id is null or contact.campaign_id = p_campaign_id)',
    );
    expect(shadow).toContain(
      '(p_campaign_id is null or batch.campaign_id = p_campaign_id)',
    );
    for (const field of [
      'campaign_id', 'campaign_name', 'score_code', 'submitted', 'confirmed',
    ]) {
      expect(shadow).toContain(`'${field}', ${field}`);
    }
  });

  it('exposes the shadow RPC only to service_role', () => {
    const shadow = functionSql('client_report_pipeline_summary_shadow');
    expect(shadow).toContain('security invoker');
    expect(shadow).toContain('set search_path = pg_catalog, public');
    for (const role of ['public', 'anon', 'authenticated']) {
      expect(sql).toMatch(
        new RegExp(
          `revoke all on function public\\.client_report_pipeline_summary_shadow\\(uuid, uuid, timestamptz, timestamptz, text\\[\\], text, text\\) from ${role}`,
        ),
      );
    }
    expect(sql).toMatch(
      /grant execute on function public\.client_report_pipeline_summary_shadow\(uuid, uuid, timestamptz, timestamptz, text\[\], text, text\) to service_role/,
    );
  });
});
