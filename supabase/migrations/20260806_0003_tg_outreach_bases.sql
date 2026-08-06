-- Базы контактов для первого касания в TG Outreach.
--
-- До этого портал умел только отвечать в уже существующих диалогах: первое
-- сообщение отправляла TG Ninja, и переписка жила в двух системах. Базы —
-- именованные списки контактов («Гипотеза 1»), по которым кампания шлёт первое
-- сообщение сама.
--
-- Текст сообщения приходит готовым, вместе с контактом: он готовится вне
-- портала и уже прочитан человеком. Портал его не генерирует.

create table if not exists public.tg_outreach_bases (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  name        text not null,
  notes       text not null default '',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists tg_outreach_bases_user_idx
  on public.tg_outreach_bases (user_id, created_at desc);

comment on table public.tg_outreach_bases is
  'Именованный список контактов для первого касания. Имя даёт оператор: «Гипотеза 1».';

create table if not exists public.tg_outreach_base_contacts (
  id           uuid primary key default gen_random_uuid(),
  base_id      uuid not null references public.tg_outreach_bases(id) on delete cascade,
  -- Юзернейм без «@» и в нижнем регистре: единственный ключ, по которому
  -- контакт ищется в Telegram и сверяется с уже обработанными.
  username     text not null,
  message      text not null,
  -- Сырая строка файла целиком. Дёшево и избавляет от повторной загрузки,
  -- если из выгрузки скрапера позже понадобится ещё какое-то поле.
  raw          jsonb not null default '{}'::jsonb,
  status       text not null default 'pending'
    check (status in ('pending', 'sent', 'replied', 'failed', 'skipped')),
  skip_reason  text,
  attempts     integer not null default 0,
  account_id   uuid references public.tg_outreach_accounts(id) on delete set null,
  tg_user_id   bigint,
  sent_at      timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (base_id, username)
);

create index if not exists tg_outreach_base_contacts_base_status_idx
  on public.tg_outreach_base_contacts (base_id, status);

-- Дневной лимит считается «сколько этот аккаунт отправил с начала суток».
create index if not exists tg_outreach_base_contacts_account_sent_idx
  on public.tg_outreach_base_contacts (account_id, sent_at desc)
  where sent_at is not null;

create table if not exists public.tg_outreach_campaign_bases (
  id          uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  base_id     uuid not null references public.tg_outreach_bases(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (campaign_id, base_id)
);

create index if not exists tg_outreach_campaign_bases_campaign_idx
  on public.tg_outreach_campaign_bases (campaign_id);

alter table public.tg_outreach_bases enable row level security;
alter table public.tg_outreach_base_contacts enable row level security;
alter table public.tg_outreach_campaign_bases enable row level security;

-- Политики _all, как у остального tg-outreach (20260320_0003): инструмент
-- командный, базу заводит один специалист, а запускает другой.
create policy tg_outreach_bases_select_all on public.tg_outreach_bases
  for select to authenticated using (true);
create policy tg_outreach_bases_insert_all on public.tg_outreach_bases
  for insert to authenticated with check (true);
create policy tg_outreach_bases_update_all on public.tg_outreach_bases
  for update to authenticated using (true) with check (true);
create policy tg_outreach_bases_delete_all on public.tg_outreach_bases
  for delete to authenticated using (true);

create policy tg_outreach_base_contacts_select_all on public.tg_outreach_base_contacts
  for select to authenticated using (true);
create policy tg_outreach_base_contacts_insert_all on public.tg_outreach_base_contacts
  for insert to authenticated with check (true);
create policy tg_outreach_base_contacts_update_all on public.tg_outreach_base_contacts
  for update to authenticated using (true) with check (true);
create policy tg_outreach_base_contacts_delete_all on public.tg_outreach_base_contacts
  for delete to authenticated using (true);

create policy tg_outreach_campaign_bases_select_all on public.tg_outreach_campaign_bases
  for select to authenticated using (true);
create policy tg_outreach_campaign_bases_insert_all on public.tg_outreach_campaign_bases
  for insert to authenticated with check (true);
create policy tg_outreach_campaign_bases_update_all on public.tg_outreach_campaign_bases
  for update to authenticated using (true) with check (true);
create policy tg_outreach_campaign_bases_delete_all on public.tg_outreach_campaign_bases
  for delete to authenticated using (true);

grant all on public.tg_outreach_bases to service_role;
grant all on public.tg_outreach_base_contacts to service_role;
grant all on public.tg_outreach_campaign_bases to service_role;

grant select, insert, update, delete on public.tg_outreach_bases to authenticated;
grant select, insert, update, delete on public.tg_outreach_base_contacts to authenticated;
grant select, insert, update, delete on public.tg_outreach_campaign_bases to authenticated;
