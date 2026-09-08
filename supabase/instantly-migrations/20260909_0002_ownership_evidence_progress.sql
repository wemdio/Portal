-- Instantly operational database. Recovery scans must resume provider cursors
-- after throttling or a restart.
-- Contains only relevant reply-context evidence, never an account-wide inbox.
create table if not exists public.instantly_ownership_evidence_progress (
  checkpoint_key text primary key check (checkpoint_key ~ '^[a-f0-9]{64}$'),
  revision bigint not null default 0 check (revision >= 0),
  progress jsonb not null check (jsonb_typeof(progress) = 'object'),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now(),
  constraint instantly_ownership_evidence_progress_payload_size
    check (octet_length(progress::text) <= 2200000)
);

create index if not exists instantly_ownership_evidence_progress_expires_idx
  on public.instantly_ownership_evidence_progress (expires_at);

alter table public.instantly_ownership_evidence_progress enable row level security;
revoke all on public.instantly_ownership_evidence_progress from public;
-- Hosted Supabase and the self-hosted operational database expose different
-- roles. A grant alone is insufficient when the worker is not BYPASSRLS.
do $$
declare v_role text;
begin
  foreach v_role in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('revoke all on public.instantly_ownership_evidence_progress from %I', v_role);
    end if;
  end loop;
  foreach v_role in array array['service_role', 'instantly'] loop
    if exists (select 1 from pg_roles where rolname = v_role) then
      execute format('grant select, insert, update, delete on public.instantly_ownership_evidence_progress to %I', v_role);
      execute format('drop policy if exists %I on public.instantly_ownership_evidence_progress',
        'instantly_ownership_evidence_' || v_role);
      execute format('create policy %I on public.instantly_ownership_evidence_progress for all to %I using (true) with check (true)',
        'instantly_ownership_evidence_' || v_role, v_role);
    end if;
  end loop;
end;
$$;

comment on table public.instantly_ownership_evidence_progress is
  'Service-only bounded ownership proof and independent search/sent cursors; keyed by account, immutable reply input, mailbox and campaign-owner scope hash.';
