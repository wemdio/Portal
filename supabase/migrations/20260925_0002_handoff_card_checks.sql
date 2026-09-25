-- Проверка карточки AMO при передаче проекта (спека 2026-09-25-handoff-card-check-design.md).
create table if not exists public.handoff_card_checks (
  id uuid primary key default gen_random_uuid(),
  chat_id bigint not null,
  message_id bigint not null,
  thread_id bigint,
  amo_id bigint,
  message_text text,
  author text,
  stated_amount numeric(14,2),
  stated_source text,
  status text not null check (status in ('ok', 'problems', 'no_link', 'resolved', 'expired')),
  problems jsonb not null default '[]'::jsonb,
  reply_message_id bigint,
  first_checked_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  reminded_at timestamptz,
  resolved_at timestamptz,
  unique (chat_id, message_id)
);
create index if not exists idx_handoff_card_checks_open
  on public.handoff_card_checks(status, first_checked_at) where status in ('problems', 'no_link');
alter table public.handoff_card_checks enable row level security;
grant all on public.handoff_card_checks to service_role;

-- Другие сделки воронки с тем же ИНН: при дубле платёж станет «спорным» и
-- не отнесётся ни к одной сделке (та же нормализация, что в first_sales_payments).
create or replace function public.handoff_inn_duplicates(p_pipeline_id bigint, p_inn text, p_exclude_amo_id bigint)
returns table (amo_id bigint, name text)
language sql
stable
set statement_timeout = '15s'
as $$
  select l.amo_id, l.name
  from public.amo_leads l
  where l.pipeline_id = p_pipeline_id
    and l.amo_id <> p_exclude_amo_id
    and public.norm_inn(public.amo_custom_field_value(l.raw, 'ИНН')) = p_inn
  limit 10;
$$;
revoke all on function public.handoff_inn_duplicates(bigint, text, bigint) from public;
grant execute on function public.handoff_inn_duplicates(bigint, text, bigint) to service_role;
