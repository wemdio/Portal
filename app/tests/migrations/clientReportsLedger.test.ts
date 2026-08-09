/** @jest-environment node */

import fs from 'node:fs';
import path from 'node:path';

const migrationPath = path.resolve(
  __dirname,
  '../../../supabase/migrations/20260806_0001_client_reports_ledger.sql',
);

const sql = fs.existsSync(migrationPath)
  ? fs.readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()
  : '';

describe('client reports immutable ledger migration', () => {
  it('creates the immutable history and export job tables', () => {
    expect(sql).toContain('create table if not exists public.client_pipeline_domain_snapshots');
    expect(sql).toContain('create table if not exists public.client_campaign_contact_ledger');
    expect(sql).toContain('create table if not exists public.client_campaign_append_batches');
    expect(sql).toContain('create table if not exists public.client_report_export_jobs');
  });

  it('freezes domain scoring and funnel counters at the source run or job', () => {
    const table = sql.match(
      /create table if not exists public\.client_pipeline_domain_snapshots \((.*?)\);/,
    )?.[1] ?? '';

    for (const column of [
      'client_user_id',
      'source_kind',
      'source_run_id',
      'source_job_id',
      'source_row_id',
      'domain',
      'company_name',
      'score',
      'rating',
      'spf',
      'score_origin',
      'score_code',
      'scored_at',
      'email_found_count',
      'email_validated_count',
      'routed_campaign_id',
      'routed_campaign_name_snapshot',
      'routed_at',
    ]) {
      expect(table).toMatch(new RegExp(`\\b${column}\\b`));
    }

    for (const code of ['a', 'b', 'c', 'rejected', 'error']) {
      expect(table).toContain(`'${code}'`);
    }
  });

  it('stores one durable contact event independently of the sending provider', () => {
    const table = sql.match(
      /create table if not exists public\.client_campaign_contact_ledger \((.*?)\);/,
    )?.[1] ?? '';

    for (const column of [
      'client_user_id',
      'append_batch_id',
      'batch_index',
      'domain_snapshot_id',
      'domain',
      'company_name',
      'email',
      'source_kind',
      'source_run_id',
      'source_job_id',
      'source_row_id',
      'score',
      'score_code',
      'campaign_id',
      'campaign_name_snapshot',
      'submitted_at',
      'append_status',
      'skip_reason',
      'external_contact_id',
      'legacy_inferred',
    ]) {
      expect(table).toMatch(new RegExp(`\\b${column}\\b`));
    }

    for (const status of ['submitted', 'accepted', 'skipped', 'failed']) {
      expect(table).toContain(`'${status}'`);
    }
  });

  it('stores confirmed bulk append counts even when accepted contact identities are unavailable', () => {
    const table = sql.match(
      /create table if not exists public\.client_campaign_append_batches \((.*?)\);/,
    )?.[1] ?? '';

    for (const column of [
      'client_user_id',
      'campaign_id',
      'campaign_name_snapshot',
      'score_code',
      'source_kind',
      'source_run_id',
      'requested_count',
      'accepted_count',
      'skipped_count',
      'blocked_count',
      'tariff_skipped_count',
      'identity_complete',
      'accepted_identities',
      'status',
      'started_at',
      'finished_at',
      'error_message',
    ]) {
      expect(table).toMatch(new RegExp(`\\b${column}\\b`));
    }

    for (const code of ['a', 'b', 'c', 'rejected', 'error']) {
      expect(table).toContain(`'${code}'`);
    }

    for (const status of ['submitted', 'completed', 'failed']) {
      expect(table).toContain(`'${status}'`);
    }

    expect(table).toContain('identity_complete boolean not null default false');
    expect(table).toMatch(/jsonb_array_length\(accepted_identities\) = accepted_count/);
    expect(sql).toContain(
      'comment on column public.client_campaign_append_batches.identity_complete is',
    );
  });

  it('replays the append-batch foreign key safely and fails closed on a conflicting constraint', () => {
    const guard = sql.match(
      /do \$\$(.*?)client_campaign_contact_ledger_append_batch_id_fkey(.*?)\$\$;/,
    )?.[0] ?? '';

    expect(guard).toContain(
      "where c.conrelid = 'public.client_campaign_contact_ledger'::regclass",
    );
    expect(guard).toContain(
      "c.conname = 'client_campaign_contact_ledger_append_batch_id_fkey'",
    );
    expect(guard).toMatch(
      /if not found then alter table public\.client_campaign_contact_ledger add constraint client_campaign_contact_ledger_append_batch_id_fkey/,
    );
    expect(guard).toContain("existing_constraint.contype <> 'f'");
    expect(guard).toContain(
      "existing_constraint.confrelid <> 'public.client_campaign_append_batches'::regclass",
    );
    expect(guard).toContain("attname = 'append_batch_id'");
    expect(guard).toContain("attname = 'id'");
    expect(guard).toContain('not existing_constraint.convalidated');
    expect(guard).toContain(
      "raise exception 'existing constraint client_campaign_contact_ledger_append_batch_id_fkey does not match the required foreign key'",
    );
  });

  it('models asynchronous exports with filters, storage integrity and lifecycle timestamps', () => {
    const table = sql.match(
      /create table if not exists public\.client_report_export_jobs \((.*?)\);/,
    )?.[1] ?? '';

    for (const column of [
      'client_user_id',
      'kind',
      'filters',
      'status',
      'row_count',
      'storage_key',
      'checksum_sha256',
      'error_message',
      'created_at',
      'updated_at',
      'started_at',
      'finished_at',
      'expires_at',
    ]) {
      expect(table).toMatch(new RegExp(`\\b${column}\\b`));
    }

    for (const status of ['pending', 'running', 'completed', 'failed', 'cancelled']) {
      expect(table).toContain(`'${status}'`);
    }

    for (const kind of ['rejected', 'working', 'submitted']) {
      expect(table).toContain(`'${kind}'`);
    }

    expect(sql).toMatch(
      /create trigger [^;]+ before update on public\.client_report_export_jobs for each row execute function public\.set_updated_at\(\)/,
    );
  });

  it('adds composite indexes for period, campaign, score, source and export queue lookups', () => {
    expect(sql).toMatch(
      /on public\.client_pipeline_domain_snapshots \(client_user_id, scored_at desc\)/,
    );
    expect(sql).toMatch(
      /on public\.client_pipeline_domain_snapshots \(client_user_id, score_code, scored_at desc\)/,
    );
    expect(sql).toMatch(
      /on public\.client_pipeline_domain_snapshots \(client_user_id, source_job_id, score_code\)/,
    );
    expect(sql).toMatch(
      /on public\.client_pipeline_domain_snapshots \(client_user_id, routed_campaign_id, routed_at desc\)/,
    );
    expect(sql).toMatch(
      /on public\.client_campaign_contact_ledger \(client_user_id, campaign_id, submitted_at desc\)/,
    );
    expect(sql).toMatch(
      /on public\.client_campaign_contact_ledger \(client_user_id, score_code, submitted_at desc\)/,
    );
    expect(sql).toMatch(
      /on public\.client_campaign_contact_ledger \(client_user_id, source_job_id, append_status\)/,
    );
    expect(sql).toMatch(
      /on public\.client_campaign_append_batches \(client_user_id, finished_at desc\)/,
    );
    expect(sql).toMatch(
      /on public\.client_campaign_append_batches \(campaign_id, finished_at desc\)/,
    );
    expect(sql).toMatch(
      /on public\.client_report_export_jobs \(status, created_at\)/,
    );
  });

  it('allows only one active export per client and export kind', () => {
    expect(sql).toMatch(
      /create unique index if not exists [^;]+ on public\.client_report_export_jobs \(client_user_id, kind\) where status in \('pending', 'running'\)/,
    );
  });

  it('allows clients to select only their rows and reserves writes for service_role', () => {
    for (const table of [
      'client_pipeline_domain_snapshots',
      'client_campaign_contact_ledger',
      'client_campaign_append_batches',
      'client_report_export_jobs',
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toMatch(
        new RegExp(
          `create policy [^;]+ on public\\.${table} for select to authenticated using \\(client_user_id = auth\\.uid\\(\\)\\)`,
        ),
      );
      expect(sql).toContain(`grant select on public.${table} to authenticated`);
      expect(sql).toContain(`grant all on public.${table} to service_role`);
      expect(sql).toContain(`revoke all on public.${table} from authenticated`);
      expect(sql).not.toMatch(
        new RegExp(`grant (insert|update|delete|all)[^;]*public\\.${table}[^;]*to authenticated`),
      );
    }
  });

  it('blocks mutation of immutable facts and permits only one terminal batch transition', () => {
    expect(sql).toContain('create or replace function public.prevent_client_report_history_mutation()');
    expect(sql).toContain("raise exception 'client report history is append-only'");

    for (const table of [
      'client_pipeline_domain_snapshots',
      'client_campaign_contact_ledger',
    ]) {
      expect(sql).toMatch(
        new RegExp(
          `create trigger [^;]+ before update or delete on public\\.${table} for each row execute function public\\.prevent_client_report_history_mutation\\(\\)`,
        ),
      );
      expect(sql).toMatch(
        new RegExp(
          `create trigger [^;]+ before truncate on public\\.${table} for each statement execute function public\\.prevent_client_report_history_mutation\\(\\)`,
        ),
      );
    }


    expect(sql).toContain('create or replace function public.guard_client_campaign_append_batch_transition()');
    expect(sql).toContain("old.status = 'submitted'");
    expect(sql).toContain("new.status in ('completed', 'failed')");
    expect(sql).toMatch(
      /create trigger [^;]+ before update on public\.client_campaign_append_batches for each row execute function public\.guard_client_campaign_append_batch_transition\(\)/,
    );
    expect(sql).toMatch(
      /create trigger [^;]+ before delete on public\.client_campaign_append_batches for each row execute function public\.prevent_client_report_history_mutation\(\)/,
    );
    expect(sql).toMatch(
      /create trigger [^;]+ before truncate on public\.client_campaign_append_batches for each statement execute function public\.prevent_client_report_history_mutation\(\)/,
    );
  });

  it('atomically derives terminal per-contact events from the frozen submitted identities', () => {
    expect(sql).toContain('create or replace function public.append_client_campaign_terminal_events()');
    expect(sql).toContain('insert into public.client_campaign_contact_ledger');
    expect(sql).toContain("source.append_status = 'submitted'");
    expect(sql).toContain('jsonb_array_elements(new.accepted_identities)');
    expect(sql).toContain('source.batch_index');
    expect(sql).toContain("then 'accepted'");
    expect(sql).toContain("then 'skipped'");
    expect(sql).toContain("then 'failed'");
    expect(sql).toMatch(
      /create trigger [^;]+ after update of status on public\.client_campaign_append_batches for each row execute function public\.append_client_campaign_terminal_events\(\)/,
    );
  });

  it('accepts a completed batch only when every submitted row and accepted identity is structurally valid', () => {
    const guard = sql.match(
      /create or replace function public\.guard_client_campaign_append_batch_transition\(\)(.*?)\$\$;/,
    )?.[1] ?? '';

    expect(guard).toContain("new.status = 'completed'");
    expect(guard).toContain('public.client_campaign_contact_ledger');
    expect(guard).toContain("append_status = 'submitted'");
    expect(guard).toContain('count(*)');
    expect(guard).toContain('new.requested_count');
    expect(guard).toContain('count(distinct batch_index)');

    expect(guard).toContain('jsonb_array_elements(new.accepted_identities)');
    expect(guard).toContain("jsonb_typeof(identity) <> 'object'");
    expect(guard).toContain("jsonb_typeof(identity->'index') <> 'number'");
    expect(guard).toMatch(/identity->>'index'[^;]+\^\(0\|\[1-9\]\[0-9\]\*\)\$/);
    expect(guard).toContain("(identity->>'index')::numeric >= new.requested_count");
    expect(guard).toContain("count(distinct (identity->>'index')::numeric)");

    expect(guard).toContain("jsonb_typeof(identity->'email') <> 'string'");
    expect(guard).toContain("lower(btrim(identity->>'email'))");
    expect(guard).toContain('lower(btrim(source.email))');
    expect(guard).toContain('source.batch_index');
  });
});
