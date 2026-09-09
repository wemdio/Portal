-- Списки прокси внутри кампании.
--
-- До этой таблицы прокси кампании лежали плоским списком из 140+ строк без
-- группировки, и отличить «партия от провайдера A, купленная месяц назад» от
-- «партия от провайдера B, купленная вчера» оператор мог только по имени или
-- глазами по списку. Это не масштабируется: сравнивать, кто из поставщиков
-- живёт дольше, нельзя, а закупать новую партию — значит листать простыню.
--
-- Список — это просто именованная группа прокси кампании. Один прокси = один
-- список (FK на стороне прокси), не many-to-many: прокси не используется в
-- двух кампаниях одновременно и логически принадлежит одной закупке.

create table if not exists public.tg_outreach_proxy_lists (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists tg_outreach_proxy_lists_campaign_idx
  on public.tg_outreach_proxy_lists (campaign_id);

alter table public.tg_outreach_proxy_lists enable row level security;

create policy tg_outreach_proxy_lists_select_own on public.tg_outreach_proxy_lists
  for select to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_proxy_lists_insert_own on public.tg_outreach_proxy_lists
  for insert to authenticated
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_proxy_lists_update_own on public.tg_outreach_proxy_lists
  for update to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()))
  with check (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));
create policy tg_outreach_proxy_lists_delete_own on public.tg_outreach_proxy_lists
  for delete to authenticated
  using (exists (select 1 from public.tg_outreach_campaigns c where c.id = campaign_id and c.user_id = auth.uid()));

grant select, insert, update, delete on public.tg_outreach_proxy_lists to authenticated;
grant select, insert, update, delete on public.tg_outreach_proxy_lists to service_role;

-- FK со стороны прокси. on delete set null, потому что прокси переживают
-- список: если оператор удалил список, прокси не должны исчезнуть из кампании,
-- они просто оказываются в «Неопределённых» (proxy_list_id IS NULL).
--
-- Поле nullable, чтобы старые строки прошли миграцию без бэкфилла: новые
-- прокси без выбранного списка так и остаются в «Неопределённых» — это и есть
-- поведение по умолчанию, к которому привык оператор.

alter table public.tg_outreach_proxies
  add column if not exists proxy_list_id uuid references public.tg_outreach_proxy_lists(id) on delete set null;

create index if not exists tg_outreach_proxies_list_idx
  on public.tg_outreach_proxies (proxy_list_id);
