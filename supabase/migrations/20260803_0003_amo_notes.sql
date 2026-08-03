-- Комментарии AMO (GET /api/v4/leads/notes) — сырьё для распознавания
-- продлений по новому процессу команды.
-- План: docs/superpowers/plans/2026-08-03-renewals-from-payments.md (контекст),
-- но синк комментариев в исходный план НЕ входил — см. оговорку ниже.
--
-- Договорённость команды от 2026-08-03: сделка переводится в статус
-- «Продление» → пишется ОТДЕЛЬНЫЙ комментарий на каждое продление, вида
-- «Продление 1 - 159к», следующее продление через месяц — «Продление 2 -
-- 300к» (новый комментарий, не правка старого). Единственная причина писать
-- отдельными комментариями, а не одним накопительным: у комментария есть
-- собственная created_at, и она и есть дата продления. Без неё метрика
-- «сколько продлений в июле» не строится — это то единственное условие, на
-- котором держится вся схема (см. постановку задачи).
--
-- Почему только note_type=common. Проба на проде 2026-08-03: всего 8033
-- записи в GET /api/v4/leads/notes, из них common 5189, call_out 1547,
-- extended_service_message 1159, service_message 81, call_in 49, attachment
-- 4, amomail_message 4. Нас интересует только то, что менеджер пишет руками
-- — остальные типы это звонки и системные сообщения, синкать их незачем,
-- только раздуют объём без единого полезного поля для продлений. Текст лежит
-- в params.text. Фильтр note_type=common — на стороне API
-- (filter[note_type][]=common, см. sources/amo_notes.py) и продублирован на
-- стороне Python (в отличие от entity_type у задач, значение 'common' здесь
-- подтверждено пробой на проде, а не угадано — см. sources/amo_notes.py,
-- почему entity_type НЕ используется как фильтр-дроп).
--
-- Важная оговорка о полноте на исторических данных. План
-- 2026-08-03-renewals-from-payments.md сознательно НЕ включал синк
-- комментариев: на той же пробе слово «продление» встретилось всего 17 раз
-- на 5189 common-комментариев за два года, и почти все — намерения и отказы
-- («решили не продляться», «пинг по продлению»), а не факт оплаты. Эта
-- таблица не отменяет тот вывод для ИСТОРИИ — он остаётся верным. Она
-- существует ради комментариев, которые команда решила писать НАЧИНАЯ С
-- 2026-08-03 по новому процессу; отсечка по дате в самом распознавании
-- живёт в apply_renewal_marks() (следующая миграция), не здесь — здесь синк
-- тянет все common-комментарии без разбора текста, разбор текста ниже по
-- цепочке умеет отличать «до» от «после».

create table if not exists public.amo_notes (
  id             bigserial primary key,
  amo_note_id    bigint      not null unique,
  amo_deal_id    bigint      not null,
  note_type      text,
  text           text,
  created_at_amo timestamptz,
  created_by     bigint,
  raw            jsonb       not null,
  synced_at      timestamptz not null default now()
);

comment on table public.amo_notes is
  'Комментарии AMO (GET /api/v4/leads/notes), только note_type=common — то, что менеджер пишет руками. Синкается ради ручной пометки продлений («Продление 1 - 159к»), см. третий сигнал в apply_renewal_marks() (миграция после этой). Апдейт на месте по amo_note_id (upsert, не append-only) — комментарий в AMO теоретически можно отредактировать, хотя для нашей задачи это не ожидается.';
comment on column public.amo_notes.text is
  'params.text из API — свободный текст комментария. У части common-записей может быть пустым (проверить долю на боевых в рамках этой задачи не удалось — работа велась без доступа к проду), код это допускает и не роняется.';
comment on column public.amo_notes.note_type is
  'Тип комментария из API. В таблице должны оказываться только common — фильтр стоит и на стороне API (filter[note_type][]=common), и продублирован в источнике на стороне Python. Колонка хранится, а не отбрасывается, именно затем, чтобы такое расхождение было видно, если API-фильтр вдруг подведёт.';
comment on column public.amo_notes.created_at_amo is
  'created_at комментария AMO — ЕДИНСТВЕННАЯ временная метка комментария (в отличие от amo_tasks, у комментариев нет updated_at, см. sources/amo_notes.py). По договорённости команды от 2026-08-03 это и есть дата продления, а не дата платежа.';

-- amo_deal_id: основной способ чтения — «все комментарии сделки» (тот же
-- паттерн доступа, что у idx_amo_tasks_deal_id в 20260803_0001_amo_tasks.sql
-- — apply_renewal_marks() идёт от ИНН-кандидата к сделкам, от сделок к их
-- комментариям).
create index if not exists idx_amo_notes_deal_id
  on public.amo_notes (amo_deal_id);

-- Под поиск продлений — сознательно НЕ повторяем приём соседней миграции
-- (20260803_0001_amo_tasks.sql: idx_amo_tasks_renewal_candidates, частичный
-- индекс с регэкспом ~* прямо в предикате). В отчёте по той задаче отдельно
-- отмечено: такой предикат не проверен на живой БД — то есть нет
-- подтверждения, что индекс на проде реально строится и используется
-- планировщиком так, как задумано (регэксп-операторы над text формально
-- IMMUTABLE и создание не должно упасть, но «должно» и «проверено» — разные
-- вещи). Ставить вторую такую же непроверенную ставку в соседней таблице
-- неоправданно, тем более что здесь есть дешёвая и полностью предсказуемая
-- альтернатива.
--
-- Распознавание продлений по комментариям (apply_renewal_marks(), следующая
-- миграция) обязательно отсекает историю по дате начала новой договорённости
-- (2026-08-03) — иначе завал 17 исторических ложных срабатываний на 5189
-- комментариев, см. заголовок файла. Запрос поэтому всегда фильтрует
-- (amo_deal_id IN <сделки ИНН-кандидата>) AND (created_at_amo >= отсечка) —
-- ровно то, что покрывает обычный составной btree (amo_deal_id,
-- created_at_amo). Сам регэксп остаётся дешёвым остаточным фильтром над уже
-- маленькой выборкой (комментарии одной сделки после даты отсечки — единицы
-- на сделку). Обычный индекс с полностью предсказуемым поведением здесь
-- безопаснее, чем повторная ставка на неподтверждённый приём.
create index if not exists idx_amo_notes_deal_created
  on public.amo_notes (amo_deal_id, created_at_amo);

-- ─── Новый источник в логе синка ────────────────────────────────────────
-- external_sync_runs.source — CHECK со списком имён. main.py пишет запись о
-- прогоне ДО вызова источника и делает это вне try/except (см. run_all() в
-- services/portal-external-sync/main.py), поэтому незарегистрированное имя
-- роняет не один источник, а весь ночной цикл целиком. Тот же приём, что в
-- 20260803_0001_amo_tasks.sql и 20260803_0002_renewal_marks.sql.
--
-- Список продолжает актуальный из 20260803_0002_renewal_marks.sql (самая
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
    'amo_tasks',
    'renewal_marks',
    'amo_notes'
  ));

-- ─── RLS и гранты ────────────────────────────────────────────────────────
-- Как и у соседних sync-таблиц: select-политики для authenticated
-- намеренно нет, читает только серверный код под service_role через
-- API-роуты с гардом доступа.

alter table public.amo_notes enable row level security;

grant all on public.amo_notes to service_role, postgres;
grant usage, select on sequence public.amo_notes_id_seq to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.amo_notes to readonly';
  end if;
end $$;
