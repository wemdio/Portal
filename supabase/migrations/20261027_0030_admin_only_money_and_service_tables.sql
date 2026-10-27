-- Деньги, тарифы, выдача разделов и служебные таблицы — только админу и service role.
--
-- ДЫРА. После 20261015_0032/0033 любой сотрудник (техничка, продажи, маркетинг,
-- менеджер, лид, директор) своим JWT через /rest/v1 мог:
--   * выдать себе раздел — upsert в user_tool_visibility {tool_id: 'nav-expenses'}
--     открывает «Деньги» с зарплатами и мотивациями (lib/expenses/access.ts), так же
--     первичку, продления и анализ чатов продаж;
--   * читать и править invoices, выдать клиенту платный тариф в client_tariffs,
--     читать bank_transactions — в портале это только админ;
--   * подделать строку portal_migrations (деплой пропустит миграцию), заглушить
--     алерты в health_check_settings, сбить общие лимитеры Instantly и Mailganer,
--     переключить инструменты всем в global_tool_visibility.
-- В 0032 это записано как «отдельное решение владельца»; решение — закрыть.
--
-- ЧТО ДЕЛАЕМ. Поверх существующих политик — по одной RESTRICTIVE-политике на
-- anon/authenticated: «админ (не демо) или прямой логин БД». Restrictive-политики
-- складываются через AND, поэтому старые политики не трогаем и ничего не открываем.
--   * invoices, client_tariffs, bank_transactions, portal_migrations,
--     health_check_settings, instantly_rate_budget, mailganer_scoring_rate_budget —
--     все команды;
--   * user_tool_visibility — запись только админу, чтение своих строк остаётся всем
--     (UserProvider и /api/user/tools читают их JWT пользователя);
--   * global_tool_visibility — запись только админу, чтение не меняется
--     (/api/user/tools читает его JWT сотрудника).
-- Портал работает с этими таблицами через supabaseAdmin (service_role, обходит RLS),
-- лимитеры — через SECURITY DEFINER-функции, health-check и раннер миграций — прямым
-- логином. Им ничего не меняется.
--
-- ОТКАТ: drop policy <таблица>_admin_gate / _admin_insert_gate / _admin_update_gate /
-- _admin_delete_gate / user_tool_visibility_own_or_admin_read_gate; функцию
-- is_internal_admin() оставить.

set local lock_timeout = '3s';

-- ─── 1. Предикат админа ──────────────────────────────────────────────────────
-- Как public.is_internal_staff() (20261015_0030), но только роль admin.
create or replace function public.is_internal_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles actor
    where actor.id = (select auth.uid())
      and coalesce(actor.is_demo, false) = false
      and actor.role = 'admin'
  );
$$;

comment on function public.is_internal_admin() is
  'True when the caller (auth.uid()) is an admin and not demo. '
  'SECURITY DEFINER so table policies can call it; its owner must bypass RLS on profiles.';

revoke all on function public.is_internal_admin() from public;
revoke all on function public.is_internal_admin() from anon;
revoke all on function public.is_internal_admin() from authenticated;
grant execute on function public.is_internal_admin() to authenticated;
grant execute on function public.is_internal_admin() to service_role;

-- ─── 2. Политики ─────────────────────────────────────────────────────────────
do $$
declare
  -- Прямой логин БД, унаследовавший anon/authenticated, живёт как раньше — так же,
  -- как в гейтах 0032. Запрос через PostgREST всегда идёт под anon/authenticated.
  c_admin constant text :=
    '((select current_user) not in (''anon'', ''authenticated'') or (select public.is_internal_admin()))';
  c_own constant text := '(user_id = (select auth.uid()))';
  v_tbl text;
  v_rel regclass;
begin
  foreach v_tbl in array array[
    'invoices', 'client_tariffs', 'bank_transactions', 'portal_migrations',
    'health_check_settings', 'instantly_rate_budget', 'mailganer_scoring_rate_budget',
    'user_tool_visibility', 'global_tool_visibility'
  ] loop
    v_rel := to_regclass(format('public.%I', v_tbl));
    if v_rel is null then
      raise notice 'admin-only gate: public.% отсутствует, пропускаем', v_tbl;
      continue;
    end if;
    -- Без RLS политика мертва, а таблица осталась бы открытой: пусть деплой упадёт.
    if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = v_rel) then
      raise exception 'admin-only gate: RLS выключен на public.%', v_tbl;
    end if;

    if v_tbl in ('user_tool_visibility', 'global_tool_visibility') then
      execute format('drop policy if exists %I on public.%I', v_tbl || '_admin_insert_gate', v_tbl);
      execute format('create policy %I on public.%I as restrictive for insert to anon, authenticated with check (%s)',
        v_tbl || '_admin_insert_gate', v_tbl, c_admin);
      execute format('drop policy if exists %I on public.%I', v_tbl || '_admin_update_gate', v_tbl);
      execute format('create policy %I on public.%I as restrictive for update to anon, authenticated using (%s) with check (%s)',
        v_tbl || '_admin_update_gate', v_tbl, c_admin, c_admin);
      execute format('drop policy if exists %I on public.%I', v_tbl || '_admin_delete_gate', v_tbl);
      execute format('create policy %I on public.%I as restrictive for delete to anon, authenticated using (%s)',
        v_tbl || '_admin_delete_gate', v_tbl, c_admin);
    else
      execute format('drop policy if exists %I on public.%I', v_tbl || '_admin_gate', v_tbl);
      execute format('create policy %I on public.%I as restrictive for all to anon, authenticated using (%s) with check (%s)',
        v_tbl || '_admin_gate', v_tbl, c_admin, c_admin);
    end if;
  end loop;

  -- Чужие строки выдачи разделов сотруднику тоже не нужны: только свои или админ.
  if to_regclass('public.user_tool_visibility') is not null then
    execute 'drop policy if exists user_tool_visibility_own_or_admin_read_gate on public.user_tool_visibility';
    execute format('create policy user_tool_visibility_own_or_admin_read_gate on public.user_tool_visibility '
      || 'as restrictive for select to anon, authenticated using (%s or %s)', c_admin, c_own);
  end if;
end;
$$;

-- ─── 3. Проверка под JWT сотрудника ──────────────────────────────────────────
-- Сотрудник не может выдать себе «Деньги» и не видит счетов; свои строки читает.
-- Нет сотрудника (свежая база) — проверку пропускаем.
do $$
declare
  v_staff uuid;
  v_prev_role text := pg_catalog.current_setting('role');
  v_n bigint;
begin
  if not pg_catalog.has_function_privilege('authenticated', 'public.is_internal_admin()', 'EXECUTE') then
    raise exception 'admin-only gate: authenticated не может вызвать public.is_internal_admin() — сломаются все чтения';
  end if;

  select p.id into v_staff
    from public.profiles p
   where p.role in ('technician', 'manager', 'director', 'sales', 'marketer', 'lead')
     and coalesce(p.is_demo, false) = false
   limit 1;
  if v_staff is null or to_regclass('public.user_tool_visibility') is null then
    raise notice 'admin-only gate: нет сотрудника для проверки, пропускаем';
    return;
  end if;

  perform pg_catalog.set_config('request.jwt.claims',
    pg_catalog.json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  perform pg_catalog.set_config('request.jwt.claim.sub', v_staff::text, true);
  perform pg_catalog.set_config('role', 'authenticated', true);

  begin
    insert into public.user_tool_visibility (user_id, tool_id, enabled)
    values (v_staff, 'nav-expenses', true);
    raise exception 'admin-only gate: сотрудник смог записать user_tool_visibility';
  exception when insufficient_privilege then
    null;
  end;

  -- Свои строки читаются без ошибки (UserProvider), чужие не видны.
  perform 1 from public.user_tool_visibility where user_id = v_staff limit 1;
  select count(*) into v_n from public.user_tool_visibility where user_id <> v_staff;
  if v_n <> 0 then
    raise exception 'admin-only gate: сотрудник видит чужие строки user_tool_visibility (%)', v_n;
  end if;

  -- Нет права на таблицу вовсе — тоже закрыто.
  if to_regclass('public.invoices') is not null then
    begin
      select count(*) into v_n from public.invoices;
      if v_n <> 0 then
        raise exception 'admin-only gate: сотрудник видит invoices (%)', v_n;
      end if;
    exception when insufficient_privilege then
      null;
    end;
  end if;

  perform pg_catalog.set_config('role', v_prev_role, true);
  perform pg_catalog.set_config('request.jwt.claims', '', true);
  perform pg_catalog.set_config('request.jwt.claim.sub', '', true);
end;
$$;
