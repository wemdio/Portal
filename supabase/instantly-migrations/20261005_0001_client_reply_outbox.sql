-- Instantly /emails/test accepts replies to out-of-campaign inbound messages,
-- but does not create a sent Unibox email. Keep a client-scoped audit of the
-- exact destination and acceptance state so the reply remains visible in Portal.
create table if not exists public.client_reply_outbox (
  id uuid primary key,
  client_user_id uuid not null,
  campaign_id text not null,
  source_email_id text not null,
  lead_email text not null,
  from_email text not null,
  to_email text not null,
  all_recipients text[] not null,
  subject text not null,
  body_text text not null,
  status text not null check (status in ('sending', 'accepted', 'failed')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  failed_at timestamptz
);

create index if not exists client_reply_outbox_conversation_idx
  on public.client_reply_outbox (client_user_id, campaign_id, lead_email, created_at desc);

alter table public.client_reply_outbox enable row level security;
drop policy if exists "Service role full access on client_reply_outbox" on public.client_reply_outbox;
create policy "Service role full access on client_reply_outbox"
  on public.client_reply_outbox for all using (true) with check (true);

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant select, insert, update on public.client_reply_outbox to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    grant select, insert, update on public.client_reply_outbox to instantly;
  end if;
end $$;

notify pgrst, 'reload schema';
