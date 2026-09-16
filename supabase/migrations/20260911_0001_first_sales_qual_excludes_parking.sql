-- «Перенос» больше не засчитывается ни квалом, ни встречей.
--
-- Повод: 11.09.2026 сверка дашборда первички с отчётом продаж за август —
-- квалы 80 против 58, встречи 83 против 78. Часть расхождения — сделки,
-- которые убрали в «Перенос». В воронке «Воронка - новые лиды» этот этап стоит
-- под номером 90, то есть ниже и «Квалифицированного лида» (40), и «Встречи
-- проведённой» (70), и пороги `sort >= 40` / `sort >= 70` засчитывали такую
-- сделку и квалом, и встречей, хотя ни квала, ни встречи не было. «Перенос» —
-- парковка: карточку кладут туда с любого этапа, и по смыслу это «отложили», а
-- не шаг вперёд. Отчёт продаж (leadsReport, PARKING_STATUS) его этапом не
-- считает уже давно.
--
-- Что меняется: `first_qualified_at` и `first_meeting_at`. Переход в «Перенос»
-- не делает сделку ни квалом, ни встречей; сделка, созданная сразу на
-- «Переносе», — тоже. Если позже сделка всё же дошла до настоящего этапа, квал
-- или встреча засчитываются в момент того перехода.
--
-- Что НЕ меняется: счёт (sort >= 100) и договор (>= 110) — «Перенос» (90) ниже
-- их порогов и на них не влиял.
--
-- Этап опознаётся по названию, а не по номеру: номера у воронок свои (90 в
-- воронке продлений — «Продлено»), а название то же, что ищет leadsReport.
--
-- Влияние на цифры (боевые данные на 11.09.2026, тело view проверено
-- read-only SELECT), вместе с правилами из metrics.ts / meetings.ts:
--   - квалы августа — 61 (квал внутри периода, закрытые в минус не квал,
--     «Перенос» не квал);
--   - встречи августа — 77 по этапу, 78 с встречей по закрытой задаче
--     (fetchTaskMeetings) — ровно цифра отчёта продаж.
--
-- Тело view повторяет 20260813_0004 целиком; отличия — join с
-- `amo_statuses` в CTE `reached` и условие на название в `first_qualified_at`
-- и `first_meeting_at`.

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
    -- «Перенос» — парковка, а не шаг к квалу или встрече: см. заголовок файла.
    min(ev.changed_at) filter (
      where sp.sort >= 40 and sp.sort < 10000 and st.status_name is distinct from 'Перенос'
    )                                                                     as ev_qualified_at,
    min(ev.changed_at) filter (
      where sp.sort >= 70 and sp.sort < 10000 and st.status_name is distinct from 'Перенос'
    )                                                                     as ev_meeting_at,
    min(ev.changed_at) filter (where sp.sort >= 100 and sp.sort < 10000) as ev_invoice_at,
    min(ev.changed_at) filter (where sp.sort >= 110 and sp.sort < 10000) as ev_contract_at,
    -- Момент попадания в «Успешно реализовано» по истории. Нужен как запасной
    -- источник для won_at: после переезда текущий статус сделки уже не 142.
    -- Ограничение по воронке сюда не распространяется — см. заголовок файла.
    min(ev.changed_at) filter (where ev.to_status = 142)                 as ev_won_at
  from ev
  left join origin o on o.amo_deal_id = ev.amo_deal_id
  left join public.amo_status_pipeline_v sp
         on sp.status_id = ev.to_status
        and sp.pipeline_id = o.pipeline_id
  left join public.amo_statuses st
         on st.status_id = ev.to_status
        and st.pipeline_id = o.pipeline_id
  group by ev.amo_deal_id
)
select
  l.amo_id                                        as amo_deal_id,
  -- Исходная воронка вместо текущей — см. 20260807_0002.
  o.pipeline_id,
  l.created_at,
  case
    when init_s.sort >= 40 and init_s.sort < 10000 and init_s.status_name is distinct from 'Перенос'
    then l.created_at
    else r.ev_qualified_at
  end                                                                                              as first_qualified_at,
  case
    when init_s.sort >= 70 and init_s.sort < 10000 and init_s.status_name is distinct from 'Перенос'
    then l.created_at
    else r.ev_meeting_at
  end                                                                                              as first_meeting_at,
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
  'Когда сделка ВПЕРВЫЕ дошла до каждого этапа СВОЕЙ исходной воронки. Этапы чужих воронок (после переноса сделки) в пороги не идут: номера этапов у воронок свои и между воронками несравнимы. Проскок этапа засчитывается, терминальные статусы (142/143, sort>=10000) в пороги не считаются. «Перенос» не делает сделку ни квалом, ни встречей (с 11.09.2026). history_complete=false — сделка создана раньше глубины событий, её этапы считать нельзя.';
