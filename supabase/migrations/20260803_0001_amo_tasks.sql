-- Результаты выполненных задач AMO — сырьё для дашборда продлений.
-- План: docs/superpowers/plans/2026-08-03-renewals-from-payments.md (Task 1)
--
-- Зачем отдельная таблица, а не расширение amo_events. amo_events хранит
-- переходы сделки по этапам (lead_status_changed) — GET /api/v4/events.
-- Задачи — другая сущность AMO (GET /api/v4/tasks) с другим жизненным
-- циклом: одна и та же задача обновляется (ставится complete, меняется
-- result.text), а не создаётся заново, поэтому апдейт "на месте" по
-- amo_task_id, а не append-only лог событий. result.text — самое ценное
-- поле здесь: менеджер пишет туда прямым текстом «Оплатили продление
-- 159к», и это единственный из трёх сигналов продления (см. план), где
-- есть прямое человеческое высказывание с суммой.
--
-- Тянем ВСЕ задачи (is_completed true и false), не только выполненные:
-- незавершённая сегодня станет выполненной завтра, и инкремент по
-- updated_at её подхватит сам, без отдельного бэкфилла. Источник —
-- services/portal-external-sync/sources/amo_tasks.py, по образцу
-- amo_events.py (инкремент по watermark из самой таблицы, фиксированная
-- верхняя граница окна, громкое падение при упоре в потолок страниц).

create table if not exists public.amo_tasks (
  id                  bigserial primary key,
  amo_task_id         bigint      not null unique,
  amo_deal_id         bigint      not null,
  is_completed        boolean,
  result_text         text,
  text                text,
  task_type_id        bigint,
  responsible_user_id bigint,
  created_by          bigint,
  complete_till       timestamptz,
  created_at_amo      timestamptz,
  updated_at_amo      timestamptz,
  raw                 jsonb       not null,
  synced_at           timestamptz not null default now()
);

comment on table public.amo_tasks is
  'Задачи AMO (GET /api/v4/tasks), entity_type=leads. result_text — то, ради чего таблица существует: прямая человеческая пометка вроде «Оплатили продление 159к», используется apply_renewal_marks() (Task 2 плана) для автоподтверждения продлений. Апдейт на месте по amo_task_id (не append-only), в отличие от amo_events.';
comment on column public.amo_tasks.result_text is
  'result.text из API — что менеджер написал по факту закрытия задачи. Пусто у 5/9 выполненных задач (проверено на боевых 2026-08-03: 9904 из 14865 заполнено) — это нормально, поле заполняется по желанию.';
comment on column public.amo_tasks.complete_till is
  'Срок задачи (дедлайн), НЕ дата фактического закрытия — API её не отдаёт отдельным полем. Для правила «±14 дней от платежа» это приближение: у выполненной задачи complete_till обычно близко к факту закрытия (менеджер закрывает задачу по мере выполнения, а не сильно позже дедлайна), но не гарантированно. Более точной даты в ответе /api/v4/tasks нет.';
comment on column public.amo_tasks.updated_at_amo is
  'Момент последнего изменения записи задачи в AMO — по этому полю (не по created_at_amo) идёт инкрементальный watermark синка, см. sources/amo_tasks.py.';

-- amo_deal_id: основной способ чтения таблицы — «все задачи по сделке»
-- (Task 2 объединяет по ИНН → сделки AMO этого ИНН → их задачи).
create index if not exists idx_amo_tasks_deal_id
  on public.amo_tasks (amo_deal_id);

-- Частичный индекс под конкретный запрос apply_renewal_marks() (Task 2
-- плана): «у сделки есть ВЫПОЛНЕННАЯ задача со словом продл|пролонг в
-- результате, чей complete_till в пределах ±14 дней от даты платежа».
-- На боевых 2026-08-03 таких задач всего около 21 из 14865 годовых —
-- обычный (или тем более GIN/триграммный) индекс по result_text ради
-- такой редкости избыточен: индекс на все строки был бы в ~700 раз
-- больше нужного. Частичный индекс с тем же регэкспом, что в WHERE
-- запроса, физически хранит только строки-кандидаты (единицы), поэтому
-- отбор по amo_deal_id + диапазон по complete_till остаётся дешёвым даже
-- при росте таблицы. Регэксп-операторы (~*) над text — IMMUTABLE в
-- Postgres, поэтому их можно использовать в предикате партиционного
-- индекса. Если формулировка автоподтверждения в Task 2 изменится —
-- поменять регэксп здесь и там синхронно, иначе индекс перестанет
-- покрывать запрос и просто не будет использоваться (не сломается, но
-- станет бесполезным).
create index if not exists idx_amo_tasks_renewal_candidates
  on public.amo_tasks (amo_deal_id, complete_till)
  where is_completed and result_text ~* 'продл|пролонг';

-- ─── Новый источник в логе синка ────────────────────────────────────────
-- external_sync_runs.source — CHECK со списком имён. main.py пишет запись о
-- прогоне ДО вызова источника и делает это вне try/except (см. run_all() в
-- services/portal-external-sync/main.py), поэтому незарегистрированное имя
-- роняет не один источник, а весь ночной цикл целиком. Тот же приём, что в
-- 20260730_0001_expenses_core.sql, 20260731_0003_meeting_links_sync_source.sql
-- и 20260731_0004_crypto_income.sql.
--
-- Список продолжает актуальный из 20260731_0004_crypto_income.sql (самая
-- поздняя миграция, трогавшая констрейнт на момент написания), полностью и
-- без сокращений — иначе отвалятся уже работающие источники.

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
    'amo_tasks'
  ));

-- ─── RLS и гранты ────────────────────────────────────────────────────────
-- Как и у соседних sync-таблиц: select-политики для authenticated
-- намеренно нет, читает только серверный код под service_role через
-- API-роуты с гардом доступа.

alter table public.amo_tasks enable row level security;

grant all on public.amo_tasks to service_role, postgres;
grant usage, select on sequence public.amo_tasks_id_seq to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.amo_tasks to readonly';
  end if;
end $$;
