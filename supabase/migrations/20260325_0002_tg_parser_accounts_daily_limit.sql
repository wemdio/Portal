-- Add daily_limit to tg_parser_accounts (max mailings/operations per day)
alter table public.tg_parser_accounts
  add column if not exists daily_limit integer not null default 30;

-- Track actual daily usage per account
create table if not exists public.tg_parser_account_usage (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.tg_parser_accounts(id) on delete cascade,
  usage_date date not null default current_date,
  sent_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (account_id, usage_date)
);

create index if not exists tg_parser_account_usage_account_date_idx
  on public.tg_parser_account_usage (account_id, usage_date);

alter table public.tg_parser_account_usage enable row level security;

-- RLS: access through account ownership (join to tg_parser_accounts)
create policy tg_parser_account_usage_select_own on public.tg_parser_account_usage
  for select to authenticated
  using (account_id in (select id from public.tg_parser_accounts where user_id = auth.uid()));

create policy tg_parser_account_usage_insert_own on public.tg_parser_account_usage
  for insert to authenticated
  with check (account_id in (select id from public.tg_parser_accounts where user_id = auth.uid()));

create policy tg_parser_account_usage_update_own on public.tg_parser_account_usage
  for update to authenticated
  using (account_id in (select id from public.tg_parser_accounts where user_id = auth.uid()))
  with check (account_id in (select id from public.tg_parser_accounts where user_id = auth.uid()));

-- Helper: atomically increment sent_count, returns new count
create or replace function public.tg_parser_increment_usage(p_account_id uuid)
returns integer
language plpgsql
security definer
as $$
declare
  v_daily_limit integer;
  v_sent integer;
begin
  select daily_limit into v_daily_limit
    from public.tg_parser_accounts
    where id = p_account_id;

  if v_daily_limit is null then
    raise exception 'Account not found';
  end if;

  insert into public.tg_parser_account_usage (account_id, usage_date, sent_count)
    values (p_account_id, current_date, 1)
    on conflict (account_id, usage_date)
    do update set sent_count = tg_parser_account_usage.sent_count + 1
    returning sent_count into v_sent;

  if v_sent > v_daily_limit then
    -- Roll back the increment — limit exceeded
    update public.tg_parser_account_usage
      set sent_count = sent_count - 1
      where account_id = p_account_id and usage_date = current_date;
    raise exception 'Daily limit reached (% / %)', v_sent - 1, v_daily_limit;
  end if;

  return v_sent;
end;
$$;
