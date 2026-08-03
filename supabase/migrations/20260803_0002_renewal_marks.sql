-- Кандидаты продлений и автоподтверждение по тексту задачи AMO.
-- План: docs/superpowers/plans/2026-08-03-renewals-from-payments.md (Task 2)
--
-- Архитектура (см. план целиком): банк даёт ПОЛНЫЙ список кандидатов — ни
-- одна оплата не теряется, — часть подтверждается автоматически по тексту
-- задачи AMO, остальное разбирает человек одним кликом на экране разбора
-- (Task 5, отдельная миграция/PR). renewal_marks хранит только то, что уже
-- решено (автоматом или человеком); сами кандидаты — не отдельная таблица,
-- а вычисляемое множество: приходы с ИНН минус первый платёж от ИНН (см.
-- apply_renewal_marks ниже), которых ещё нет в этой таблице.
--
-- Сквозной пример, на котором проверялась вся логика ниже (ООО «СМАРТВЭЙ»,
-- ИНН 7714379242, сделка 33462035):
--   2025-09-29    84 000   ← первый платёж ИНН, в кандидаты не попадает
--   2026-01-13   179 000   ← кандидат, задачи-подтверждения нет — ждёт человека
--   2026-01-22    20 000   ← другая услуга (Telegram), задачи нет — ждёт человека
--   2026-06-14    84 000   ← задача «Оплатили 84к» — БЕЗ слова «продление», не подтверждается
--   2026-07-30   159 000   ← задача «Оплатили продление 159к» — подтверждается автоматически

-- ─── Таблица разметки ───────────────────────────────────────────────────

create table if not exists public.renewal_marks (
  id             bigserial primary key,
  transaction_id bigint      not null unique
                   references public.bank_transactions(id) on delete cascade,
  is_renewal     boolean     not null,
  method         text        not null
                   check (method in ('task_text','project_type','manual','not_renewal')),
  amo_deal_id    bigint,
  note           text,
  matched_at     timestamptz not null default now(),
  matched_by     uuid references public.profiles(id) on delete set null,

  -- Инвариант отдельным CHECK (а не проверкой в апсерте): is_renewal=false
  -- тогда и только тогда, когда method='not_renewal'. Без него рано или
  -- поздно появится строка «продление = нет» со способом «подтверждено
  -- текстом задачи» — противоречивая комбинация, которую иначе замечают
  -- только на глаз. Тот же приём, что renewal_marks_deal_id_null_iff_…
  -- в 20260731_0002_meeting_deal_links_not_a_meeting.sql, только зеркально:
  -- там инвариант защищал amo_deal_id, здесь — саму булеву метку.
  constraint renewal_marks_is_renewal_false_iff_not_renewal
    check ((is_renewal = false) = (method = 'not_renewal'))
);

comment on table public.renewal_marks is
  'Решение по каждому платежу-кандидату продления: продление это или нет, и чем подтверждено. Строка появляется либо от apply_renewal_marks() (method=task_text|project_type), либо от человека на экране разбора (method=manual|not_renewal). Кандидаты, которых здесь ещё нет, — открытая очередь на разбор, а не отдельная таблица.';
comment on column public.renewal_marks.method is
  'task_text — подтверждено текстом задачи AMO (сильный сигнал, сумма или дата рядом). project_type — подтверждено вторым, более слабым сигналом: у клиента есть проект project_type=Продление с датой оплаты рядом. manual — человек нажал «продление». not_renewal — человек нажал «транш той же оплаты» или «другая услуга» (Task 5); is_renewal при этом всегда false.';
comment on column public.renewal_marks.amo_deal_id is
  'Сделка AMO, чья задача подтвердила продление (method=task_text). NULL у method=project_type — второй сигнал идёт через совпадение имени клиента с projects.client, а не через сделку, поэтому не подменяем его непроверенным ИНН-совпадением. Всегда NULL у not_renewal.';
comment on column public.renewal_marks.note is
  'Чем именно подтвердилось — текст задачи или название проекта. Экран разбора (Task 5) показывает это человеку без похода в AMO.';

-- ─── Извлечение кастомного поля AMO из raw jsonb ────────────────────────
-- Ищем по field_name, а не field_id: id кастомного поля — деталь конкретного
-- аккаунта AMO (пример из docs/portal-db-mcp-guide.md — 1314335 для «ИНН» —
-- прямо предупреждает «ключ зависит от порядка», значит на id полагаться
-- нельзя). Тот же приём, что app/src/lib/leadsReport/extractCustomField.ts
-- на стороне TypeScript — здесь SQL-аналог, нужный внутри apply_renewal_marks.
-- IMMUTABLE и без побочных таблиц — та же оговорка, что у fsd_norm_domain
-- в 20260731_0001_meeting_deal_links.sql: jsonb_array_elements обходит
-- элементы jsonb-массива в его физическом порядке хранения, это чистая
-- функция от входного jsonb, session-настройки не читает.
create or replace function public.amo_custom_field_value(p_raw jsonb, p_field_name text)
returns text language sql immutable as $$
  select nullif(btrim(v ->> 'value'), '')
  from jsonb_array_elements(coalesce(p_raw -> 'custom_fields_values', '[]'::jsonb)) f
  cross join lateral jsonb_array_elements(coalesce(f -> 'values', '[]'::jsonb)) v
  where f ->> 'field_name' = p_field_name
  limit 1
$$;

revoke all on function public.amo_custom_field_value(jsonb, text) from public;
grant execute on function public.amo_custom_field_value(jsonb, text) to service_role, postgres;

comment on function public.amo_custom_field_value(jsonb, text) is
  'Первое значение кастомного поля AMO по имени (не по field_id — id завязан на конкретный аккаунт). NULL, если поля нет или оно пустое.';

-- ─── Разбор суммы из текста задачи ───────────────────────────────────────
-- Менеджеры пишут суммы сокращённо: «159к», «на 149к», «159к.», «300 тыс»,
-- «150 тысяч». Регэксп берёт число (с необязательной десятичной частью —
-- «84,5к» на случай доли тысячи) перед «к»/«к.» либо «тыс» — «тыс» матчится
-- и как префикс «тысяч», отдельно поддерживать не нужно.
--
-- Сознательно НЕ покрыто (см. отчёт по задаче):
--   * полная сумма без сокращения — «159000» или «159 000» — формат из
--     примеров плана всегда с «к», отдельного покрытия не потребовалось;
--   * составные обозначения вида «(80/80)» — это не сумма (похоже на
--     прогресс/долю), в тексте нет «к»/«тыс» — регэксп на них не сработает,
--     и это правильно: подстановка k-суффикса на голое число дала бы
--     непроверяемые совпадения.
-- Текст с НЕСКОЛЬКИМИ числами — не проблема: возвращается МАССИВ всех
-- найденных сумм, и совпадением считается вхождение суммы платежа В массив
-- (ANY), а не единственное найденное число. Лишние числа в тексте, которые
-- не совпали с суммой платежа, просто не мешают.
create or replace function public.renewal_amounts_thousands(v text)
returns numeric[] language sql immutable as $$
  select coalesce(
    array_agg(distinct (replace(m[1], ',', '.'))::numeric * 1000),
    array[]::numeric[]
  )
  from regexp_matches(coalesce(v, ''), '(\d+(?:[.,]\d+)?)\s*(?:к\.?|тыс\.?)', 'gi') as m
$$;

revoke all on function public.renewal_amounts_thousands(text) from public;
grant execute on function public.renewal_amounts_thousands(text) to service_role, postgres;

comment on function public.renewal_amounts_thousands(text) is
  'Суммы в рублях, извлечённые из сокращений вида «159к»/«на 149к.»/«300 тыс» — используется apply_renewal_marks() для сверки текста задачи с суммой платежа. Возвращает массив (текст может содержать несколько чисел); пустой массив, если совпадений нет.';

-- ─── Автоматчер ──────────────────────────────────────────────────────────

create or replace function public.apply_renewal_marks()
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  affected integer;
begin
  with candidates as (
    -- Кандидаты: приходы (is_revenue, credit) с непустым ИНН плательщика,
    -- КРОМЕ первого платежа от этого ИНН — оконная функция ранжирует по
    -- (occurred_at, id) внутри уже отфильтрованного набора (is_revenue +
    -- credit + ИНН заполнен), rn=1 отсекается. «Первый» здесь значит «первый
    -- среди приходов, которые мы вообще считаем кандидатами», а не «первая
    -- вообще любая строка выписки этого контрагента» — см. отчёт по задаче,
    -- пункт про синк банка с 2023 года.
    select ranked.id as transaction_id, ranked.payer_inn, ranked.payer_name,
           ranked.amount, ranked.occurred_at
    from (
      select bt.id, bt.payer_inn, bt.payer_name, bt.amount, bt.occurred_at,
             row_number() over (
               partition by bt.payer_inn
               order by bt.occurred_at asc, bt.id asc
             ) as rn
      from public.bank_transactions bt
      where bt.direction = 'credit'
        and bt.is_revenue
        and coalesce(btrim(bt.payer_inn), '') <> ''
    ) ranked
    where ranked.rn > 1
  ),

  -- Сделки AMO по ИНН плательщика (кастомное поле «ИНН» в amo_leads.raw).
  -- Один ИНН может дать НЕСКОЛЬКО сделок (первичка плюс что-то ещё) — здесь
  -- сознательно не выбирается «правильная»: ниже (task_hits/task_ranked)
  -- задача-подтверждение ищется по ЛЮБОЙ из них, а если под один платёж
  -- подойдёт больше одной задачи (из одной сделки или из разных) — это и
  -- есть обработанная неоднозначность, кандидат остаётся неразмеченным.
  -- Фильтр по candidates.payer_inn — не оптимизация полного скана
  -- amo_leads (без выражение-индекса на amo_custom_field_value его не
  -- избежать), а просто сокращение размера CTE перед джойном.
  deal_inn as (
    select distinct l.amo_id as amo_deal_id, cf.inn
    from public.amo_leads l
    cross join lateral (select public.amo_custom_field_value(l.raw, 'ИНН') as inn) cf
    where cf.inn is not null
      and cf.inn in (select c.payer_inn from candidates c)
  ),

  -- Сигнал 1 (сильный): у сделки этого ИНН есть ВЫПОЛНЕННАЯ задача, чей
  -- result_text содержит «продл»/«пролонг» (регистронезависимо — тот же
  -- регэксп, что в частичном индексе idx_amo_tasks_renewal_candidates из
  -- 20260803_0001_amo_tasks.sql), и выполняется одно из двух:
  --   by_sum  — сумма из текста совпала с суммой платежа. Само по себе
  --             достаточное основание, дата не важна.
  --   by_date — updated_at_amo задачи (МОМЕНТ ПОСЛЕДНЕГО ИЗМЕНЕНИЯ записи,
  --             а НЕ complete_till — тот срок задачи, а не факт закрытия;
  --             см. комментарий к колонке в 20260803_0001_amo_tasks.sql) в
  --             пределах ±14 дней от даты платежа — слабый признак, годится
  --             только вместе со словом «продл»/«пролонг», которое уже
  --             отфильтровано в JOIN.
  task_hits as (
    select
      c.transaction_id,
      di.amo_deal_id,
      t.id as task_id,
      t.result_text,
      (c.amount = any (amt.arr)) as by_sum
    from candidates c
    join deal_inn di on di.inn = c.payer_inn
    join public.amo_tasks t
      on t.amo_deal_id = di.amo_deal_id
     and t.is_completed
     and t.result_text ~* 'продл|пролонг'
     and t.updated_at_amo is not null
    cross join lateral (select public.renewal_amounts_thousands(t.result_text) as arr) amt
    where (c.amount = any (amt.arr))
       or abs(
            (t.updated_at_amo at time zone 'Europe/Moscow')::date
            - (c.occurred_at   at time zone 'Europe/Moscow')::date
          ) <= 14
  ),
  task_ranked as (
    select transaction_id, amo_deal_id, task_id, result_text, by_sum,
           count(*) over (partition by transaction_id) as n
    from task_hits
  ),
  task_confirmed as (
    -- n=1: ровно одна подходящая задача под платёж. n>1 (несколько задач
    -- и/или несколько сделок одного ИНН одновременно подошли) — молчаливый
    -- выбор «первой попавшейся» дал бы цифру, которую невозможно
    -- проверить, поэтому такой кандидат остаётся человеку.
    select transaction_id, amo_deal_id,
           'по тексту задачи (сделка ' || amo_deal_id || '): «'
             || left(coalesce(result_text, ''), 200) || '»'
             || case when by_sum then ' — сумма совпала'
                     else ' — дата рядом (±14 дней)' end as note
    from task_ranked
    where n = 1
  ),

  -- Сигнал 2 (слабее): у клиента есть проект project_type='Продление' с
  -- payment_date рядом с датой платежа. У public.projects НЕТ колонки ИНН
  -- (см. supabase/migrations/20260201_0000_create_projects.sql) и
  -- attribution_payment_project/attribution_amo_project пусты на боевых
  -- (см. docs/superpowers/plans/2026-07-31-renewals-dashboard.md) — поэтому
  -- единственная доступная связка это сравнение свободного текста:
  -- payer_name банка против projects.client. position() в обе стороны (не
  -- LIKE — оба поля от человека и могут содержать % или _), тот же приём,
  -- что в 20260730_0003_apply_expense_rules.sql и 20260731_0001_meeting_deal_links.sql.
  project_hits as (
    select c.transaction_id, p.id as project_id, p.name as project_name
    from candidates c
    join public.bank_transactions bt on bt.id = c.transaction_id
    join public.projects p
      on p.project_type = 'Продление'
     -- projects.payment_date — ТЕКСТ, а не date (см. 20260201_0000_create_projects.sql).
     -- Прямая арифметика `payment_date - date` упала бы в рантайме с «operator
     -- does not exist: text - date», и функция не отработала бы ни разу.
     --
     -- Разбор через CASE, а не через `~` рядом в AND: порядок вычисления
     -- условий в AND не гарантирован, и Postgres вправе выполнить приведение
     -- раньше проверки формата — тогда первая же строка с мусором вместо даты
     -- уронит весь прогон. CASE порядок гарантирует, невалидное даёт null, а
     -- сравнение с null отсекает строку молча и безопасно.
     and abs(
           (case when p.payment_date ~ '^\d{4}-\d{2}-\d{2}$'
                 then p.payment_date::date end)
           - (c.occurred_at at time zone 'Europe/Moscow')::date
         ) <= 14
     and coalesce(btrim(bt.payer_name), '') <> ''
     and coalesce(btrim(p.client), '') <> ''
     and length(btrim(p.client)) > 3
     and (
       position(lower(btrim(p.client)) in lower(btrim(bt.payer_name))) > 0
       or position(lower(btrim(bt.payer_name)) in lower(btrim(p.client))) > 0
     )
  ),
  project_ranked as (
    select transaction_id, project_id, project_name,
           count(*) over (partition by transaction_id) as n
    from project_hits
  ),
  project_confirmed as (
    select pr.transaction_id,
           'по проекту «' || pr.project_name
             || '» (project_type=Продление), дата оплаты рядом (±14 дней)' as note
    from project_ranked pr
    where pr.n = 1
      -- Сигнал 1 сильнее и приоритетнее: если платёж уже подтверждён
      -- текстом задачи, второй сигнал не конкурирует за строку.
      and not exists (
        select 1 from task_confirmed tc where tc.transaction_id = pr.transaction_id
      )
  ),

  resolved as (
    select transaction_id, amo_deal_id, 'task_text'::text as method, note
    from task_confirmed
    union all
    select transaction_id, null::bigint as amo_deal_id, 'project_type'::text as method, note
    from project_confirmed
  )

  insert into public.renewal_marks (transaction_id, is_renewal, method, amo_deal_id, note, matched_at)
  select transaction_id, true, method, amo_deal_id, note, now()
  from resolved
  on conflict (transaction_id) do update
     set is_renewal  = excluded.is_renewal,
         method      = excluded.method,
         amo_deal_id = excluded.amo_deal_id,
         note        = excluded.note,
         matched_at  = now()
   -- Ключевая строка всей задачи: ручное решение неприкосновенно. И
   -- 'manual' (человек нажал «продление»), И 'not_renewal' (человек нажал
   -- «транш»/«другая услуга») — оба РУЧНЫЕ решения, оба обязаны быть в этом
   -- списке. Ровно на этом уже спотыкались в 20260731_0001_meeting_deal_links.sql:
   -- условие `<> 'manual'` не защищало состояние not_a_meeting, и автомат
   -- затирал человеческий вердикт, пока это не поправили в
   -- 20260731_0002_meeting_deal_links_not_a_meeting.sql. Здесь та же ловушка
   -- закрывается сразу, без повторного прохода.
   where public.renewal_marks.method not in ('manual', 'not_renewal');

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.apply_renewal_marks() from public;
grant execute on function public.apply_renewal_marks() to service_role, postgres;

comment on function public.apply_renewal_marks() is
  'Кандидаты — приходы с ИНН, кроме первого от этого ИНН. Автоподтверждение: (1) текст выполненной задачи сделки этого ИНН со словом «продл»/«пролонг» и совпавшей суммой или датой (updated_at_amo) рядом ±14 дней — сильный сигнал; (2) project_type=Продление у проекта того же клиента с датой оплаты рядом — слабый сигнал, применяется только если первый не сработал. Неоднозначные (несколько задач/сделок/проектов) остаются неразмеченными. Ручные решения (method=manual|not_renewal) не перезаписываются никогда.';

-- ─── Новый источник в логе синка ────────────────────────────────────────
-- external_sync_runs.source — CHECK со списком имён; список продолжает
-- актуальный из 20260803_0001_amo_tasks.sql (самая поздняя миграция,
-- трогавшая констрейнт на момент написания), полностью и без сокращений —
-- иначе отвалятся уже работающие источники (тот же довод, что там же).

alter table public.external_sync_runs
  drop constraint if exists external_sync_runs_source_check;

alter table public.external_sync_runs
  add constraint external_sync_runs_source_check
  check (source in (
    'metrika',
    'amo_leads',
    'amo_events',
    'bank_tochka',
    'bank_tbank',
    'attribution',
    'amo_enrich',
    'leads_report_marketing',
    'leads_report_outreach',
    'leads_report_summary',
    'brocard',
    'fx_cbr',
    'expense_rules',
    'meeting_links',
    'crypto_usdt',
    'amo_tasks',
    'renewal_marks'
  ));

-- ─── RLS и гранты ────────────────────────────────────────────────────────
-- Как и у соседних sync-таблиц: select-политики для authenticated
-- намеренно нет, читает только серверный код под service_role через
-- API-роуты с гардом доступа (экран разбора — Task 5 плана).

alter table public.renewal_marks enable row level security;

grant all on public.renewal_marks to service_role, postgres;
grant usage, select on sequence public.renewal_marks_id_seq to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.renewal_marks to readonly';
  end if;
end $$;
