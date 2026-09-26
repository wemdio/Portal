-- Догоняющий поимённый отзыв прав у `anon`/`authenticated` для шести функций
-- V2, заведённых 21-24.09.2026.
--
-- ЧТО ПРОПУЩЕНО. `20260509_0003_public_default_privileges_for_postgres.sql:52-68`
-- объявляет `alter default privileges for role postgres ... grant execute on
-- functions to authenticated` (и `anon`), а миграции гоняет
-- `app/scripts/db/ensureDatabase.js` именно под `postgres` — значит КАЖДАЯ новая
-- функция рождается с execute у обеих ролей. Свои же миграции учли это лишь
-- частично:
--   * `20260921_0003:92` и `20260921_0004:43-44` отозвали права у `public, anon`,
--     но `authenticated` не назвали — двум функциям execute ему выдан даже явно
--     (`20260921_0003:93`, `20260921_0004:45`);
--   * `20260924_0010:2170-2175` отозвал права у трёх внутренних помощников
--     (`ve_try_iso_date`, `ve_contact_delivery_lock_key`,
--     `ve_contact_delivery_term`), а три `*_before_supply` того же файла
--     пропустил.
-- Отзыв у PUBLIC эту дыру не закрывает: `anon`/`authenticated` держат ПРЯМОЙ
-- грант из default privileges, а не право, унаследованное через PUBLIC. Ровно
-- этот класс промаха и сторожит линт движков (app/tests/migrations/grants.test.ts).
--
-- ЧТО НЕ ЛОМАЕТСЯ — проверено по коду перед отзывом:
--   * карточка проекта V2 читает ГОТОВУЮ КОЛОНКУ `ve_bases.public_info`, а не
--     функцию: `VE_BASE_LIST_COLUMNS = '… collect_info:public_info, …'`
--     (`app/src/lib/verticalEngineV2/projectDetail.ts:43-44`). Обёртка
--     `ve_base_public_info_cached` оставлена в базе как инструмент разового
--     пересчёта и зовётся руками под service_role;
--   * `ve_base_public_info_sync()` — триггерная функция. Право execute на неё
--     PostgreSQL проверяет при CREATE TRIGGER, а не на каждом срабатывании, и
--     все записи в `ve_bases` идут под service_role/postgres;
--   * три `*_before_supply` — внутренние помощники: их зовут обёртки
--     `ve_reserve_contact_delivery_day`, `ve_mark_contact_delivery_attempt` и
--     `ve_reserve_contact_delivery_activation` (`security definer`, владелец —
--     postgres). Прямых вызовов из приложения нет ни одного;
--   * браузерных обращений к `ve_*` нет в принципе: ни одного `from('ve_…')` в
--     tsx и ни одного `rpc` на эти шесть имён — весь V2 ходит через
--     `/api/tools/vertical-engine-v2/*` под `supabaseAdmin` (service_role).
--
-- Гранты продублированы НИЖЕ отзыва намеренно — та же причина, что в
-- `20260920_0001_he_rls_lockdown.sql:38-42`: если на инсталляции право пришло от
-- PUBLIC, отзыв у PUBLIC срезал бы его вместе с дырой, и это был бы простой
-- доставки V2, а не починка привилегий. Явный grant после revoke делает исход
-- независимым от того, откуда право пришло раньше.
--
-- КОМУ именно возвращаем — по фактическому способу вызова, а не «как было».
-- Догоняющая миграция не имеет права выдать больше, чем задумала создающая:
--   * `ve_base_public_info` и `ve_base_public_info_cached` зовут СНАРУЖИ под
--     service_role (разовый пересчёт), и `_cached` — `language sql` без
--     `security definer`, то есть вложенный `ve_base_public_info(b)` внутри неё
--     исполняется правами ВЫЗЫВАЮЩЕГО. Обеим возвращаем service_role — ровно
--     то, что выдали `20260921_0003:93` и `20260921_0004:45`, минус
--     `authenticated`. У `ve_base_public_info` это право ещё и обязательное:
--     его же зовёт тело триггера `ve_base_public_info_sync` (тоже без
--     `security definer`), так что без execute у service_role падала бы КАЖДАЯ
--     запись `ve_bases.collect_info` из приложения;
--   * `ve_base_public_info_sync()` создающая миграция не выдавала НИКОМУ
--     (`20260921_0004:43` — только отзыв): execute триггерной функции
--     проверяется при CREATE TRIGGER, а триггер ставится под postgres. Значит
--     service_role ей не нужен, и мы его не выдаём;
--   * три `*_before_supply` — только postgres. Разбор ниже, во втором разделе.
--
-- Миграция идемпотентна и перезапускаема: `revoke`/`grant` можно гонять
-- повторно. Уже применённые миграции не правим — дерево учитывает их по имени
-- файла.

-- ─── 1. Срез collect_info для карточки проекта (20260921_0003, 20260921_0004) ───

revoke all on function public.ve_base_public_info(public.ve_bases)
  from public, anon, authenticated;
revoke all on function public.ve_base_public_info_sync()
  from public, anon, authenticated;
revoke all on function public.ve_base_public_info_cached(public.ve_bases)
  from public, anon, authenticated;

grant execute on function public.ve_base_public_info(public.ve_bases)
  to service_role, postgres;
grant execute on function public.ve_base_public_info_cached(public.ve_bases)
  to service_role, postgres;

-- Триггерной функции — только владелец: execute на неё проверяется при
-- CREATE TRIGGER (`20260921_0004:29-31`, под postgres), а не на срабатывании.
-- Создающая миграция не выдавала её никому, и догоняющая тоже не выдаёт.
grant execute on function public.ve_base_public_info_sync()
  to postgres;

-- ─── 2. Помощники доставки без периода (20260924_0010) ─────────────────────
-- Сигнатуры — с точностью до типов аргументов: `revoke` адресуется конкретной
-- перегрузке, и промах по типу молча ничего не отозвал бы.
--
-- ЗДЕСЬ ОТЗЫВ ШИРЕ, ЧЕМ В РАЗДЕЛЕ 1, И ГРАНТ УЖЕ — И ЭТО НЕ ОПЕЧАТКА.
-- Эти три зовут ТОЛЬКО из SQL, изнутри обёрток `ve_reserve_contact_delivery_day`,
-- `ve_mark_contact_delivery_attempt` и `ve_reserve_contact_delivery_activation`.
-- Все шесть определений обёрток (`20260903_0001:458,483,495`,
-- `20260924_0013:32,46`, `20260924_0014:185`) — `security definer` с владельцем
-- postgres, то есть вложенный вызов исполняется правами ВЛАДЕЛЬЦА, а не
-- вызывающего. Приложение ходит только в обёртки
-- (`contactDeliveryRunner.ts:411`, `contactDeliveryActivation.ts:90`,
-- `ve_begin_recoverable_contact_delivery` → `ve_mark_contact_delivery_attempt`),
-- поэтому service_role execute на сами помощники НЕ НУЖЕН.
--
-- Больше того, отсутствие этого права — действующий инвариант, а не мелочь:
--   * `20260903_0001:521-537` уже прогнал по этим же трём именам
--     `revoke all … from public, anon, authenticated, service_role` +
--     `grant execute … to postgres`, и следом вернул service_role ТОЛЬКО
--     обёрткам (`:538-545`). `20260924_0010` их лишь `create or replace` — ACL
--     при замене функции сохраняется, дефолтные привилегии повторно не
--     применяются, — так что на уже применённых инсталляциях право service_role
--     сейчас отсутствует, и `grant` ему был бы РАСШИРЕНИЕМ прав, а не догоном;
--   * этот же инвариант проверяет живой прогон SQL:
--     `app/scripts/vertical-engine-v2/contact-supply-sql-smoke.mjs:152` ждёт
--     `permission denied` на прямой вызов
--     `ve_reserve_contact_delivery_day_before_supply` под service_role.
-- Поэтому шаблон — ровно тот, что `20260924_0010:2170-2179` применил к своим
-- внутренним помощникам (`ve_try_iso_date`, `ve_contact_delivery_lock_key`,
-- `ve_contact_delivery_term`): отзыв включает service_role, грант — только
-- postgres. Обёртки этой миграцией не трогаются, их гранты остаются как были.

revoke all on function public.ve_reserve_contact_delivery_day_before_supply(uuid, timestamptz, bigint)
  from public, anon, authenticated, service_role;
revoke all on function public.ve_mark_contact_delivery_attempt_before_supply(uuid, uuid, text, uuid[])
  from public, anon, authenticated, service_role;
revoke all on function public.ve_reserve_contact_delivery_activation_before_supply(uuid, text, uuid, integer, timestamptz, timestamptz)
  from public, anon, authenticated, service_role;

grant execute on function public.ve_reserve_contact_delivery_day_before_supply(uuid, timestamptz, bigint)
  to postgres;
grant execute on function public.ve_mark_contact_delivery_attempt_before_supply(uuid, uuid, text, uuid[])
  to postgres;
grant execute on function public.ve_reserve_contact_delivery_activation_before_supply(uuid, text, uuid, integer, timestamptz, timestamptz)
  to postgres;
