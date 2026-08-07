-- Первичка считает сделку своей по ИСХОДНОЙ воронке, а не по текущей.
--
-- Повод: 07.08.2026 менеджер вручную перенёс выигранную сделку 32148455 из
-- «Воронка - новые лиды» во «Вторичные (и не только) продажи». Сделка при этом
-- пропала из дашборда первички целиком — вместе с мартовским лидом, встречей и
-- договором. Подтверждено перепиской: «перенесена из воронки "новый лид" в
-- "продление"».
--
-- Ломалось сразу в трёх местах, и фильтр по воронке был лишь самым заметным:
--
--   1. view отдавала `l.pipeline_id` — текущую воронку. Дашборд фильтрует по
--      ней и переставал видеть сделку.
--   2. `reached` искала этапы через `s.pipeline_id = l.pipeline_id`. У
--      переехавшей сделки события ссылаются на этапы СТАРОЙ воронки, а поиск
--      шёл по новой — ни одного совпадения, и все даты этапов становились NULL.
--   3. `won_at` брался как `case when l.status_id = 142`. После переезда
--      текущий статус — этап вторичной воронки, и факт выигрыша исчезал.
--
-- Первое чинится фильтром, второе и третье — нет: там терялись сами данные, а
-- не видимость. Поэтому переписана вся привязка к воронке.
--
-- Почему по исходной, а не «по любой»: сделка принадлежит той воронке, где
-- родилась. Это устойчиво к переносам — и ручным, и будущей автоматике
-- вторичных продаж, которая, по замыслу, должна создавать новую сделку, а не
-- двигать старую.
--
-- Влияние на цифры: за 2026 год перенесена ровно одна сделка (та самая), она
-- вернётся в первичку. Ещё 630 сделок были перенесены разово в 2024–2025 годах
-- («Для Вадима» — 590, «Холод коробка айти» — 40); они тоже вернутся, но в
-- отчёты тех лет, а не в текущие. Ни одна не создана в 2026-м.

-- Этап → его воронка и порядок. Нужна, потому что искать этап в воронке
-- САМОЙ СДЕЛКИ больше нельзя: после переезда это разные воронки.
--
-- `min(...) group by status_id` — не косметика, а защита от размножения строк.
-- Пользовательские номера этапов в AMO уникальны на аккаунт, но если бы номер
-- когда-нибудь встретился в двух воронках, соединение по одному лишь номеру
-- вернуло бы сделку дважды, и дашборд посчитал бы её за две. Группировка
-- гарантирует ровно одну строку на номер.
--
-- 142/143 исключены: это системные «Успешно реализовано» и «Закрыто и не
-- реализовано», они есть в КАЖДОЙ воронке, и по ним воронку определить нельзя.
-- На пороги этапов это не влияет — они и раньше отсекались через sort < 10000.
create or replace view public.amo_status_pipeline_v as
  select
    status_id,
    min(pipeline_id) as pipeline_id,
    min(sort)        as sort
  from public.amo_statuses
  where status_id not in (142, 143)
  group by status_id;

alter view public.amo_status_pipeline_v set (security_invoker = on);

comment on view public.amo_status_pipeline_v is
  'Этап AMO → воронка и порядок, по одной строке на номер этапа. Системные 142/143 исключены: они есть в каждой воронке и воронку не определяют.';

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
  -- одном месте.
  select min(changed_at) as first_event_at from ev
),
initial_status as (
  -- LEFT JOIN вместо коррелированного скалярного подзапроса на ev: ev
  -- упоминается в этом запросе не единожды, поэтому Postgres материализует
  -- её и не инлайнит — подзапрос пересканировал бы весь tuplestore на каждую
  -- сделку (O(сделки × события) на каждое чтение view).
  --
  -- Явный CASE, а не coalesce(first_ev.from_status, l.status_id): это два
  -- разных факта, и схлопывать их в одно поле нельзя.
  --   - Событий нет вовсе — законный повод взять текущий статус сделки.
  --   - Событие есть, но from_value не прошёл регекс — это НЕ повод считать
  --     сделку находящейся в текущем статусе с самого начала: для сделки,
  --     стоящей высоко в воронке, это задним числом выдумало бы встречу.
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
origin as (
  -- Воронка, в которой сделка РОДИЛАСЬ: воронка её первого этапа.
  --
  -- Откат на текущую воронку — когда исходный этап определить нечем: событий
  -- нет, from_value оказался битым, или первым этапом стоит системный 142/143.
  -- Для подавляющего большинства сделок (никогда не переезжавших) обе величины
  -- совпадают, и поведение view не меняется.
  select
    l.amo_id as amo_deal_id,
    coalesce(sp.pipeline_id, l.pipeline_id) as pipeline_id
  from public.amo_leads l
  left join initial_status i on i.amo_deal_id = l.amo_id
  left join public.amo_status_pipeline_v sp on sp.status_id = i.status_id
),
reached as (
  -- Порядок этапа берётся у САМОГО этапа, а не через воронку сделки: у
  -- переехавшей сделки события ссылаются на этапы старой воронки, и поиск по
  -- новой не находил ничего — все даты обнулялись.
  select
    ev.amo_deal_id,
    min(ev.changed_at) filter (where sp.sort >= 40  and sp.sort < 10000) as ev_qualified_at,
    min(ev.changed_at) filter (where sp.sort >= 70  and sp.sort < 10000) as ev_meeting_at,
    min(ev.changed_at) filter (where sp.sort >= 100 and sp.sort < 10000) as ev_invoice_at,
    min(ev.changed_at) filter (where sp.sort >= 110 and sp.sort < 10000) as ev_contract_at,
    -- Момент попадания в «Успешно реализовано» по истории. Нужен как запасной
    -- источник для won_at: после переезда текущий статус сделки уже не 142.
    min(ev.changed_at) filter (where ev.to_status = 142)                 as ev_won_at
  from ev
  left join public.amo_status_pipeline_v sp on sp.status_id = ev.to_status
  group by ev.amo_deal_id
)
select
  l.amo_id                                        as amo_deal_id,
  -- Исходная воронка вместо текущей — суть этой миграции.
  o.pipeline_id,
  l.created_at,
  case when init_s.sort >= 40  and init_s.sort < 10000 then l.created_at else r.ev_qualified_at end as first_qualified_at,
  case when init_s.sort >= 70  and init_s.sort < 10000 then l.created_at else r.ev_meeting_at   end as first_meeting_at,
  case when init_s.sort >= 100 and init_s.sort < 10000 then l.created_at else r.ev_invoice_at   end as first_invoice_at,
  case when init_s.sort >= 110 and init_s.sort < 10000 then l.created_at else r.ev_contract_at  end as first_contract_at,
  -- Дата оплаты по-прежнему из closed_at: он синкается с 2024 года и достоверен
  -- для всей истории, тогда как события уходят вглубь не так далеко.
  --
  -- Откат на историю намеренно узкий — только для сделки, которая УШЛА из своей
  -- исходной воронки и при этом не закрыта как нереализованная.
  --
  -- Широкий откат (просто «была когда-то в 142») проверка на боевых данных
  -- забраковала: он воскресил бы 32 выигрыша у сделок, которые сначала
  -- пометили успешными, а потом закрыли как нереализованные. Продажа
  -- сорвалась, а первичка показала бы её выигранной — метрика поехала бы вверх
  -- на ровном месте. Отдельно отсекается 143 у переехавших: одна такая сделка
  -- нашлась в «Для Вадима».
  coalesce(
    case when l.status_id = 142 then l.closed_at end,
    case
      when l.pipeline_id is distinct from o.pipeline_id and l.status_id <> 143
      then r.ev_won_at
    end
  )                                               as won_at,
  -- coalesce(..., false): l.created_at nullable, и при первом true-операнде
  -- true И l.created_at IS NULL даёт UNKNOWN (NULL), а не false — TypeScript
  -- сторона объявляет history_complete как boolean, NULL туда не годится.
  coalesce(h.first_event_at is not null and l.created_at >= h.first_event_at, false) as history_complete
from public.amo_leads l
cross join horizon h
left join origin o on o.amo_deal_id = l.amo_id
left join initial_status i on i.amo_deal_id = l.amo_id
-- Начальный этап ищем в ИСХОДНОЙ воронке: в текущей его может не быть.
left join public.amo_statuses init_s
       on init_s.pipeline_id = o.pipeline_id
      and init_s.status_id = i.status_id
left join reached r on r.amo_deal_id = l.amo_id;

alter view public.amo_lead_stage_dates_v set (security_invoker = on);

comment on view public.amo_lead_stage_dates_v is
  'Когда сделка ВПЕРВЫЕ дошла до каждого этапа. pipeline_id — воронка, где сделка РОДИЛАСЬ, а не где лежит сейчас: перенос между воронками не должен стирать её историю. Проскок этапа засчитывается, терминальные статусы (142/143) в пороги не считаются. history_complete=false — сделка создана раньше глубины событий, её этапы считать нельзя.';

grant select on public.amo_lead_stage_dates_v to service_role, postgres;
grant select on public.amo_status_pipeline_v  to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.amo_lead_stage_dates_v, public.amo_status_pipeline_v to readonly';
  end if;
end $$;
