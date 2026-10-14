-- «Рассылка»: стоп-лист отдельной кампании.
--
-- Общий стоп-лист (sender_suppressions) запрещает адрес во всех кампаниях — и
-- пополняется сам: отбойники, отказы SMTP, «стоп» в ответе. Иногда нужно
-- уже: клиент кампании попросил не писать своим партнёрам, а в других
-- кампаниях этим адресам писать можно. Отдельная таблица, а не колонка в
-- общей: у общей ключ — адрес, на нём держатся автоматические upsert'ы,
-- статистика и проверка автоаутрича.
--
-- Стоп-лист кампании проверяют те же места, что и общий: заливка базы в
-- кампанию (campaignOps) и планировщик перед каждым письмом цепочки.
create table if not exists public.sender_campaign_suppressions (
  campaign_id uuid not null references public.sender_campaigns(id) on delete cascade,
  email text not null,
  reason text not null default 'manual'
    check (reason in ('hard_bounce', 'unsubscribe', 'manual', 'complaint')),
  note text,
  created_at timestamptz not null default now(),
  primary key (campaign_id, email)
);

-- Планировщик и заливка спрашивают «есть ли эти адреса» в пределах кампании —
-- это первичный ключ; поиск по адресу на экране — по всем кампаниям.
create index if not exists sender_campaign_suppressions_email_idx
  on public.sender_campaign_suppressions (email);

alter table public.sender_campaign_suppressions enable row level security;

grant all on public.sender_campaign_suppressions to service_role;

comment on table public.sender_campaign_suppressions is
  'Sender: per-campaign stop list. Checked together with the global sender_suppressions on recipient import and by the planner before every step.';

-- Экран стоп-листа показывает оба списка одной таблицей с переключателем
-- «глобальный / по кампаниям / все»: постраничность и поиск — одним запросом.
create or replace view public.sender_suppressions_all as
  select s.email, s.reason, s.note, s.created_at,
         null::uuid as campaign_id, null::text as campaign_name
    from public.sender_suppressions s
  union all
  select cs.email, cs.reason, cs.note, cs.created_at,
         cs.campaign_id, c.name as campaign_name
    from public.sender_campaign_suppressions cs
    join public.sender_campaigns c on c.id = cs.campaign_id;

alter view public.sender_suppressions_all set (security_invoker = on);

grant select on public.sender_suppressions_all to service_role;

comment on view public.sender_suppressions_all is
  'Sender stop list screen: global entries (campaign_id null) and per-campaign entries with the campaign name.';
