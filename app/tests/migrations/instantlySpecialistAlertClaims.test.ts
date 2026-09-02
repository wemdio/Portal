/** @jest-environment node */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migrationPath = resolve(
  process.cwd(),
  '../supabase/instantly-migrations/20260902_0001_specialist_alert_thread_claims.sql',
);

describe('Instantly specialist alert thread claims migration', () => {
  const migration = readFileSync(migrationPath, 'utf8').toLowerCase();

  it('stores one durable decision per qualification and only one claimant per project thread', () => {
    expect(migration).toMatch(
      /create table if not exists public\.instantly_specialist_alert_decisions/,
    );
    expect(migration).toMatch(/qualification_id uuid primary key/);
    expect(migration).toMatch(/project_id uuid not null/);
    expect(migration).toMatch(/thread_key text not null/);
    expect(migration).toMatch(/is_claimant boolean not null/);
    expect(migration).toMatch(/winner_qualification_id uuid not null/);
    expect(migration).toMatch(
      /create unique index if not exists [\s\S]*on public\.instantly_specialist_alert_decisions\s*\(project_id, thread_key\)\s*where is_claimant/,
    );
    expect(migration).toMatch(
      /check \(\(is_claimant and winner_qualification_id = qualification_id\)[\s\S]*\(not is_claimant and winner_qualification_id <> qualification_id\)\)/,
    );
  });

  it('normalizes Instantly account prefixes exactly like the application stable thread key', () => {
    expect(migration).toMatch(
      /create or replace function public\.instantly_stable_thread_key\(p_thread_id text\)/,
    );
    expect(migration).toMatch(/btrim\(p_thread_id\) ~\* '\^\[a-z0-9\]\{2\}-\.\+'/);
    expect(migration).toMatch(/substr\(btrim\(p_thread_id\), 4\)/);
    expect(migration).toMatch(/when btrim\(p_thread_id\) = '' then null/);
  });

  it('backfills only already-qualified managed leads with deterministic winners', () => {
    expect(migration).toMatch(/q\.status = 'lead'/);
    expect(migration).toMatch(/q\.qualified_project_owner_proven is true/);
    expect(migration).toMatch(/q\.qualified_project_id is not null/);
    expect(migration).toMatch(
      /row_number\(\) over \(\s*partition by project_id, thread_key\s*order by updated_at asc, qualification_id asc\s*\)/,
    );
    expect(migration).toMatch(
      /first_value\(qualification_id\) over \(\s*partition by project_id, thread_key\s*order by updated_at asc, qualification_id asc\s*\)/,
    );
    expect(migration).toMatch(/where winner_rank = 1/);
    expect(migration).toMatch(/where winner_rank > 1/);
  });

  it('claims atomically and records losing decisions idempotently', () => {
    expect(migration).toMatch(
      /create or replace function public\.claim_instantly_specialist_alert\(\s*p_qualification_id uuid,\s*p_enqueue_handoff boolean default false\s*\)/,
    );
    expect(migration).toMatch(/returns table\s*\(\s*should_alert boolean,/);
    expect(migration).toMatch(/q\.status,\s*q\.qualified_project_id,/);
    expect(migration).toMatch(/v_status <> 'lead'/);
    expect(migration).toMatch(/v_owner_proven is not true/);
    expect(migration).toMatch(/if v_thread_key is null then/);
    expect(migration).toMatch(/v_should_alert := true/);
    expect(migration).toMatch(/v_winner_id := p_qualification_id/);
    expect(migration).toMatch(/v_dedup_applied := false/);
    expect(migration).toMatch(/values \(p_qualification_id, v_project_id, v_thread_key, true, p_qualification_id\)/);
    expect(migration).toMatch(/on conflict do nothing/);
    expect(migration).toMatch(/and d\.is_claimant is true/);
    expect(migration).toMatch(/values \(p_qualification_id, v_project_id, v_thread_key, false, v_winner_id\)/);
  });

  it('stores a leaseable handoff outbox without replaying historical qualifications', () => {
    expect(migration).toMatch(
      /create table if not exists public\.instantly_lead_handoff_outbox/,
    );
    expect(migration).toMatch(
      /qualification_id uuid primary key\s+references public\.instantly_lead_qualifications\(id\) on delete cascade/,
    );
    expect(migration).toMatch(/project_id uuid not null/);
    expect(migration).toMatch(
      /status text not null default 'pending'\s+check \(status in \('pending', 'processing', 'completed', 'skipped', 'dead'\)\)/,
    );
    expect(migration).toMatch(/available_at timestamptz not null default now\(\)/);
    expect(migration).toMatch(/attempts integer not null default 0/);
    expect(migration).toMatch(/lease_token uuid/);
    expect(migration).toMatch(/lease_expires_at timestamptz/);
    expect(migration).toMatch(/outcome text/);
    expect(migration).toMatch(/last_error text/);
    expect(migration).toMatch(/created_at timestamptz not null default now\(\)/);
    expect(migration).toMatch(/updated_at timestamptz not null default now\(\)/);
    expect(migration).toMatch(/completed_at timestamptz/);
    expect(migration).toMatch(
      /alter table public\.instantly_lead_handoff_outbox enable row level security/,
    );

    const claimStart = migration.indexOf(
      'create or replace function public.claim_instantly_specialist_alert',
    );
    expect(claimStart).toBeGreaterThan(-1);
    expect(migration.slice(0, claimStart)).not.toContain(
      'insert into public.instantly_lead_handoff_outbox',
    );
  });

  it('persists the auto-send decision on pending handoffs for crash recovery', () => {
    expect(migration).toMatch(
      /alter table if exists public\.instantly_pending_handoffs\s+add column if not exists auto_send boolean not null default false/,
    );
  });

  it('atomically enqueues only opted-in winning and null-thread qualifications', () => {
    const claimStart = migration.indexOf(
      'create or replace function public.claim_instantly_specialist_alert',
    );
    const leaseStart = migration.indexOf(
      'create or replace function public.lease_instantly_lead_handoff_jobs',
      claimStart,
    );
    const claimFunction = migration.slice(claimStart, leaseStart);

    expect(claimFunction).toMatch(
      /if v_thread_key is null then\s+v_should_alert := true;\s+v_winner_id := p_qualification_id;\s+v_dedup_applied := false;/,
    );
    expect(claimFunction).toMatch(
      /if v_should_alert is true\s+and coalesce\(p_enqueue_handoff, false\) then\s+insert into public\.instantly_lead_handoff_outbox/,
    );
    expect(claimFunction).toMatch(
      /values \(p_qualification_id, v_project_id\)\s+on conflict \(qualification_id\) do nothing/,
    );
    expect(claimFunction.match(/insert into public\.instantly_lead_handoff_outbox/g)).toHaveLength(1);

    const enqueue = claimFunction.indexOf(
      'insert into public.instantly_lead_handoff_outbox',
    );
    const finalReturn = claimFunction.lastIndexOf('return query');
    expect(enqueue).toBeGreaterThan(-1);
    expect(finalReturn).toBeGreaterThan(enqueue);
  });

  it('leases due handoff jobs atomically and reclaims expired processing jobs', () => {
    expect(migration).toMatch(
      /create or replace function public\.lease_instantly_lead_handoff_jobs\(\s*p_limit integer default 2,\s*p_qualification_id uuid default null,\s*p_lease_seconds integer default 1800\s*\)/,
    );
    expect(migration).toMatch(/returns table \(\s*qualification_id uuid,\s*project_id uuid,/);
    expect(migration).toMatch(
      /o\.status = 'pending'\s+and o\.available_at <= v_now/,
    );
    expect(migration).toMatch(
      /o\.status = 'processing'\s+and o\.lease_expires_at <= v_now/,
    );
    expect(migration).toMatch(/for update of o skip locked/);
    expect(migration).toMatch(/attempts = o\.attempts \+ 1/);
    expect(migration).toMatch(/lease_token = gen_random_uuid\(\)/);
    expect(migration).toMatch(/lease_expires_at = v_now \+ make_interval/);
  });

  it('finishes jobs only with the active lease and reschedules retries', () => {
    expect(migration).toMatch(
      /create or replace function public\.finish_instantly_lead_handoff_job\(\s*p_qualification_id uuid,\s*p_lease_token uuid,\s*p_disposition text,\s*p_outcome text default null,\s*p_error text default null,\s*p_retry_at timestamptz default null\s*\)/,
    );
    expect(migration).toMatch(
      /p_disposition is null\s+or p_disposition not in \('completed', 'skipped', 'retry', 'dead'\)/,
    );
    expect(migration).toMatch(
      /where o\.qualification_id = p_qualification_id\s+and o\.status = 'processing'\s+and o\.lease_token = p_lease_token/,
    );
    expect(migration).toMatch(/when p_disposition = 'retry' then 'pending'/);
    expect(migration).toMatch(/available_at = case\s+when p_disposition = 'retry'/);
    expect(migration).toMatch(/lease_token = null/);
    expect(migration).toMatch(/lease_expires_at = null/);
  });

  it('keeps the RPC service-only and fixes its search path', () => {
    expect(migration).toMatch(/security definer\s+set search_path = pg_catalog, public/);
    expect(migration).toMatch(/alter table public\.instantly_specialist_alert_decisions enable row level security/);
    expect(migration).toMatch(/revoke all on function public\.claim_instantly_specialist_alert\(uuid, boolean\)\s+from public/);
    expect(migration).toMatch(/revoke all on table public\.instantly_lead_handoff_outbox\s+from public/);
    expect(migration).toMatch(/if exists \(select 1 from pg_roles where rolname = 'service_role'\)/);
    expect(migration).toMatch(/if exists \(select 1 from pg_roles where rolname = 'instantly'\)/);
    expect(migration).toMatch(/if exists \(select 1 from pg_roles where rolname = 'anon'\)/);
    expect(migration).toMatch(/if exists \(select 1 from pg_roles where rolname = 'authenticated'\)/);
    expect(migration).toMatch(
      /grant execute on function public\.claim_instantly_specialist_alert\(uuid, boolean\)\s+to service_role/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.claim_instantly_specialist_alert\(uuid, boolean\)\s+to instantly/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.lease_instantly_lead_handoff_jobs\(integer, uuid, integer\) to service_role/,
    );
    expect(migration).toMatch(
      /grant execute on function public\.finish_instantly_lead_handoff_job\(uuid, uuid, text, text, text, timestamptz\) to instantly/,
    );
    expect(migration).toMatch(/revoke all on table public\.instantly_specialist_alert_decisions\s+from public/);
    expect(migration).not.toMatch(
      /grant [^;]* on table public\.instantly_lead_handoff_outbox/,
    );
  });
});
