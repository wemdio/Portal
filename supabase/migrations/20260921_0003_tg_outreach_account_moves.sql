-- Перенос аккаунта между кампаниями с обязательной причиной.
--
-- Аккаунты переезжают: партию закупили под один проект, а нужна она в другом,
-- или кампанию закрывают и живые номера забирают. Делали это раньше никак —
-- аккаунт заводили в новой кампании заново, теряя его историю и возраст.
--
-- Причина обязательна и хранится здесь, а не в комментарии к строке: через
-- месяц «почему этот аккаунт из ATOL оказался в Polza» — единственный вопрос,
-- который задают, и ответ на него должен переживать и кампанию, и человека.
create table if not exists public.tg_outreach_account_moves (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  -- Кампании удаляют; запись о переносе должна пережить обе, поэтому здесь
  -- нет внешних ключей, а рядом лежат имена на момент переноса.
  from_campaign_id uuid,
  from_campaign_name text,
  to_campaign_id uuid,
  to_campaign_name text,
  reason text not null,
  moved_by uuid,
  moved_by_name text,
  moved_at timestamptz not null default now()
);

-- История переносов одного аккаунта, свежие сверху.
create index if not exists idx_tg_outreach_account_moves_account
  on public.tg_outreach_account_moves (account_id, moved_at desc);

-- ── Доступ ───────────────────────────────────────────────────────────────────
-- Как у остальных tg_outreach_*: сотрудники читают и пишут общее.
alter table public.tg_outreach_account_moves enable row level security;

drop policy if exists tg_outreach_account_moves_select_all on public.tg_outreach_account_moves;
create policy tg_outreach_account_moves_select_all on public.tg_outreach_account_moves
  for select to authenticated using (true);

drop policy if exists tg_outreach_account_moves_insert_all on public.tg_outreach_account_moves;
create policy tg_outreach_account_moves_insert_all on public.tg_outreach_account_moves
  for insert to authenticated with check (true);

grant all on public.tg_outreach_account_moves to service_role;
grant select, insert on public.tg_outreach_account_moves to authenticated;

comment on table public.tg_outreach_account_moves is
  'History of moving a tg-outreach account between campaigns. Reason is mandatory; campaign names are copied because campaigns get deleted.';
