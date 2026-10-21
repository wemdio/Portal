-- Project-scoped DNC. No workspace-wide Instantly blocklist writes.
create table public.project_contact_blocks (
  project_id uuid not null,
  email text not null check (email = lower(btrim(email)) and position('@' in email) > 1),
  created_by uuid,
  created_at timestamptz not null default now(),
  version bigint not null default 1,
  synced_version bigint not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  primary key (project_id, email)
);
alter table public.project_contact_blocks enable row level security;
revoke all on public.project_contact_blocks from public;

create function public.project_contact_block_enqueue(p_project_id uuid, p_email text, p_created_by uuid)
returns void language sql security definer set search_path = pg_catalog as $$
  insert into public.project_contact_blocks(project_id, email, created_by)
  values (p_project_id, lower(btrim(p_email)), p_created_by)
  on conflict (project_id, email) do update
    set version = project_contact_blocks.version + 1, next_attempt_at = now(), last_error = null;
$$;

-- One MVCC snapshot; only returns requested addresses, not the whole blocklist.
create function public.project_contact_blocked_emails(p_campaign_ids text[], p_emails text[])
returns jsonb language sql stable security definer set search_path = pg_catalog as $$
  select coalesce(jsonb_agg(distinct b.email), '[]'::jsonb)
  from public.project_contact_blocks b
  join (
    select project_id, campaign_id from public.project_instantly_campaigns
    union
    select project_id, campaign_id from public.project_period_instantly_campaigns
  ) links on links.project_id = b.project_id
  where links.campaign_id = any(p_campaign_ids) and b.email = any(p_emails);
$$;

-- Lease one durable request; a crash is retried after five minutes.
create function public.project_contact_block_claim()
returns jsonb language plpgsql security definer set search_path = pg_catalog as $$
declare v public.project_contact_blocks;
begin
  select * into v from public.project_contact_blocks
  where synced_version < version and next_attempt_at <= now()
  order by next_attempt_at for update skip locked limit 1;
  if not found then return null; end if;
  update public.project_contact_blocks set next_attempt_at = now() + interval '5 minutes'
  where project_id = v.project_id and email = v.email;
  return to_jsonb(v);
end;
$$;

-- A block may be added while a provider import is in flight.
create function public.project_contact_blocks_after_import(p_campaign_ids text[], p_emails text[])
returns void language sql security definer set search_path = pg_catalog as $$
  update public.project_contact_blocks b set version = version + 1, next_attempt_at = now()
  where b.email = any(p_emails) and b.project_id in (
    select project_id from public.project_instantly_campaigns where campaign_id = any(p_campaign_ids)
    union
    select project_id from public.project_period_instantly_campaigns where campaign_id = any(p_campaign_ids)
  );
$$;

-- New campaigns/periods must inherit the project's existing blocks.
create function public.project_contact_blocks_on_link()
returns trigger language plpgsql security definer set search_path = pg_catalog as $$
begin
  if tg_op = 'UPDATE' and new.project_id = old.project_id and new.campaign_id = old.campaign_id then
    return new;
  end if;
  update public.project_contact_blocks set version = version + 1, next_attempt_at = now()
  where project_id = new.project_id;
  return new;
end;
$$;
create trigger project_contact_blocks_legacy_link
after insert or update of project_id, campaign_id on public.project_instantly_campaigns
for each row execute function public.project_contact_blocks_on_link();
create trigger project_contact_blocks_period_link
after insert or update of project_id, campaign_id on public.project_period_instantly_campaigns
for each row execute function public.project_contact_blocks_on_link();

revoke all on function public.project_contact_block_enqueue(uuid,text,uuid) from public;
revoke all on function public.project_contact_blocked_emails(text[],text[]) from public;
revoke all on function public.project_contact_block_claim() from public;
revoke all on function public.project_contact_blocks_after_import(text[],text[]) from public;
revoke all on function public.project_contact_blocks_on_link() from public;
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke all on public.project_contact_blocks from %I', r);
    end if;
  end loop;
  foreach r in array array['service_role','instantly'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant all on public.project_contact_blocks to %I', r);
      execute format('grant execute on function public.project_contact_block_enqueue(uuid,text,uuid) to %I', r);
      execute format('grant execute on function public.project_contact_blocked_emails(text[],text[]) to %I', r);
      execute format('grant execute on function public.project_contact_block_claim() to %I', r);
      execute format('grant execute on function public.project_contact_blocks_after_import(text[],text[]) to %I', r);
      execute format('create policy %I on public.project_contact_blocks to %I using (true) with check (true)', 'project_contact_blocks_' || r, r);
    end if;
  end loop;
end $$;
