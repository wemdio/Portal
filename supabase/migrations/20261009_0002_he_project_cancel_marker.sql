-- Долговечная отметка отмены проекта Движка вертикалей (he_*):
-- he_projects.cancelled_at — и автоподъём ENG-баз, который её читает.
--
-- ЗАЧЕМ. Отмену проекта до этой миграции помнили только строки he_jobs: оба
-- роута отмены переводят активные джобы в 'cancelled' с finished_at = момент
-- отмены, и автоподъём (he_auto_resume_transient_bases, 20260929_0001) по
-- такой строке не поднимал базу, упавшую ДО отмены. С 08.10.2026 клиентский
-- роут отмены (api/client/eng/projects/[id]/cancel) отвечает 200 и при НУЛЕ
-- активных джоб — снимает автопилот, ставит паузу ночного добора, валит
-- застрявшие базы — и тогда не оставляет ни одной отменённой джобы. База,
-- упавшая на временном отказе провайдера до такого нажатия, автоподъёмом
-- поднялась бы: клиент остановил проект, а ночь купила бы сборку заново. Из-за
-- этой дыры HE_AUTO_RESUME_TRANSIENT нельзя было включать.
--
-- ЧТО ДЕЛАЕТ МИГРАЦИЯ:
--  1. he_projects.cancelled_at timestamptz — момент последней отмены проекта
--     (каждая отмена переписывает). Пишут: клиентский роут отмены — ВСЕГДА,
--     одной записью с autopilot=false; staff-роут
--     (api/tools/hypothesis-engine/projects/[id]/cancel) — только для
--     market='us' и только когда отменена хоть одна джоба (иначе он, как и
--     раньше, отвечает 409). RU-проектам её не пишет никто.
--     Читают: эта функция (п. 2); ремонт осиротевшей 'collecting'-базы
--     (lib/hypothesisEngine/baseCollectEnqueue.ts, repairHeOrphanCollectingBase:
--     база, созданная не позже отметки, не ремонтируется, а закрывается как
--     отменённая); lib/hypothesisEngine/baseAutoResume.ts проверяет наличие
--     колонки и без неё проход не запускает; поздний импорт сотрудника
--     (lib/hypothesisEngine/validationRetry.ts) базу, упавшую не позже
--     отметки, не возвращает, а без колонки отказывает.
--  2. he_auto_resume_transient_bases пересоздаётся. Тело скопировано из
--     20260929_0001 без изменений, кроме ОДНОГО условия, добавленного дважды —
--     в выборку кандидатов и в CAS апдейта, как и прежнее условие отмены:
--     база с he_bases.updated_at <= he_projects.cancelled_at своего проекта не
--     поднимается. updated_at упавшей базы — момент, когда её свалили (у баз,
--     остановленных самой отменой, он равен отметке: роут пишет обе одним
--     «сейчас»). Отмена, случившаяся ДО падения базы (клиент остановил проект,
--     потом запустил сборку заново, и она упала), подъёму по-прежнему не мешает.
--     Сигнатура, права и прочие условия — прежние.
--
-- Колонка и функция приезжают ОДНОЙ транзакцией (маркера
-- `migrate:no-transaction` нет): «колонка есть» значит «функция новая», и на
-- этом стоит проверка в baseAutoResume.ts.
--
-- ЧАСЫ. Отметку пишет роут (new Date() контейнера portal), updated_at упавшей
-- базы — воркер или стадия (new Date() контейнера worker-hypothesis-engine),
-- created_at базы — default now() самой БД. portal и воркер — сервисы одного
-- docker-compose.prod.yml, то есть одни часы ядра. Если часы разъедутся,
-- сравнение ошибается на величину расхождения в обе стороны: при часах
-- воркера, ушедших вперёд, база, упавшая за эти миллисекунды ДО отмены,
-- выглядит упавшей после неё (тогда её держит только отменённая джоба, если
-- отмена её застала); при отставших — наоборот, лишний отказ подъёму.
--
-- КОД ДО МИГРАЦИИ: клиентский роут при отсутствии колонки (PGRST204/42703)
-- повторяет запись без отметки, staff-роут пропускает её; ремонт сирот без
-- отметки не чинит ничего (база отвечает «уже собирается», как раньше);
-- автоподъём при включённом флаге бросает, не вызвав функцию; поздний импорт
-- сотрудника отказывает (cancel_marker_missing).
--
-- ПРАВА. Новых таблиц и функций нет: колонка живёт правами he_projects
-- (заперта от anon/authenticated в 20260920_0001_he_rls_lockdown.sql), а
-- create or replace сохраняет права функции. Поимённый revoke/grant функции
-- повторён ниже, чтобы файл был самодостаточен и повторный прогон давал то же.
-- Повторный прогон безопасен: `if not exists` + `create or replace`.

alter table public.he_projects
  add column if not exists cancelled_at timestamptz;

comment on column public.he_projects.cancelled_at is
  'Момент последней отмены проекта (клиентский роут отмены — всегда; staff-роут — только market=us). База, упавшая не позже него, автоподъёмом не поднимается; осиротевшая collecting-база, созданная не позже него, не ремонтируется. NULL — проект не отменяли.';

-- ─── Автоподъём: прежняя функция + условие отметки отмены ───────────────
create or replace function public.he_auto_resume_transient_bases(
  p_limit integer default 5,
  p_max_resumes integer default 2,
  p_min_age_minutes integer default 10,
  p_max_age_hours integer default 72,
  p_now timestamptz default now()
) returns table (
  base_id     uuid,
  project_id  uuid,
  vertical_id uuid,
  outcome     text,
  reason      text,
  resumes     integer,
  job_id      uuid
) language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
-- Директива — первой строкой тела (так её показывает документация plpgsql).
-- Зачем: имена трёх выходных колонок совпадают с колонками he_bases/he_jobs.
-- Все ссылки на колонки ниже квалифицированы префиксом таблицы, а директива
-- страхует от промаха — неквалифицированное имя внутри запроса значит КОЛОНКУ,
-- ровно как в обычном SQL.
declare
  v_limit    constant integer  := greatest(1, least(coalesce(p_limit, 5), 20));
  v_max      constant integer  := greatest(1, least(coalesce(p_max_resumes, 2), 5));
  v_cooldown constant interval := make_interval(mins => greatest(1, least(coalesce(p_min_age_minutes, 10), 24 * 60)));
  v_window   constant interval := make_interval(hours => greatest(1, least(coalesce(p_max_age_hours, 72), 14 * 24)));
  item    record;
  v_done    integer := 0;
  v_outcome text;
  v_reason  text;
  v_job_id  uuid;
  -- Статус базы вертикали, из-за которой подъём не нужен ('collecting' —
  -- собирается прямо сейчас, 'analyzing'/'analyzed' — сборка УЖЕ удалась).
  v_busy_status text;
begin
  for item in
    select b.id as base_id,
           b.project_id as base_project_id,
           b.vertical_id as base_vertical_id,
           -- Точка отсчёта «сестра моложе меня» (граница 'superseded').
           b.created_at as base_created_at,
           b.auto_resumes as resumes_before,
           b.auto_resumed_at as resumed_at,
           last_job.payload as job_payload
      from public.he_bases b
      -- Гейт рынка №1. RU-проект не попадает в кандидаты вообще.
      join public.he_projects p on p.id = b.project_id and p.market = 'us'
      -- ПОСЛЕДНЯЯ джоба сборки этой базы: судим по ней, а не по любой из
      -- прошлых. После подъёма последней становится новая (pending) — и база
      -- перестаёт быть кандидатом до её собственного финала.
      join lateral (
        select j.status, j.error, j.payload
          from public.he_jobs j
         where j.project_id = b.project_id
           and j.stage = 'base_collect'
           and j.payload->>'base_id' = b.id::text
         -- id как тайбрейк: две джобы с одинаковым created_at иначе дали бы
         -- неустойчивый выбор «последней».
         order by j.created_at desc, j.id desc
         limit 1
      ) last_job on true
     where b.source = 'auto'
       and b.status = 'failed'
       -- Сбор не доходил до финальной записи: строк у базы нет. Собранная
       -- база с упавшим анализом лечится анализом, а не второй сборкой.
       and b.row_count = 0
       -- Окно: вчерашний блип поднимаем, недельный труп — нет. Это же окно
       -- держит ночной лог коротким.
       and b.updated_at > p_now - v_window
       -- Refill ночного долива — тремя независимыми признаками.
       and coalesce(b.filename, '') not like 'auto-refill%'
       and (b.collect_info -> 'refill') is distinct from 'true'::jsonb
       and (last_job.payload -> 'refill') is distinct from 'true'::jsonb
       -- Финальный фейл именно сборки, и причина — временный отказ провайдера.
       -- Спрашиваем ОБА текста: he_jobs.error (что сказал провайдер) и
       -- he_bases.error (что записали базе). При штатном пути они совпадают, а
       -- расхождение значит, что базу свалил кто-то другой, — тогда не лезем.
       and last_job.status = 'failed'
       and public.he_transient_collect_error(last_job.error)
       and public.he_transient_collect_error(b.error)
       and not exists (
         select 1
           from public.he_jobs a
          where a.project_id = b.project_id
            and a.payload->>'base_id' = b.id::text
            and (
              -- Под базой уже идёт работа.
              a.status in ('pending', 'running')
              -- ОТМЕНА: долговечный факт оба роута отмены пишут именно так.
              or a.status = 'cancelled'
              -- База прошла сборку и жила дальше (анализ, шаблон).
              or a.stage <> 'base_collect'
            )
       )
       -- ОТМЕНА ПРОЕКТА ПОСЛЕ ПАДЕНИЯ БАЗЫ (пункт 1 шапки): её собственных джоб
       -- роут не тронул, но остановлен весь проект.
       and not exists (
         select 1
           from public.he_jobs c
          where c.project_id = b.project_id
            and c.status = 'cancelled'
            and coalesce(c.finished_at, c.updated_at) >= b.updated_at
       )
       -- ОТМЕТКА ОТМЕНЫ ПРОЕКТА (20261009_0002): база, упавшая не позже
       -- последней отмены проекта, не поднимается — и тогда, когда отмена не
       -- застала ни одной активной джобы и отменённой строки не оставила.
       and (p.cancelled_at is null or b.updated_at > p.cancelled_at)
     -- Сначала те, кого ещё не поднимали: бюджет ночи не должен уходить на
     -- обход тех, кто уже упёрся в потолок.
     order by b.auto_resumes, b.updated_at
     limit 200
  loop
    exit when v_done >= v_limit;
    v_outcome := 'refused';
    v_reason := null;
    v_job_id := null;
    v_busy_status := null;

    -- ВЕРТИКАЛЬ УЖЕ ЗАНЯТА ИЛИ УЖЕ ПОДГОТОВЛЕНА — три статуса одним запросом,
    -- потому что все три значат одно: платить за ещё одну сборку этой вертикали
    -- не нужно.
    --  * 'collecting' — partial unique index he_bases_one_collecting_per_vertical
    --    дал бы 23505; спрашиваем ДО записи, чтобы отказ был НАЗВАН.
    --  * 'analyzing'/'analyzed' — сборка вертикали УЖЕ УДАЛАСЬ другой базой.
    --    Это главный путь, а не экзотика: кабинет на временном отказе просит
    --    клиента «start the step again», клиент жмёт «Collect base», и
    --    enqueueHeBaseCollect делает НОВУЮ базу — упавшая ему не конфликт.
    --    Старая при этом остаётся кандидатом все 72 часа окна, и подъём заплатил
    --    бы полную сборку той вертикали, которую клиент уже собрал заново.
    -- Набор статусов и source='auto' — те же, которыми «подготовленность
    -- вертикали» считают автопилот (lib/hypothesisEngine/autopilotNext:
    -- afterChainDone) и клиентский роут запуска. Одно отличие сознательное: те
    -- два вычитают из набора refill-базы долива («auto-refill: …», успешный
    -- долив тоже кончает 'analyzed'), потому что решают, НАЧИНАТЬ ли работу, а
    -- здесь решается, ПЛАТИТЬ ли второй раз. Вертикаль, у которой идут доливы,
    -- давно запущена и основную базу имеет, так что лишний отказ тут бесплатен,
    -- а лишний подъём — нет.
    -- Причина отказа — с ИМЕНЕМ СТАТУСА ('vertical_collecting' как раньше,
    -- 'vertical_analyzing', 'vertical_analyzed'), чтобы ночной лог показывал, ПО
    -- КАКОЙ причине база не поднята, а не только то, что не поднята.
    select o.status into v_busy_status
      from public.he_bases o
     where o.vertical_id = item.base_vertical_id
       and o.source = 'auto'
       and o.status in ('collecting', 'analyzing', 'analyzed')
     order by array_position(array['collecting', 'analyzing', 'analyzed'], o.status)
     limit 1;

    if item.resumes_before >= v_max then
      v_reason := 'resume_cap';
    elsif item.resumed_at is not null and item.resumed_at > p_now - v_cooldown then
      v_reason := 'cooldown';
    elsif v_busy_status is not null then
      v_reason := 'vertical_' || v_busy_status;
    elsif exists (
      -- «Клиент уже перезапустил этот шаг» в самом точном виде: у вертикали есть
      -- БОЛЕЕ МОЛОДАЯ база. Она ловит и то, чего не ловит статус выше: сестра
      -- могла сама упасть ('failed') или ждать анализа ('uploaded'), и поднимать
      -- нужно самую свежую попытку, а не всю их череду.
      -- Refill ночного долива сестрой НЕ считается: долив создаёт базу той же
      -- вертикали каждую ночь (lib/hypothesisEngine/autoPipeline: filename
      -- «auto-refill: …»), и без этой оговорки один долив запретил бы подъёмы
      -- навсегда. Долив — не решение клиента, а добор в уже запущенную кампанию.
      -- Сравнение парой (created_at, id): у двух баз, созданных в одну
      -- микросекунду, иначе не было бы «младшей» вовсе, и обе стали бы
      -- кандидатами.
      select 1 from public.he_bases o
       where o.vertical_id = item.base_vertical_id
         and (o.created_at, o.id) > (item.base_created_at, item.base_id)
         and coalesce(o.filename, '') not like 'auto-refill%'
         and (o.collect_info -> 'refill') is distinct from 'true'::jsonb
    ) then
      v_reason := 'superseded';
    else
      -- Апдейт базы и вставка джобы — в одном блоке с обработчиком: исключение
      -- откатывает ОБА, и осиротевшей 'collecting'-базы без джобы не остаётся.
      begin
        update public.he_bases b
           set status = 'collecting',
               error = null,
               auto_resumes = b.auto_resumes + 1,
               auto_resumed_at = p_now,
               updated_at = p_now
         where b.id = item.base_id
           -- CAS: статус и счётчик те же, что мы читали.
           and b.status = 'failed'
           and b.source = 'auto'
           and b.auto_resumes = item.resumes_before
           -- Гейт рынка №2. Даже ошибка в выборке выше не даст записать
           -- ни одной RU-базы.
           and exists (
             select 1 from public.he_projects p2
              where p2.id = b.project_id and p2.market = 'us'
           )
           -- Отмена проекта после падения базы — второй сеткой в самой записи:
           -- клиент мог нажать отмену между выборкой и этим апдейтом.
           and not exists (
             select 1 from public.he_jobs c
              where c.project_id = b.project_id
                and c.status = 'cancelled'
                and coalesce(c.finished_at, c.updated_at) >= b.updated_at
           )
           -- …и отметка отмены проекта — тоже второй сеткой: отмена при нуле
           -- активных джоб пишет только её.
           and not exists (
             select 1 from public.he_projects pc
              where pc.id = b.project_id
                and pc.cancelled_at is not null
                and b.updated_at <= pc.cancelled_at
           )
           -- Те же две границы, что назвали причину выше, — второй сеткой в
           -- самой записи: вертикаль занята/подготовлена…
           and not exists (
             select 1 from public.he_bases o
              where o.vertical_id = b.vertical_id
                and o.source = 'auto'
                and o.status in ('collecting', 'analyzing', 'analyzed')
           )
           -- …и базу уже заменили более молодой (не-refill) сестрой. Гонка между
           -- предпроверкой и записью здесь означает, что клиент нажал «Collect
           -- base» в эти миллисекунды, — и тогда подъём не состоится ('raced').
           and not exists (
             select 1 from public.he_bases o
              where o.vertical_id = b.vertical_id
                and (o.created_at, o.id) > (b.created_at, b.id)
                and coalesce(o.filename, '') not like 'auto-refill%'
                and (o.collect_info -> 'refill') is distinct from 'true'::jsonb
           );
        if not found then
          v_reason := 'raced';
        else
          -- Новая строка джобы, attempts = 0: start-guard стадии требует
          -- 'collecting', а у старой строки попытки уже сожжены. payload
          -- переносим как есть (base_id, лимит, выбранные гипотезы), сняв
          -- счётчик прерываний волны 3 — серия оборвана этим подъёмом.
          insert into public.he_jobs (project_id, stage, status, attempts, payload)
          values (item.base_project_id, 'base_collect', 'pending', 0, item.job_payload - 'interruptions')
          returning id into v_job_id;
          v_outcome := 'resumed';
          v_done := v_done + 1;
        end if;
      exception when others then
        -- Откатилось всё: и счётчик, и статус базы, и джоба. Ночь просто
        -- называет причину — платной работы не начиналось.
        v_outcome := 'refused';
        v_job_id := null;
        v_reason := 'sql_' || sqlstate;
      end;
    end if;

    return query
      select item.base_id,
             item.base_project_id,
             item.base_vertical_id,
             v_outcome,
             v_reason,
             item.resumes_before + (case when v_outcome = 'resumed' then 1 else 0 end),
             v_job_id;
  end loop;
end $$;

comment on function public.he_auto_resume_transient_bases(integer, integer, integer, integer, timestamptz) is
  'Один проход автоподъёма ENG-баз (market=us), легших на временном отказе провайдера: строка на кандидата, resumed/refused с причиной. Отмена (джоб базы или проекта после падения базы, либо отметка he_projects.cancelled_at не раньше падения базы), refill, решения движка, рынок ru, уже собранная (collecting/analyzing/analyzed) вертикаль и база, заменённая более молодой, не поднимаются. Крон зовёт её только при HE_AUTO_RESUME_TRANSIENT=1 (по умолчанию выключено).';

-- ─── Права ───────────────────────────────────────────────────────────────
-- Как в 20260929_0001: движковую функцию зовёт только крон под service_role,
-- PUBLIC/anon/authenticated — поимённо отозваны.

revoke all privileges on function
  public.he_auto_resume_transient_bases(integer, integer, integer, integer, timestamptz)
  from public, anon, authenticated;

grant execute on function
  public.he_auto_resume_transient_bases(integer, integer, integer, integer, timestamptz)
  to service_role, postgres;
