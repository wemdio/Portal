-- Дашборд первички, этап 1: справочник «источник → канал» и view дат этапов.
-- Спека: docs/superpowers/specs/2026-07-30-first-sales-dashboard-design.md
-- План: docs/superpowers/plans/2026-07-30-first-sales-dashboard-stage1.md, Task 2

-- ─── Справочник свёртки источника в канал ────────────────────────────────

create table if not exists public.lead_source_channels (
  id           bigserial primary key,
  source       text not null,
  channel      text not null default 'unassigned'
                 check (channel in (
                   'marketing','smm','outreach','partners',
                   'tg_outreach','inbound','referral','events','unassigned'
                 )),
  display_name text,
  sort_order   integer not null default 100,
  updated_by   uuid,
  updated_at   timestamptz not null default now()
);

-- source хранится уже нормализованным (trim + lower + ё→е) — так же, как его
-- нормализует sourceChannels.ts. Уникальность именно по нормализованному
-- значению: в AMO «Партнер» и «партнер» — один и тот же источник.
create unique index if not exists uq_lead_source_channels_source
  on public.lead_source_channels(source);

comment on table public.lead_source_channels is
  'Свёртка значения поля «Источник» AMO в канал продаж. Редактируется в портале на /analytics/first-sales. Источник вне справочника трактуется как unassigned.';

-- Первичное наполнение — только бесспорное. Спорные источники (Лидскан, Сайт,
-- Сарафан, Конференция, SEO, Холодная база, TG-посев — 969 сделок за 2026)
-- сознательно заводятся как unassigned: их раскладку согласуют продажи.
insert into public.lead_source_channels (source, display_name, channel, sort_order) values
  ('email outreach',            'Email Outreach',            'outreach',    10),
  ('аутрич',                    'Аутрич',                    'outreach',    11),
  ('партнер',                   'Партнёр',                   'partners',    20),
  ('telegram outreach',         'Telegram Outreach',         'tg_outreach', 30),
  ('smm',                       'SMM',                       'smm',         40),
  ('личный бренд (инст /ютуб)', 'Личный бренд (инст/ютуб)',  'smm',         41),
  ('сайт',                      'Сайт',                      'unassigned',  50),
  ('лидскан',                   'Лидскан',                   'unassigned',  51),
  ('tg-посев',                  'TG-посев',                  'unassigned',  52),
  ('сарафан',                   'Сарафан',                   'unassigned',  53),
  ('телеграм',                  'Телеграм',                  'unassigned',  54),
  ('холодная база',             'Холодная база',             'unassigned',  55),
  ('конференция',               'Конференция',               'unassigned',  56),
  ('тг-канал',                  'ТГ-канал',                  'unassigned',  57),
  ('seo',                       'SEO',                       'unassigned',  58),
  ('тг бот',                    'ТГ Бот',                    'unassigned',  59),
  ('портал (outreachos)',       'Портал (outreachOS)',       'unassigned',  60),
  ('инст-посев',                'Инст-посев',                'unassigned',  61),
  ('бот',                       'Бот',                       'unassigned',  62),
  ('email-рассылка',            'Email-рассылка',            'unassigned',  63),
  ('внешние статьи',            'Внешние статьи',            'unassigned',  64),
  ('pr',                        'PR',                        'unassigned',  65)
on conflict (source) do nothing;

-- ─── Индексы под view ────────────────────────────────────────────────────

-- Колонки НАМЕРЕННО в порядке (event_type, amo_deal_id, changed_at), а не
-- (amo_deal_id, event_type, changed_at) — второй вариант дублировал бы
-- индекс, который Postgres уже создал под `unique (amo_deal_id, event_type,
-- changed_at)` в 20260706_0003. Этот индекс служит другому паттерну: view
-- ниже сперва фильтрует `event_type = 'lead_status_changed'`, а уже потом
-- партиционирует по сделке и сортирует по времени — с amo_deal_id первым
-- столбцом такой фильтр индекс не ускоряет.
create index if not exists idx_amo_events_type_deal_changed on public.amo_events(event_type, amo_deal_id, changed_at);

-- ─── View дат достижения этапов ──────────────────────────────────────────

-- Правило: считаем не переход в конкретный статус, а ПЕРВЫЙ момент, когда
-- сделка оказалась на этапе не ниже порога. Менеджеры проскакивают этапы —
-- двигают сделку сразу в «Отправлен счет», минуя «Встреча проведена».
-- Буквальный подсчёт переходов в статус 70 такие встречи потеряет.
--
-- Сделка, СОЗДАННАЯ сразу на высоком этапе, события не порождает. Поэтому
-- начальный статус восстанавливаем из from_value первого события, а при полном
-- отсутствии событий — из текущего статуса сделки.
create or replace view public.amo_lead_stage_dates_v as
with horizon as (
  -- Дата, раньше которой событий у нас нет. Сделки, созданные до неё, могли
  -- иметь переходы, которых мы не видели.
  select min(changed_at) as first_event_at from public.amo_events
),
ev as (
  select
    e.amo_deal_id,
    e.changed_at,
    e.from_value,
    e.to_value,
    row_number() over (partition by e.amo_deal_id order by e.changed_at) as rn
  from public.amo_events e
  where e.event_type = 'lead_status_changed'
),
initial_status as (
  select
    l.amo_id as amo_deal_id,
    coalesce(
      (select nullif(ev.from_value, '')::bigint from ev
        where ev.amo_deal_id = l.amo_id and ev.rn = 1),
      l.status_id
    ) as status_id
  from public.amo_leads l
),
reached as (
  select
    ev.amo_deal_id,
    min(ev.changed_at) filter (where s.sort >= 40)  as ev_qualified_at,
    min(ev.changed_at) filter (where s.sort >= 70)  as ev_meeting_at,
    min(ev.changed_at) filter (where s.sort >= 100) as ev_invoice_at,
    min(ev.changed_at) filter (where s.sort >= 110) as ev_contract_at
  from ev
  join public.amo_leads l on l.amo_id = ev.amo_deal_id
  join public.amo_statuses s
    on s.pipeline_id = l.pipeline_id
   and s.status_id = nullif(ev.to_value, '')::bigint
  group by ev.amo_deal_id
)
select
  l.amo_id                                        as amo_deal_id,
  l.pipeline_id,
  l.created_at,
  case when init_s.sort >= 40  then l.created_at else r.ev_qualified_at end as first_qualified_at,
  case when init_s.sort >= 70  then l.created_at else r.ev_meeting_at   end as first_meeting_at,
  case when init_s.sort >= 100 then l.created_at else r.ev_invoice_at   end as first_invoice_at,
  case when init_s.sort >= 110 then l.created_at else r.ev_contract_at  end as first_contract_at,
  -- Дата оплаты берётся из closed_at, а не из событий: он синкается с 2024 года
  -- и достоверен для всей истории. Средний цикл поэтому не зависит от глубины
  -- событий AMO.
  case when l.status_id = 142 then l.closed_at end as won_at,
  (h.first_event_at is not null and l.created_at >= h.first_event_at) as history_complete
from public.amo_leads l
cross join horizon h
left join initial_status i on i.amo_deal_id = l.amo_id
left join public.amo_statuses init_s
       on init_s.pipeline_id = l.pipeline_id
      and init_s.status_id = i.status_id
left join reached r on r.amo_deal_id = l.amo_id;

comment on view public.amo_lead_stage_dates_v is
  'Когда сделка ВПЕРВЫЕ дошла до каждого этапа. Проскок этапа засчитывается. history_complete=false — сделка создана раньше глубины событий, её этапы считать нельзя.';

-- ─── RLS и гранты ────────────────────────────────────────────────────────

-- Select-политики для authenticated нет сознательно: данные читает только
-- серверный код под service_role через API-роуты с гардом доступа.
alter table public.lead_source_channels enable row level security;

grant all on public.lead_source_channels to service_role, postgres;
grant usage, select on sequence public.lead_source_channels_id_seq to service_role, postgres;
grant select on public.amo_lead_stage_dates_v to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.lead_source_channels, public.amo_lead_stage_dates_v to readonly';
  end if;
end $$;
