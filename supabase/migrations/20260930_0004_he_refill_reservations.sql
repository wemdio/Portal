-- ВНИМАНИЕ, ПОРЯДОК ВЫКАТА: ЭТА МИГРАЦИЯ ИДЁТ ПЕРВОЙ, КОД — ВТОРЫМ.
-- Бронь fail-closed (lib/hypothesisEngine/stages/baseCollectRefill.ts,
-- reserveRefillDailyBudget): пока этих функций нет в БД, КАЖДЫЙ ночной долив
-- уходит в отказ и не отправляет ни строки, хотя сбор уже оплачен. Код,
-- выкаченный раньше миграции, — это не «деградация», а остановленный ночной
-- добор всех ENG-проектов до конца выката. Обратный порядок безопасен: пустые
-- таблицы и неиспользуемые функции ничего не меняют.
--
-- ENG («Движок вертикалей», he_*): дневной бюджет ночного добора становится
-- БРОНЬЮ, а не разностью двух чтений журнала.
--
-- ЗАЧЕМ. Сегодня объём долива режется так: прочитать сумму `stats.appended` по
-- сегодняшним прогонам (`he_auto_pipeline_runs`), вычесть из
-- `he_auto_pipeline_configs.daily_leads_cap`, отправить остаток
-- (lib/hypothesisEngine/stages/baseCollectRefill.ts, шаг 5). Между чтением и
-- отправкой нет ничего, что мешало бы ВТОРОМУ прогону той же джобы прочитать
-- тот же остаток: `resetStuckJobs()` воркера (worker/hypothesisEngine.ts) на
-- старте закрывает каждую оставшуюся 'running' джобу типизированным
-- HeJobInterruptionError('restart'), а writeJobFailure возвращает её в
-- 'pending' бесплатно (до HE_JOB_FREE_INTERRUPTIONS = 5 подряд) — тот же сбор
-- едет в Instantly ещё раз. Кап — это деньги клиента и репутация его доменов,
-- поэтому решение «сколько можно отправить» обязано приниматься под
-- сериализацией, а не в двух независимых прогонах.
--
-- ЧЕМ ЭТОТ ПОВТОР ЯВЛЯЕТСЯ ЧАЩЕ ВСЕГО. Последовательным: процесс умер, новый
-- подобрал его джобу. Двумя ОДНОВРЕМЕННЫМИ прогонами они становятся только при
-- перекрытии деплоя. Безусловного bulk-апдейта «все running → pending» у ENG
-- нет с волны 3 (он остался у V2, worker/verticalEngineV2.ts). Различить эти
-- два случая нечем, кроме ВОЗРАСТА открытой брони, — lease/heartbeat у ENG нет,
-- а идентификатор джобы у наследника ТОТ ЖЕ (resetStuckJobs возвращает в
-- 'pending' ту же строку). Поэтому у своей же брони есть окно перехвата:
-- ДВА ЧАСА (константа `v_takeover_after` в § 3). Открытая бронь моложе окна —
-- живой двойник, второй порции бюджета он не получает ('already_reserved');
-- старше — предшественник мёртв, и та же база забирает бронь себе
-- ('reclaimed'), как забирала её при прежней арифметике двух чтений.
--
-- ПОЧЕМУ ДВА ЧАСА. Окно обязано быть длиннее ЦЕЛОГО прогона долива, иначе оно
-- объявит мёртвым живого. Самое долгое законное молчание стадии — сторож
-- простоя воркера, max(20 мин, 1,5 × срок одного вызова модели) ≤ 30 мин
-- (worker/hypothesisEngine.ts, stageIdleTimeoutMs), плюс 2 мин на раскрутку
-- прерванной стадии (POST_STAGE_DEADLINE_MS); сам участок «бронь → закрытие»
-- короче: пачка ночи ≤ 200 строк уходит одним чанком со сроком 90 с на запрос.
-- Два часа — примерно четырёхкратный запас к худшему законному случаю и всё
-- ещё сильно меньше UTC-суток, на которые бронь иначе застревает.
--
-- ЧЕГО ОКНО НЕ ДЕЛАЕТ. Оно НЕ освобождает объём зависшей брони для ДРУГИХ баз:
-- в сумме занятого (§ 3) открытая бронь считается полностью до конца суток,
-- сколько бы ни висела. Разница принципиальная: у своей базы повторная
-- отправка тех же адресов отсекается провайдером (skipIfInCampaign=true, те же
-- строки той же базы), а у чужой базы адреса ДРУГИЕ — там освобождение чужого
-- объёма означало бы настоящую отправку поверх капа, которую не отозвать.
-- Цену за это платит ночь, а не компании: вертикаль, получившая
-- 'cap_exhausted' или 'already_reserved', НИЧЕГО не отправляет и поэтому
-- завершается отказом, возвращающим её компании в пул (правило волны 1
-- «упавший долив освобождает свои компании», runHeRefillAppend).
--
-- КАК. Бронь берётся ОДНИМ вызовом до первого запроса к рассыльщику: под
-- advisory-локом «проект + UTC-день» функция замораживает кап дня, суммирует
-- уже занятое и выдаёт остаток. После долива вызывается финализация, которая
-- записывает фактически потраченное и освобождает неиспользованное.
--
-- ИНВАРИАНТ БЕЗОПАСНОЙ СТОРОНЫ: незавершённая бронь занимает ВЕСЬ свой объём до
-- конца UTC-суток для всех, кроме СВОЕЙ ЖЕ базы после окна перехвата. Упавший
-- посреди ночи воркер поэтому даёт НЕДОотправку (её видно в воронке), а не
-- отправку поверх капа — вернуть лишнее письмо нельзя, а недоотправленное
-- уедет следующей ночью либо тем же прогоном после перехвата.
--
-- ЧЕГО ЗДЕСЬ НЕТ. Построчного журнала доставки здесь нет и быть не должно: он
-- уже есть и он ОБЩИЙ — `client_campaign_contact_ledger` (строка на лида,
-- `append_status submitted|accepted|skipped|failed`) плюс
-- `client_campaign_append_batches` на чанк, миграция 20260806_0001. Завести
-- рядом второй он значило бы завести второй источник правды, который умеет
-- разъехаться с клиентской отчётностью. Эти две таблицы — про БЮДЖЕТ дня, а не
-- про судьбу строки.
--
-- МИГРАЦИЯ НЕ ПРИМЕНЕНА И ПРИМЕНЯЕТСЯ ПЕРВОЙ (см. банер в первых строках). Код
-- брони fail-closed: не получилось забронировать — долив уходит в отказ и НЕ
-- отправляет ничего (провайдер строк не видел → база 'failed' → её компании
-- возвращаются в пул и уедут следующей ночью). Это осознанный выбор стороны:
-- цена отказа — ещё одна ночь сбора, цена fail-open — письма поверх капа.
-- Порядок выката поэтому прежний и обязателен: СНАЧАЛА миграция, ПОТОМ код.

-- ─── 1. Замороженный кап дня ─────────────────────────────────────────────
-- Первая бронь проекта за UTC-день фиксирует кап, с которым этот день живёт.
-- Правка `he_auto_pipeline_configs.daily_leads_cap` среди дня поэтому
-- действует со СЛЕДУЮЩИХ суток: иначе две параллельные брони, прочитавшие
-- разные капы, дали бы арифметику, которую нельзя объяснить постфактум.

create table if not exists public.he_refill_daily_budgets (
  project_id  uuid not null references public.he_projects(id) on delete cascade,
  budget_date date not null,
  daily_cap   integer not null check (daily_cap >= 0),
  created_at  timestamptz not null default now(),
  primary key (project_id, budget_date)
);

comment on table public.he_refill_daily_budgets is
  'ENG: замороженный на UTC-день кап лидов ночного добора проекта. Правка конфига применяется со следующих суток.';

-- ─── 2. Брони ────────────────────────────────────────────────────────────
-- Одна бронь на (базу, UTC-день): повторный прогон ТОЙ ЖЕ базы второй порции
-- бюджета не получает. Исключения ровно два, и оба про ОДНУ И ТУ ЖЕ базу:
--   * предыдущая бронь ЗАВЕРШЕНА с нулём потраченного — доказано, что
--     провайдер от неё не получил ничего; бронь переоткрывается ('granted');
--   * предыдущая бронь ОТКРЫТА дольше окна перехвата — её держатель мёртв
--     (см. «ПОЧЕМУ ДВА ЧАСА» в шапке); бронь забирает себе новый прогон той же
--     базы ('reclaimed').
-- Каждая выдача возвращает СВЕЖИЙ reservation_id, в том числе при
-- переоткрытии: id действителен ровно для одной выдачи, и закрытие от
-- предыдущего (зомби-)прогона уже не может закрыть чужую бронь — оно упрётся
-- в «reservation not found», а это обрабатываемый исход у вызывающего.

create table if not exists public.he_refill_daily_reservations (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.he_projects(id) on delete cascade,
  -- Снимок идентификатора, СОЗНАТЕЛЬНО без внешнего ключа: удаление базы не
  -- должно стирать бюджет, который её запрос к рассыльщику уже потратил.
  base_id        uuid not null,
  budget_date    date not null,
  reserved_count integer not null check (reserved_count > 0),
  consumed_count integer not null default 0
    check (consumed_count >= 0 and consumed_count <= reserved_count),
  finalized_at   timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (base_id, budget_date)
);

create index if not exists idx_he_refill_daily_reservations_project_day
  on public.he_refill_daily_reservations(project_id, budget_date);

comment on table public.he_refill_daily_reservations is
  'ENG: брони дневного бюджета ночного добора. Незавершённая бронь занимает reserved_count, завершённая — consumed_count.';
comment on column public.he_refill_daily_reservations.finalized_at is
  'NULL — бронь открыта и занимает весь reserved_count до конца UTC-суток (недоотправка безопаснее отправки поверх капа); своя же база может перехватить её после окна перехвата, чужая — нет.';
comment on column public.he_refill_daily_reservations.updated_at is
  'Момент последней выдачи или закрытия. У ОТКРЫТОЙ брони это возраст держателя: старше окна перехвата — держатель мёртв, бронь может забрать новый прогон той же базы.';

-- ─── Права ───────────────────────────────────────────────────────────────
-- Движковые таблицы (he_*/ve_*) браузер напрямую не читает — только API и
-- воркер под service_role. ALTER DEFAULT PRIVILEGES выдаёт anon/authenticated
-- права на каждую новую таблицу раннера миграций, поэтому отзываем их
-- ПОИМЁННО (20260920_0001_he_rls_lockdown.sql, линт app/tests/migrations/
-- grants.test.ts). service_role оставляем: предполёт тика крона
-- (lib/hypothesisEngine/autoPipeline.ts) читает обе таблицы напрямую.

alter table public.he_refill_daily_budgets enable row level security;
alter table public.he_refill_daily_reservations enable row level security;

revoke all privileges on table public.he_refill_daily_budgets from public, anon, authenticated;
revoke all privileges on table public.he_refill_daily_reservations from public, anon, authenticated;
grant all on table public.he_refill_daily_budgets to service_role, postgres;
grant all on table public.he_refill_daily_reservations to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_refill_daily_budgets to readonly';
    execute 'grant select on public.he_refill_daily_reservations to readonly';
  end if;
end $$;

-- ─── 3. Взять бронь ──────────────────────────────────────────────────────
-- Возвращает ОДНУ строку и всегда: `outcome` перечисляет ВЕСЬ набор исходов,
-- чтобы вызывающий не угадывал причину нуля.
--   'granted'          — бронь выдана (reservation_id не NULL, granted > 0);
--                        сюда же переоткрытие доказанно пустой завершённой
--                        брони той же базы — от новой она ничем не отличается;
--   'reclaimed'        — бронь выдана ПЕРЕХВАТОМ собственной брони, открытой
--                        дольше окна: предшественник этой же базы мёртв. От
--                        'granted' отличается тем, что предшественник МОГ
--                        успеть отправить часть строк, не записав об этом
--                        ничего (он умер до закрытия брони и до строки
--                        прогона); повторную отправку тех же адресов отсекает
--                        провайдер (skipIfInCampaign), в capacity воронки она
--                        видна как skipped_instantly, а не как appended;
--   'cap_exhausted'    — дневной кап проекта уже занят другими бронями;
--   'already_reserved' — у ЭТОЙ базы сегодня уже есть бронь моложе окна
--                        перехвата: живой двойник (перекрытие деплоя) либо
--                        наследник, пришедший раньше окна;
--   'nothing_requested'— спросили ноль строк.
-- Нулевые исходы ('cap_exhausted', 'already_reserved', 'nothing_requested') у
-- вызывающего означают одно и то же: ночь не отправит НИ ОДНОЙ строки, поэтому
-- она обязана завершиться отказом, возвращающим компании базы в пул.
-- Кап берётся ТОЛЬКО с сервера (замороженный день либо
-- he_auto_pipeline_configs, либо документированный дефолт 50) — вызывающий
-- подменить его не может.

create or replace function public.he_reserve_refill_daily_budget(
  p_project_id uuid,
  p_base_id uuid,
  p_requested integer
)
returns table(
  reservation_id uuid,
  granted integer,
  budget_date date,
  daily_cap integer,
  spent_before integer,
  outcome text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- Окно перехвата СВОЕЙ брони. Обоснование числа — «ПОЧЕМУ ДВА ЧАСА» в шапке:
  -- оно должно быть длиннее целого прогона долива (≤ 32 мин худшего законного
  -- молчания стадии) и заметно короче UTC-суток, на которые зависшая бронь
  -- иначе запирает ночь.
  v_takeover_after constant interval := interval '2 hours';
  v_day date := (pg_catalog.timezone('UTC', pg_catalog.now()))::date;
  v_cap integer;
  v_config_cap integer;
  v_spent bigint;
  v_granted integer;
  v_existing_id uuid;
  v_existing_consumed integer;
  v_existing_finalized timestamptz;
  v_existing_updated timestamptz;
  v_reclaimed boolean := false;
  v_reservation_id uuid;
begin
  if p_project_id is null or p_base_id is null then
    raise exception 'project and base are required';
  end if;
  if p_requested is null or p_requested < 0 then
    raise exception 'requested must be a non-negative integer';
  end if;
  if p_requested = 0 then
    -- Ничего не спросили — ничего и не замораживаем: день, в котором добор не
    -- отправлял ни строки, не должен получать запись о капе.
    return query select null::uuid, 0, v_day, null::integer, null::integer, 'nothing_requested'::text;
    return;
  end if;

  -- Сериализация решения «сколько можно отправить» — по проекту и UTC-дню.
  -- Лок транзакционный: он снимается вместе с коммитом брони, а не висит.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'he-refill-budget:' || p_project_id::text || ':' || v_day::text,
      0
    )
  );

  -- Бронь берёт только СОБИРАЮЩАЯСЯ авто-база своего проекта: бюджет проекта
  -- нельзя занять от имени чужой или уже завершённой базы.
  if not exists (
    select 1
      from public.he_bases b
     where b.id = p_base_id
       and b.project_id = p_project_id
       and b.source = 'auto'
       and b.status = 'collecting'
  ) then
    raise exception 'collecting ENG refill base does not belong to project';
  end if;

  select b.daily_cap
    into v_cap
    from public.he_refill_daily_budgets b
   where b.project_id = p_project_id
     and b.budget_date = v_day;
  if not found then
    select c.daily_leads_cap
      into v_config_cap
      from public.he_auto_pipeline_configs c
     where c.project_id = p_project_id;
    -- Конфига у проекта может не быть вовсе (таблица пуста, refill поставлен
    -- руками) — тогда работает тот же дефолт, что и в коде,
    -- HE_AUTO_DEFAULT_DAILY_LEADS_CAP. «Нет конфига» здесь НЕ значит «нет капа».
    v_cap := coalesce(v_config_cap, 50);
    if v_cap < 0 then
      raise exception 'configured ENG refill cap must be non-negative';
    end if;
    insert into public.he_refill_daily_budgets (project_id, budget_date, daily_cap)
    values (p_project_id, v_day, v_cap);
  end if;

  select r.id, r.consumed_count, r.finalized_at, r.updated_at
    into v_existing_id, v_existing_consumed, v_existing_finalized, v_existing_updated
    from public.he_refill_daily_reservations r
   where r.base_id = p_base_id
     and r.budget_date = v_day
     for update;

  if v_existing_id is not null then
    if v_existing_finalized is not null and v_existing_consumed = 0 then
      -- Завершена с нулём потраченного: доказано, что провайдер от неё ничего
      -- не получил. Переоткрываем как новую — оплаченный сбор пропадать не
      -- должен.
      v_reclaimed := false;
    elsif v_existing_finalized is null
          and v_existing_updated < pg_catalog.now() - v_takeover_after then
      -- Открыта дольше окна: её держатель не может быть жив (см. шапку).
      -- ПЕРЕХВАТ — иначе смерть воркера между взятием брони и её закрытием
      -- стоила бы ночи целиком: наследник не отправил бы ничего, а компании
      -- базы всё равно были бы отработаны. Предшественник МОГ успеть отправить
      -- часть строк; повтор тех же адресов отсекает сам провайдер
      -- (skipIfInCampaign=true у долива), поэтому перехват возвращает не больше
      -- писем, чем возвращала прежняя арифметика двух чтений журнала.
      v_reclaimed := true;
    else
      -- Бронь моложе окна (живой двойник при перекрытии деплоя или наследник,
      -- пришедший раньше окна) либо завершена с ненулевым расходом (строки
      -- ушли). Второй порции бюджета такой прогон не получает.
      return query select null::uuid, 0, v_day, v_cap, null::integer, 'already_reserved'::text;
      return;
    end if;
  end if;

  -- COALESCE/GREATEST/LEAST — конструкции SQL, а не функции схемы: их нельзя
  -- квалифицировать `pg_catalog.`, и при `search_path = ''` они работают как
  -- есть (pg_catalog всегда неявно первый в поиске функций).
  select coalesce(
           sum(case when r.finalized_at is null then r.reserved_count else r.consumed_count end),
           0
         )
    into v_spent
    from public.he_refill_daily_reservations r
   where r.project_id = p_project_id
     and r.budget_date = v_day
     and (v_existing_id is null or r.id <> v_existing_id);

  v_granted := greatest(0, least(p_requested::bigint, v_cap::bigint - v_spent))::integer;
  if v_granted = 0 then
    return query select null::uuid, 0, v_day, v_cap, v_spent::integer, 'cap_exhausted'::text;
    return;
  end if;

  if v_existing_id is null then
    insert into public.he_refill_daily_reservations (
      project_id, base_id, budget_date, reserved_count
    ) values (
      p_project_id, p_base_id, v_day, v_granted
    )
    returning id into v_reservation_id;
  else
    -- Переоткрытие: либо доказанно пустая завершённая бронь, либо перехват
    -- своей же брони, открытой дольше окна. id меняется — он действителен
    -- ровно для одной выдачи, и закрытие от предыдущего прогона не должно
    -- закрыть бронь нынешнего (см. § 2).
    update public.he_refill_daily_reservations r
       set id = pg_catalog.gen_random_uuid(),
           reserved_count = v_granted,
           consumed_count = 0,
           finalized_at = null,
           updated_at = pg_catalog.now()
     where r.id = v_existing_id
    returning r.id into v_reservation_id;
  end if;

  return query select
    v_reservation_id,
    v_granted,
    v_day,
    v_cap,
    v_spent::integer,
    case when v_reclaimed then 'reclaimed' else 'granted' end::text;
end;
$$;

-- ─── 4. Завершить бронь ──────────────────────────────────────────────────
-- Записывает фактический расход и освобождает неиспользованное. Идемпотентна:
-- повтор с тем же числом молчит, повтор с ДРУГИМ — бросает (расхождение в
-- учёте денег обязано быть видно, а не затираться последним вызовом).
--
-- «Брони не нашли» — НЕ только «такой не было»: после перехвата (§ 3) id
-- сменился, и с прежним id приходит именно зомби-прогон, чью бронь уже забрал
-- живой наследник. Закрывать её его числами нельзя, поэтому исход тот же —
-- исключение; вызывающий его ловит и пишет в лог (finalizeRefillDailyBudget,
-- stages/baseCollectRefill.ts), а объём остаётся занятым нынешним держателем.

create or replace function public.he_finalize_refill_daily_budget(
  p_reservation_id uuid,
  p_base_id uuid,
  p_consumed integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project_id uuid;
  v_day date;
  v_reserved integer;
  v_consumed integer;
  v_finalized_at timestamptz;
begin
  if p_reservation_id is null or p_base_id is null then
    raise exception 'reservation and base are required';
  end if;
  if p_consumed is null or p_consumed < 0 then
    raise exception 'consumed must be a non-negative integer';
  end if;

  select r.project_id, r.budget_date
    into v_project_id, v_day
    from public.he_refill_daily_reservations r
   where r.id = p_reservation_id
     and r.base_id = p_base_id;
  if not found then
    raise exception 'ENG refill reservation not found';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'he-refill-budget:' || v_project_id::text || ':' || v_day::text,
      0
    )
  );

  select r.reserved_count, r.consumed_count, r.finalized_at
    into v_reserved, v_consumed, v_finalized_at
    from public.he_refill_daily_reservations r
   where r.id = p_reservation_id
     and r.base_id = p_base_id
     for update;
  if not found then
    raise exception 'ENG refill reservation not found';
  end if;
  if p_consumed > v_reserved then
    raise exception 'consumed count exceeds reserved ENG refill budget';
  end if;
  if v_finalized_at is not null then
    if p_consumed <> v_consumed then
      raise exception 'ENG refill reservation is already finalized with consumed count %', v_consumed;
    end if;
    return;
  end if;

  update public.he_refill_daily_reservations r
     set consumed_count = p_consumed,
         finalized_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where r.id = p_reservation_id
     and r.base_id = p_base_id;
end;
$$;

revoke all on function public.he_reserve_refill_daily_budget(uuid, uuid, integer)
  from public, anon, authenticated;
revoke all on function public.he_finalize_refill_daily_budget(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.he_reserve_refill_daily_budget(uuid, uuid, integer)
  to service_role, postgres;
grant execute on function public.he_finalize_refill_daily_budget(uuid, uuid, integer)
  to service_role, postgres;
