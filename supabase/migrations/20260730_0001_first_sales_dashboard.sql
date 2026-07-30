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
  updated_by   uuid references public.profiles(id) on delete set null,
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
--
-- Верхняя граница `sort < 10000` на КАЖДОМ пороговом сравнении обязательна.
-- Статусы 142 «Успешно реализовано» (sort 10000) и 143 «Закрыто и не
-- реализовано» (sort 11000) — терминальные, не этапы воронки, но
-- арифметически проходят любой `>= N`. Без границы сделка, брошенная в минус
-- на первом контакте, получала бы first_meeting_at/first_contract_at равными
-- дате закрытия — ровно эта ошибка уже ловилась в отчёте продаж на реальных
-- цифрах (см. коммит 60ac8a1e: «у меня они попадали, потому что
-- sort=11000 >= любого порога»). Сделка, реально дошедшая до этапа, оставляет
-- промежуточное событие — оно и засчитается; факт выигрыша живёт отдельно в
-- won_at (из closed_at), эта граница на него не влияет.
create or replace view public.amo_lead_stage_dates_v as
with ev as (
  select
    e.amo_deal_id,
    e.changed_at,
    -- Защищённое приведение: nullif снимает только пустую строку, а битый
    -- импорт/ручной бэкфилл может занести нечисловой from_value/to_value.
    -- Без регекса один такой event роняет invalid input syntax for type
    -- bigint на ВЕСЬ SELECT из view, а не на одну строку — дашборд отдаёт
    -- 500 целиком.
    case when e.from_value ~ '^[0-9]+$' then e.from_value::bigint end as from_status,
    case when e.to_value   ~ '^[0-9]+$' then e.to_value::bigint   end as to_status,
    row_number() over (partition by e.amo_deal_id order by e.changed_at) as rn
  from public.amo_events e
  where e.event_type = 'lead_status_changed'
),
horizon as (
  -- Дата, раньше которой событий смены этапа у нас нет. Сделки, созданные до
  -- неё, могли иметь переходы, которых мы не видели.
  --
  -- Считаем от ev, а не отдельным select по amo_events с собственным
  -- `where event_type = 'lead_status_changed'`: литерал должен жить РОВНО в
  -- одном месте. Раньше он был продублирован здесь и в ev независимо — если
  -- бы его поправили только в одной из двух копий, history_complete начал бы
  -- считаться по другому набору событий, чем reached и initial_status,
  -- молча и без ошибки. amo_events помимо переходов хранит и задачи, и
  -- заметки (см. комментарий к таблице в 20260706_0003) — без этого фильтра
  -- горизонт уехал бы вниз при первой же синхронизированной заметке.
  select min(changed_at) as first_event_at from ev
),
initial_status as (
  -- LEFT JOIN вместо коррелированного скалярного подзапроса на ev: ev
  -- упоминается в этом запросе не единожды, поэтому Postgres материализует
  -- её и не инлайнит — подзапрос `where ev.amo_deal_id = ...` пересканировал
  -- бы весь tuplestore на каждую сделку (O(сделки × события) на каждое
  -- чтение view). JOIN по (amo_deal_id, rn=1) — один проход.
  --
  -- Явный CASE, а не coalesce(first_ev.from_status, l.status_id): это два
  -- разных факта, и схлопывать их в одно поле нельзя.
  --   - Событий нет вовсе (first_ev.amo_deal_id is null) — законный повод
  --     взять текущий статус сделки: сделка не двигалась с момента, откуда
  --     мы её видим.
  --   - Событие есть, но from_value не прошёл регекс в ev (from_status
  --     вышел NULL) — это НЕ повод считать сделку находящейся в текущем
  --     статусе с самого начала. Для сделки, которая сейчас высоко в
  --     воронке, coalesce тут задним числом приписал бы
  --     first_meeting_at/first_contract_at = created_at, выдумав встречу,
  --     которой не было. history_complete этого не ловит — она про глубину
  --     истории по времени, а не про валидность данных внутри неё.
  --
  -- Поэтому при битом первом событии status_id уходит в NULL: сравнения
  -- init_s.sort >= N ниже дают UNKNOWN, CASE в финальном select уходит в
  -- ELSE, и даты берутся из r.ev_*_at — то есть из фактических событий,
  -- а не из угадывания.
  select
    l.amo_id as amo_deal_id,
    case
      when first_ev.amo_deal_id is null then l.status_id
      else first_ev.from_status
    end as status_id
  from public.amo_leads l
  left join ev first_ev
    on first_ev.amo_deal_id = l.amo_id and first_ev.rn = 1
),
reached as (
  select
    ev.amo_deal_id,
    min(ev.changed_at) filter (where s.sort >= 40  and s.sort < 10000) as ev_qualified_at,
    min(ev.changed_at) filter (where s.sort >= 70  and s.sort < 10000) as ev_meeting_at,
    min(ev.changed_at) filter (where s.sort >= 100 and s.sort < 10000) as ev_invoice_at,
    min(ev.changed_at) filter (where s.sort >= 110 and s.sort < 10000) as ev_contract_at
  from ev
  join public.amo_leads l on l.amo_id = ev.amo_deal_id
  join public.amo_statuses s
    on s.pipeline_id = l.pipeline_id
   and s.status_id = ev.to_status
  group by ev.amo_deal_id
)
select
  l.amo_id                                        as amo_deal_id,
  l.pipeline_id,
  l.created_at,
  case when init_s.sort >= 40  and init_s.sort < 10000 then l.created_at else r.ev_qualified_at end as first_qualified_at,
  case when init_s.sort >= 70  and init_s.sort < 10000 then l.created_at else r.ev_meeting_at   end as first_meeting_at,
  case when init_s.sort >= 100 and init_s.sort < 10000 then l.created_at else r.ev_invoice_at   end as first_invoice_at,
  case when init_s.sort >= 110 and init_s.sort < 10000 then l.created_at else r.ev_contract_at  end as first_contract_at,
  -- Дата оплаты берётся из closed_at, а не из событий: он синкается с 2024 года
  -- и достоверен для всей истории. Средний цикл поэтому не зависит от глубины
  -- событий AMO.
  case when l.status_id = 142 then l.closed_at end as won_at,
  -- coalesce(..., false): l.created_at nullable, и при первом true-операнде
  -- true И l.created_at IS NULL даёт UNKNOWN (NULL), а не false — TypeScript
  -- сторона объявляет history_complete как boolean, NULL туда не годится.
  coalesce(h.first_event_at is not null and l.created_at >= h.first_event_at, false) as history_complete
from public.amo_leads l
cross join horizon h
left join initial_status i on i.amo_deal_id = l.amo_id
left join public.amo_statuses init_s
       on init_s.pipeline_id = l.pipeline_id
      and init_s.status_id = i.status_id
left join reached r on r.amo_deal_id = l.amo_id;

alter view public.amo_lead_stage_dates_v set (security_invoker = on);

comment on view public.amo_lead_stage_dates_v is
  'Когда сделка ВПЕРВЫЕ дошла до каждого этапа. Проскок этапа засчитывается, терминальные статусы (142/143, sort>=10000) в пороги не считаются. history_complete=false — сделка создана раньше глубины событий, её этапы считать нельзя.';

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
