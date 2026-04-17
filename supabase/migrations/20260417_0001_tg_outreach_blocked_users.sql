-- TG Outreach: global per-portal-user blocklist by tg_user_id.
-- Fixes the case where adding "to blacklist" only affected one campaign / one account
-- (or did nothing when the spammer had no Telegram username).

create table if not exists public.tg_outreach_blocked_users (
  user_id uuid not null references public.profiles(id) on delete cascade,
  tg_user_id bigint not null,
  tg_username text,
  reason text,
  created_at timestamptz not null default now(),
  primary key (user_id, tg_user_id)
);

create index if not exists tg_outreach_blocked_users_user_idx
  on public.tg_outreach_blocked_users (user_id);

alter table public.tg_outreach_blocked_users enable row level security;

create policy tg_outreach_blocked_users_select_own on public.tg_outreach_blocked_users
  for select to authenticated using (user_id = auth.uid());
create policy tg_outreach_blocked_users_insert_own on public.tg_outreach_blocked_users
  for insert to authenticated with check (user_id = auth.uid());
create policy tg_outreach_blocked_users_update_own on public.tg_outreach_blocked_users
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy tg_outreach_blocked_users_delete_own on public.tg_outreach_blocked_users
  for delete to authenticated using (user_id = auth.uid());

-- Helper index for the bulk-disable query: UPDATE tg_outreach_dialogs SET can_send=false WHERE tg_user_id = ?
create index if not exists tg_outreach_dialogs_tg_user_id_idx
  on public.tg_outreach_dialogs (tg_user_id);
