-- VE2: куда идут запуски — Instantly или «Рассылка» (решение владельца 24.10.2026).
--
-- Новые запуски вертикалей переводятся на свою «Рассылку». Выбор делается один
-- раз, при запуске (verticalEngineV2/senderTransport/transport.ts), записывается
-- в сам запуск (ve_templates.launch_info.transport) и отсюда — в строки очереди,
-- после чего не меняется: идущие запуски никуда не переезжают. Всё, что было до
-- этой миграции, и любые запуски Instantly — 'instantly', прежним кодом.
--
-- Сама по себе миграция ничего не меняет: везде 'instantly', выбор никто не читает.

-- ─── Переключатель по рынку ────────────────────────────────────────────────
-- instantly — все новые запуски в Instantly (главнее переопределения проекта:
--   это и есть аварийный выключатель); pilot — в «Рассылку» только проекты с
--   переопределением 'sender'; sender — все, кроме переопределённых 'instantly'.
-- sender_uploads_enabled — подача контактов в кампании «Рассылки» (выключатель
--   подачи, не трогающий Instantly).
create table if not exists public.ve_launch_transport_settings (
  market                 text primary key check (market in ('ru', 'us')),
  mode                   text not null default 'instantly' check (mode in ('instantly', 'pilot', 'sender')),
  sender_uploads_enabled boolean not null default true,
  note                   text,
  updated_by             uuid,
  updated_at             timestamptz not null default now()
);

insert into public.ve_launch_transport_settings (market) values ('ru'), ('us')
on conflict (market) do nothing;

alter table public.ve_launch_transport_settings enable row level security;
revoke all on public.ve_launch_transport_settings from public, anon, authenticated;
grant all on public.ve_launch_transport_settings to service_role;

comment on table public.ve_launch_transport_settings is
  'VE2 launch transport switch per market: instantly (default, kill switch), pilot (only projects overridden to sender), sender (all but projects overridden to instantly).';

-- ─── Переопределение на проекте ────────────────────────────────────────────
alter table public.ve_projects
  add column if not exists launch_transport_override text;

alter table public.ve_projects
  drop constraint if exists ve_projects_launch_transport_override_check;
alter table public.ve_projects
  add constraint ve_projects_launch_transport_override_check
  check (launch_transport_override is null or launch_transport_override in ('instantly', 'sender'));

comment on column public.ve_projects.launch_transport_override is
  'Per-project override of the VE2 launch transport; null — follow the market switch.';

-- ─── Рассыльщик запуска в строках очереди ──────────────────────────────────
alter table public.ve_launch_queue_items
  add column if not exists transport text not null default 'instantly';
alter table public.ve_launch_queue_items
  drop constraint if exists ve_launch_queue_items_transport_check;
alter table public.ve_launch_queue_items
  add constraint ve_launch_queue_items_transport_check check (transport in ('instantly', 'sender'));

alter table public.ve_launch_queue_campaigns
  add column if not exists transport text not null default 'instantly';
alter table public.ve_launch_queue_campaigns
  drop constraint if exists ve_launch_queue_campaigns_transport_check;
alter table public.ve_launch_queue_campaigns
  add constraint ve_launch_queue_campaigns_transport_check check (transport in ('instantly', 'sender'));

create index if not exists ve_launch_queue_campaigns_sender_idx
  on public.ve_launch_queue_campaigns (campaign_id)
  where transport = 'sender';

-- Строку очереди пишет ve_finalize_* уже после записи launch_info в шаблон, в
-- той же транзакции: рассыльщик берётся оттуда, и сами функции завершения
-- запуска не переписываются. Менять рассыльщик у готовой строки нельзя.
create or replace function public.ve_launch_queue_item_transport()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_transport text;
begin
  if tg_op = 'INSERT' then
    select coalesce(nullif(btrim(t.launch_info ->> 'transport'), ''), 'instantly')
      into v_transport
      from public.ve_templates t
     where t.id = new.template_id;
    v_transport := coalesce(v_transport, 'instantly');
    if v_transport not in ('instantly', 'sender') then
      raise exception 'VE2 launch transport % is unknown', v_transport;
    end if;
    new.transport := v_transport;
  elsif new.transport is distinct from old.transport then
    raise exception 'VE2 launch transport is immutable';
  end if;
  return new;
end;
$$;

create or replace function public.ve_launch_queue_campaign_transport()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    new.transport := coalesce(
      (select i.transport from public.ve_launch_queue_items i where i.id = new.item_id),
      'instantly'
    );
  elsif new.transport is distinct from old.transport then
    raise exception 'VE2 launch transport is immutable';
  end if;
  return new;
end;
$$;

drop trigger if exists ve_launch_queue_items_transport on public.ve_launch_queue_items;
create trigger ve_launch_queue_items_transport
  before insert or update of transport on public.ve_launch_queue_items
  for each row execute function public.ve_launch_queue_item_transport();

drop trigger if exists ve_launch_queue_campaigns_transport on public.ve_launch_queue_campaigns;
create trigger ve_launch_queue_campaigns_transport
  before insert or update of transport on public.ve_launch_queue_campaigns
  for each row execute function public.ve_launch_queue_campaign_transport();

revoke all on function public.ve_launch_queue_item_transport() from public, anon, authenticated;
revoke all on function public.ve_launch_queue_campaign_transport() from public, anon, authenticated;
