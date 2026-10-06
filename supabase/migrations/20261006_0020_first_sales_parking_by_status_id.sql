-- Первичка опознаёт этапы по id, а не по названию и не по зашитому порядку.
--
-- Повод: 02.10.2026 продажи переименовали этап «Квалифицированный лид» в «Лид
-- квалифицирован», и пятничный отчёт упал. Здесь «Перенос» искался по
-- названию: переименуй его — и дашборд первички молча снова начал бы считать
-- запаркованные сделки квалами и встречами. Id при переименовании не меняется.
--
-- 63387178 — «Перенос» в «Воронке - новые лиды»; в других воронках этапа с
-- таким названием нет (в «Работе с базой» — «перенос на потом», его и прежнее
-- условие не трогало), так что цифры не меняются.
--
-- Пороги «квал / встреча / счёт / договор» раньше были зашиты числами
-- 40 / 70 / 100 / 110 (номера этапов). Вставь продажи этап посередине или
-- переставь этапы — номера сдвинутся, и пороги молча начнут ловить не те
-- этапы. Теперь порог — номер самого опорного этапа «Воронки - новые лиды» по
-- его id (CTE `anchors`): 87397290 «Лид квалифицирован», 65917186 «Встреча
-- проведена + КП отправлено», 63386002 «Отправлен счет», 65954530
-- «Согласование договора». Сегодня их номера ровно 40 / 70 / 100 / 110, так
-- что цифры не меняются (как и раньше, к сделкам других воронок применяются
-- те же числа). Удалят опорный этап — порог станет NULL и метрика обнулится
-- на дашборде, а не соврёт.
--
-- 10000 оставлено числом: это системные «Успешно» / «Закрыто» AMO, их место
-- в воронке менять нельзя.
--
-- Тело view повторяет 20260911_0001 целиком; отличия — CTE `anchors`, пороги
-- из него, условие на id «Переноса» вместо названия и снятый join с
-- `amo_statuses` в CTE `reached` (нужен был только ради названия).

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
