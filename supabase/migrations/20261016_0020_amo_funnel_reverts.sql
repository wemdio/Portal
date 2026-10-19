-- Отменённые порталом переносы не должны попадать в статистику.
--
-- 16.10.2026: портал следит за порядком этапов «Воронки - новые лиды» и
-- возвращает сделку, перенесённую в запрещённый этап (app/src/lib/amoFunnelGuard).
-- AMO при этом пишет в историю оба перехода — «в запрещённый» и «обратно», и
-- дашборды считали бы такую сделку побывавшей на этапе (квалом, встречей).
-- Откат ПИШЕТ строку в amo_funnel_reverts; view amo_status_events_v отдаёт
-- историю переходов без этой пары, и по ней считают первичка и недельный отчёт.
--
-- Парные события ищем по сделке, паре этапов и окну по времени вокруг отката
-- (откат идёт через секунды после переноса, а при сбое вебхука — страховочным
-- прогоном reconcile, до 3 часов спустя). Вычёркиваем ОБА
-- события: у оставшегося «обратно» from_value был бы запрещённым этапом, и
-- расчёт «этапа создания» по самому раннему переходу ошибся бы.

create table if not exists public.amo_funnel_reverts (
  id bigserial primary key,
  amo_deal_id bigint not null,
  bad_status_id bigint not null,
  restored_status_id bigint not null,
  reverted_at timestamptz not null default now()
);

create index if not exists amo_funnel_reverts_deal_idx
  on public.amo_funnel_reverts (amo_deal_id);

alter table public.amo_funnel_reverts enable row level security;

revoke all on table public.amo_funnel_reverts from anon, authenticated;
grant select, insert, update, delete on table public.amo_funnel_reverts to service_role;
grant usage, select on sequence public.amo_funnel_reverts_id_seq to service_role;

comment on table public.amo_funnel_reverts is
  'Переносы сделок «Воронки - новые лиды», отменённые порталом (amoFunnelGuard). Пара событий из amo_events по ним исключается из статистики через amo_status_events_v.';

create or replace view public.amo_status_events_v as
select e.*
from public.amo_events e
where e.event_type = 'lead_status_changed'
  and not exists (
    select 1
    from public.amo_funnel_reverts r
    where r.amo_deal_id = e.amo_deal_id
      and (
        (e.from_value = r.restored_status_id::text
          and e.to_value = r.bad_status_id::text
          and e.changed_at between r.reverted_at - interval '3 hours' and r.reverted_at)
        or
        (e.from_value = r.bad_status_id::text
          and e.to_value = r.restored_status_id::text
          and e.changed_at between r.reverted_at - interval '1 minute' and r.reverted_at + interval '10 minutes')
      )
  );

alter view public.amo_status_events_v set (security_invoker = on);
revoke all on public.amo_status_events_v from anon;
grant select on public.amo_status_events_v to authenticated, service_role;

comment on view public.amo_status_events_v is
  'Переходы этапов сделок (lead_status_changed) без переносов, отменённых порталом — см. amo_funnel_reverts.';

-- Расчёт этапов первички читает историю через новый view. Тело повторяет
-- 20261006_0020 целиком; отличие одно — источник событий amo_status_events_v.

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
  from public.amo_status_events_v e
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
anchors as (
  -- Номера опорных этапов «Воронки - новые лиды» — по id, см. заголовок файла.
  select
    max(sort) filter (where status_id = 87397290) as qualified_sort,
    max(sort) filter (where status_id = 65917186) as meeting_sort,
    max(sort) filter (where status_id = 63386002) as invoice_sort,
    max(sort) filter (where status_id = 65954530) as contract_sort
  from public.amo_statuses
  where pipeline_id = 7670334
),
reached as (
  -- Порядок этапа берётся у САМОГО этапа (у переехавшей сделки события ведут
  -- в этапы старой воронки, и поиск по текущей не находил бы ничего), но
  -- только если этот этап принадлежит ИСХОДНОЙ воронке сделки.
  --
  -- Без второго условия любой этап любой воронки проходил бы пороги первички
  -- по одному лишь номеру: «Отвал / не продлен» из воронки продлений стоит под
  -- номером 120 и засчитывался договором. Номера этапов у воронок свои, и
  -- сравнивать их между воронками нельзя.
  select
    ev.amo_deal_id,
    -- «Перенос» (63387178) — парковка, а не шаг к квалу или встрече: см. 20260911_0001.
    min(ev.changed_at) filter (
      where sp.sort >= a.qualified_sort and sp.sort < 10000 and ev.to_status is distinct from 63387178
    )                                                                     as ev_qualified_at,
    min(ev.changed_at) filter (
      where sp.sort >= a.meeting_sort and sp.sort < 10000 and ev.to_status is distinct from 63387178
    )                                                                     as ev_meeting_at,
    min(ev.changed_at) filter (where sp.sort >= a.invoice_sort and sp.sort < 10000) as ev_invoice_at,
    min(ev.changed_at) filter (where sp.sort >= a.contract_sort and sp.sort < 10000) as ev_contract_at,
    -- Момент попадания в «Успешно реализовано» по истории. Нужен как запасной
    -- источник для won_at: после переезда текущий статус сделки уже не 142.
    -- Ограничение по воронке сюда не распространяется — см. заголовок файла.
    min(ev.changed_at) filter (where ev.to_status = 142)                 as ev_won_at
  from ev
  cross join anchors a
  left join origin o on o.amo_deal_id = ev.amo_deal_id
  left join public.amo_status_pipeline_v sp
         on sp.status_id = ev.to_status
        and sp.pipeline_id = o.pipeline_id
  group by ev.amo_deal_id
)
select
  l.amo_id                                        as amo_deal_id,
  -- Исходная воронка вместо текущей — см. 20260807_0002.
  o.pipeline_id,
  l.created_at,
  case
    when init_s.sort >= a.qualified_sort and init_s.sort < 10000 and init_s.status_id is distinct from 63387178
    then l.created_at
    else r.ev_qualified_at
  end                                                                                              as first_qualified_at,
  case
    when init_s.sort >= a.meeting_sort and init_s.sort < 10000 and init_s.status_id is distinct from 63387178
    then l.created_at
    else r.ev_meeting_at
  end                                                                                              as first_meeting_at,
  case when init_s.sort >= a.invoice_sort and init_s.sort < 10000 then l.created_at else r.ev_invoice_at   end as first_invoice_at,
  case when init_s.sort >= a.contract_sort and init_s.sort < 10000 then l.created_at else r.ev_contract_at  end as first_contract_at,
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
cross join anchors a
left join origin o on o.amo_deal_id = l.amo_id
left join initial_status i on i.amo_deal_id = l.amo_id
-- Начальный этап ищем в ИСХОДНОЙ воронке: в текущей его может не быть.
left join public.amo_statuses init_s
       on init_s.pipeline_id = o.pipeline_id
      and init_s.status_id = i.status_id
left join reached r on r.amo_deal_id = l.amo_id;

alter view public.amo_lead_stage_dates_v set (security_invoker = on);

comment on view public.amo_lead_stage_dates_v is
  'Когда сделка ВПЕРВЫЕ дошла до каждого этапа СВОЕЙ исходной воронки. Этапы чужих воронок (после переноса сделки) в пороги не идут: номера этапов у воронок свои и между воронками несравнимы. Проскок этапа засчитывается, терминальные статусы (142/143, sort>=10000) в пороги не считаются. «Перенос» не делает сделку ни квалом, ни встречей (с 11.09.2026). history_complete=false — сделка создана раньше глубины событий, её этапы считать нельзя.';
