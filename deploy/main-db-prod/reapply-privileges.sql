-- ────────────────────────────────────────────────────────────────────────────
-- Права API-ролей после restore дампа main-supabase: только GRANT, REVOKE и
-- ALTER DEFAULT PRIVILEGES. Запускает finish.sh сразу после fix-roles.sql и до
-- старта стека, одной транзакцией:
--   docker exec -i main-postgres psql -X -U supabase_admin -d postgres \
--     -v ON_ERROR_STOP=1 -1 -q -f - < reapply-privileges.sql
-- Деплой приложения этот файл не запускает (как и весь deploy/main-db-prod).
--
-- ЗАЧЕМ. Дамп снят с --no-owner --no-privileges: таблицы, тела функций, RLS и
-- политики в нём есть, а прав нет. После restore каждая SECURITY DEFINER-функция
-- снова исполнима через PUBLIC, то есть публичным anon-ключом из браузера
-- (agent_query_readonly(text) выполняет любой SELECT от суперпользователя), вьюхи
-- с правами владельца открыты, права по умолчанию роли postgres пусты. Строки
-- portal_migrations в дампе есть, поэтому деплой миграции 20261015_0030..0036
-- второй раз не применит. Этот файл возвращает их права и больше ничего.
--
-- ПОЧЕМУ НЕ ПОВТОР САМИХ МИГРАЦИЙ. Файлы 0030..0036 написаны под схему 15.10.2026.
-- Повтор поверх более новой схемы либо падает (таблицу удалили, сигнатура RPC
-- поменялась), и стек после restore не стартует, либо молча откатывает позднюю
-- правку: CREATE OR REPLACE функций, DROP/CREATE политик. Здесь нет ни того, ни
-- другого. Объекты находятся по каталогу, отсутствующий объект пропускается,
-- дрейф схемы даёт WARNING, а не ошибку.
--
-- ЧТО ДЕЛАЕТ (всё в схеме public):
--   1. anon и PUBLIC не получают ничего на таблицах, вьюхах, сиквенсах и колонках,
--      кроме трёх осознанных объектов (c_anon_select, c_anon_insert).
--   2. Вьюхи и матвьюхи: authenticated ничего (кроме c_views_for_jwt, он пуст).
--   3. Пять service-only таблиц 0032 и их сиквенсы: authenticated ничего.
--   4. SECURITY DEFINER-функции, кроме членов расширений:
--      - PUBLIC и anon их не исполняют;
--      - service_role получает явный EXECUTE на всё, что исполняла до этого шага;
--      - authenticated исполняет только функции из c_auth_definers (если исполнял
--        до этого шага) и функции, которые вызывают политики для authenticated или
--        PUBLIC, ограничения, DEFAULT и индексы;
--      - пользователь pg_cron-джобы, если он не суперпользователь, получает явный
--        EXECUTE на функцию из своей команды.
--   5. Права по умолчанию:
--      - ни одна роль (глобально и в public) не выдаёт anon ничего;
--      - новые таблицы и сиквенсы не получают PUBLIC;
--      - новые функции роли postgres (от неё деплой применяет миграции) не получают
--        PUBLIC; authenticated, service_role и прямые логины из c_direct_fn_roles
--        получают на них EXECUTE явным default в public; в схеме extensions PUBLIC
--        остаётся.
--   6. Схема lockdown_backup (снимок прав для отката 0036) закрыта для PUBLIC и
--      API-ролей.
--   7. Самопроверка. Если anon что-то может, PUBLIC исполняет definer-функцию,
--      authenticated исполняет definer-функцию вне списка, default ACL выдаёт anon
--      или вьюха открыта, файл бросает исключение. Транзакция откатывается целиком,
--      finish.sh останавливается до старта стека.
--   Списки c_anon_select, c_anon_insert, c_views_for_jwt, c_auth_definers и
--   c_direct_fn_roles те же, что lk_cfg в 20261015_0036; c_service_only — режим
--   service в 20261015_0032.
--
-- ЧЕГО НЕ ДЕЛАЕТ (так было и до 15.10.2026, см. README, «Права после restore»).
-- authenticated сохраняет ALL на таблицах и сиквенсах, выданный fix-roles.sql:
-- доступ решают RLS и политики из дампа. Прямые логины (readonly, nick_ro) свои
-- права обратно не получают.
--
-- СОПРОВОЖДЕНИЕ. Миграция, которая меняет только права (GRANT, REVOKE, default
-- privileges), после такого restore пропадает молча. Отрази её здесь правилом или в
-- списке. Новая SECURITY DEFINER-функция, которую браузер сотрудника вызывает со
-- своим JWT, идёт в c_auth_definers (и в миграцию). Если меняется список осознанных
-- anon-объектов, поправь c_anon_select и c_anon_insert.
--
-- Идемпотентен: повторный прогон ничего не меняет. Без -1 тоже атомарен: всё
-- работает в одном DO-блоке.
-- ────────────────────────────────────────────────────────────────────────────

-- Снять все права p_grantee ('public', 'anon' или 'authenticated') с объекта:
-- сначала от владельца (REVOKE суперпользователя действует от его имени), потом от
-- каждого другого грантодателя, чьи гранты переживают REVOKE владельца.
-- REVOKE ALL ON TABLE снимает и права на колонки.
create function pg_temp.rp_revoke(p_kind text, p_oid oid, p_grantee text)
returns void
language plpgsql
as $f$
declare
  v_prev text := pg_catalog.current_setting('role');
  v_grantee oid := case when p_grantee = 'public' then 0 else p_grantee::regrole::oid end;
  v_obj text;
  v_relkind "char";
  g record;
begin
  if p_kind = 'function' then
    select pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid))
      into v_obj
    from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where p.oid = p_oid;
  else
    select pg_catalog.format('%I.%I', n.nspname, c.relname), c.relkind
      into v_obj, v_relkind
    from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where c.oid = p_oid;
    -- PostgreSQL 15.8: смена relacl может гоняться с in-place обновлением pg_class
    -- (auto)VACUUM'ом. SHARE UPDATE EXCLUSIVE исключает VACUUM, чтение и запись не
    -- блокирует (как lk_hold в 0036). Матвьюху LOCK TABLE не берёт ("cannot lock
    -- relation"), её пропускаем.
    if v_relkind in ('r', 'p') then
      execute pg_catalog.format('lock table %s in share update exclusive mode', v_obj);
    end if;
  end if;

  execute pg_catalog.format('revoke all on %s %s from %s', p_kind, v_obj, p_grantee);

  for g in
    select distinct pg_catalog.pg_get_userbyid(a.grantor) as grantor
    from (
      select c.relacl as acl, c.relowner as owner from pg_catalog.pg_class c
      where p_kind <> 'function' and c.oid = p_oid
      union all
      select att.attacl, c.relowner from pg_catalog.pg_attribute att
      join pg_catalog.pg_class c on c.oid = att.attrelid
      where p_kind = 'table' and att.attrelid = p_oid and att.attacl is not null
      union all
      select p.proacl, p.proowner from pg_catalog.pg_proc p
      where p_kind = 'function' and p.oid = p_oid
    ) o
    cross join lateral pg_catalog.aclexplode(o.acl) a
    where a.grantee = v_grantee and a.grantor <> o.owner
  loop
    perform pg_catalog.set_config('role', g.grantor, true);
    execute pg_catalog.format('revoke all on %s %s from %s', p_kind, v_obj, p_grantee);
    perform pg_catalog.set_config('role', v_prev, true);
  end loop;
end;
$f$;

do $reapply$
declare
  -- Осознанные anon-объекты: lk_cfg anon_select / anon_insert в 20261015_0036.
  c_anon_select constant text[] := array[
    'public.reglament_documents', 'public.companies_directory', 'public.database_review_row_marks'];
  c_anon_insert constant text[] := array['public.database_review_row_marks'];
  -- Вьюхи, которые читает JWT пользователя: lk_cfg views_for_jwt в 0036 (пусто).
  c_views_for_jwt constant text[] := array[]::text[];
  -- Только service_role и прямые логины: режим service в 20261015_0032.
  c_service_only constant text[] := array[
    'public.fx_rate_probes', 'public.gis_signal_company_signals_bak_20260812', 'public.health_check_job_alerts',
    'public.transcript_amo_lead_link', 'public.ve_search_cache'];
  -- SECURITY DEFINER-функции, которые остаются authenticated: lk_cfg auth_definers
  -- в 20261015_0036. Каждая сначала проверяет auth.uid(), права сотрудника или
  -- собственную строку вызывающего.
  c_auth_definers constant text[] := array[
    'public.is_internal_staff()',
    'public.can_access_email_subscriptions()',
    'public.can_manage_email_subscriptions()',
    'public.can_access_team()',
    'public.can_mutate_team_data(text)',
    'public.can_view_team_activity_plan()',
    'public.can_manage_team_activity_plan()',
    'public.can_submit_team_review_request()',
    'public.can_view_team_review_requests_shared()',
    'public.can_use_payment_requests()',
    'public.can_manage_payment_requests()',
    'public.convert_team_review_request(uuid,date,text,timestamp with time zone)',
    'public.payment_requests_read_model(date)',
    'public.submit_payment_request_with_budget(uuid,text,text,numeric,uuid,text,text,text,text,date,text,text)',
    'public.transition_payment_request(uuid,text,timestamp with time zone,text,date,text)',
    'public.record_email_subscription_payment_today(uuid,text,text,integer,numeric,text,text,text)',
    'public.decide_email_subscription(uuid,text,text,timestamp with time zone)',
    'public.copilot_dialog_stats(uuid)',
    'public.is_api_robot()',
    'public.pdl_count_estimate(text[],text[],text[],text)',
    'public.search_pdl_companies(text[],text[],text[],text,text,integer)'];
  -- Прямые логины, которые вызывают функции public и получали EXECUTE на новые
  -- через PUBLIC: lk_cfg direct_fn_roles в 0036. Отсутствующие и суперпользователи
  -- пропускаются.
  c_direct_fn_roles constant text[] := array['readonly', 'nick_ro', 'supabase_auth_admin', 'supabase_storage_admin'];

  v_public oid := 'public'::regnamespace;
  v_prev_role text := pg_catalog.current_setting('role');
  v_anon oid;
  v_auth oid;
  v_svc oid;
  v_sel oid[];
  v_ins oid[];
  v_jwt oid[];
  v_static oid[];
  v_dep oid[];
  v_target text[];
  v_had_auth boolean;
  v_bad text;
  v_n integer;
  r record;
  s record;
begin
  perform pg_catalog.set_config('lock_timeout', '10s', true);

  -- ─── 0. Условия ─────────────────────────────────────────────────────────────
  if (select count(*) from pg_catalog.pg_roles where rolname in ('anon', 'authenticated', 'service_role')) <> 3 then
    raise exception 'reapply-privileges: нет ролей anon/authenticated/service_role (их создаёт fix-roles.sql)';
  end if;
  if not (select rolsuper from pg_catalog.pg_roles where rolname = current_user) then
    raise exception 'reapply-privileges: запускать от суперпользователя (supabase_admin), а не от %', current_user;
  end if;
  v_anon := 'anon'::regrole;
  v_auth := 'authenticated'::regrole;
  v_svc := 'service_role'::regrole;

  v_sel := array(select pg_catalog.to_regclass(t)::oid from unnest(c_anon_select) t where pg_catalog.to_regclass(t) is not null);
  v_ins := array(select pg_catalog.to_regclass(t)::oid from unnest(c_anon_insert) t where pg_catalog.to_regclass(t) is not null);
  v_jwt := array(select pg_catalog.to_regclass(t)::oid from unnest(c_views_for_jwt) t where pg_catalog.to_regclass(t) is not null);

  -- ─── 1. anon и PUBLIC на отношениях ─────────────────────────────────────────
  for r in
    select c.oid, c.relkind, c.relowner, c.relacl,
           case when c.relkind = 'S' then 'sequence' else 'table' end as kw
    from pg_catalog.pg_class c
    where c.relnamespace = v_public and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  loop
    v_target := case when r.relkind <> 'S' and r.oid = any (v_sel) then array['SELECT'] else array[]::text[] end
             || case when r.relkind <> 'S' and r.oid = any (v_ins) then array['INSERT'] else array[]::text[] end;
    -- Объект, у которого anon уже ровно целевые права, не трогаем (повторный прогон
    -- не переписывает ACL).
    if exists (select 1 from pg_catalog.aclexplode(r.relacl) a where a.grantee = 0)
       or exists (select 1 from pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
                  where att.attrelid = r.oid and a.grantee in (0, v_anon))
       or exists (select 1 from pg_catalog.aclexplode(r.relacl) a
                  where a.grantee = v_anon and (a.is_grantable or a.grantor <> r.relowner))
       or array(select a.privilege_type::text from pg_catalog.aclexplode(r.relacl) a where a.grantee = v_anon order by 1)
          is distinct from array(select x from unnest(v_target) x order by 1)
    then
      perform pg_temp.rp_revoke(r.kw, r.oid, 'public');
      perform pg_temp.rp_revoke(r.kw, r.oid, 'anon');
      if 'SELECT' = any (v_target) then
        execute pg_catalog.format('grant select on table %s to anon', r.oid::regclass);
      end if;
      if 'INSERT' = any (v_target) then
        execute pg_catalog.format('grant insert on table %s to anon', r.oid::regclass);
      end if;
    end if;
  end loop;

  -- ─── 2. Вьюхи: только роли, которые обходят RLS ─────────────────────────────
  for r in
    select c.oid
    from pg_catalog.pg_class c
    where c.relnamespace = v_public and c.relkind in ('v', 'm')
      and not (c.oid = any (v_jwt))
      and (exists (select 1 from pg_catalog.aclexplode(c.relacl) a where a.grantee = v_auth)
           or exists (select 1 from pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
                      where att.attrelid = c.oid and a.grantee = v_auth))
  loop
    perform pg_temp.rp_revoke('table', r.oid, 'authenticated');
  end loop;

  -- ─── 3. Service-only таблицы 0032 и их сиквенсы ─────────────────────────────
  for r in
    select c.oid
    from unnest(c_service_only) t
    join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(t)::oid
    where c.relkind in ('r', 'p')
  loop
    if exists (select 1 from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
               where c.oid = r.oid and a.grantee = v_auth)
       or exists (select 1 from pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
                  where att.attrelid = r.oid and a.grantee = v_auth) then
      perform pg_temp.rp_revoke('table', r.oid, 'authenticated');
    end if;
    for s in
      select sq.oid
      from pg_catalog.pg_depend d
      join pg_catalog.pg_class sq on sq.oid = d.objid and sq.relkind = 'S'
      where d.classid = 'pg_catalog.pg_class'::regclass and d.refobjid = r.oid and d.deptype in ('a', 'i')
        and exists (select 1 from pg_catalog.aclexplode(sq.relacl) a where a.grantee = v_auth)
    loop
      perform pg_temp.rp_revoke('sequence', s.oid, 'authenticated');
    end loop;
  end loop;

  -- ─── 4. SECURITY DEFINER-функции ────────────────────────────────────────────
  v_static := array(select pg_catalog.to_regprocedure(f)::oid from unnest(c_auth_definers) f
                    where pg_catalog.to_regprocedure(f) is not null);
  -- Без этих EXECUTE не работает сама таблица: политика для authenticated/PUBLIC,
  -- ограничение, DEFAULT или индекс вызывает definer-функцию.
  v_dep := array(
    select d.refobjid
    from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid = d.refobjid and p.prosecdef and p.pronamespace = v_public
    join pg_catalog.pg_policy pol on d.classid = 'pg_catalog.pg_policy'::regclass and pol.oid = d.objid
    where d.refclassid = 'pg_catalog.pg_proc'::regclass and pol.polroles && array[0::oid, v_auth]
    union
    select d.refobjid
    from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid = d.refobjid and p.prosecdef and p.pronamespace = v_public
    where d.refclassid = 'pg_catalog.pg_proc'::regclass
      and d.classid in ('pg_catalog.pg_constraint'::regclass, 'pg_catalog.pg_attrdef'::regclass)
    union
    select d.refobjid
    from pg_catalog.pg_depend d
    join pg_catalog.pg_proc p on p.oid = d.refobjid and p.prosecdef and p.pronamespace = v_public
    join pg_catalog.pg_class ic on d.classid = 'pg_catalog.pg_class'::regclass and ic.oid = d.objid and ic.relkind = 'i'
    where d.refclassid = 'pg_catalog.pg_proc'::regclass);

  -- Сигнатура из списка не нашлась: если функция с таким именем есть, это дрейф
  -- схемы. authenticated её не получит (закрыто, а не открыто); оператор выдаёт
  -- руками и правит список.
  select string_agg(f || coalesce(' (сейчас есть: ' || (
           select string_agg(p.oid::regprocedure::text, ', ')
           from pg_catalog.pg_proc p
           where p.pronamespace = v_public and p.proname = split_part(split_part(f, '(', 1), '.', 2)) || ')', ''), '; ')
    into v_bad
  from unnest(c_auth_definers) f
  where pg_catalog.to_regprocedure(f) is null;
  if v_bad is not null then
    raise warning 'reapply-privileges: функций из c_auth_definers нет в базе, authenticated их не получает: %', v_bad;
  end if;

  -- pg_cron: джоба не-суперпользователя, которая доставала definer-функцию только
  -- через PUBLIC, получает явный EXECUTE (схема cron в дамп не входит; джобы
  -- заводятся руками, см. README).
  if pg_catalog.to_regclass('cron.job') is not null
     and exists (select 1 from pg_catalog.pg_attribute
                 where attrelid = pg_catalog.to_regclass('cron.job') and attname = 'username' and not attisdropped) then
    for r in execute $q$
      select distinct j.username,
             pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as fn
      from cron.job j
      join pg_catalog.pg_roles ro on ro.rolname = j.username and not ro.rolsuper
      join pg_catalog.pg_proc p on p.prosecdef and j.command ~* ('\m' || p.proname || '\s*\(')
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace and n.nspname = 'public'
      where pg_catalog.has_function_privilege(ro.oid, p.oid, 'EXECUTE')
    $q$
    loop
      execute pg_catalog.format('grant execute on function %s to %I', r.fn, r.username);
    end loop;
  end if;

  for r in
    select p.oid, p.proowner, p.proacl,
           pg_catalog.format('%I.%I(%s)', n.nspname, p.proname, pg_catalog.pg_get_function_identity_arguments(p.oid)) as fn
    from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.oid = v_public and p.prosecdef
      and not exists (select 1 from pg_catalog.pg_depend d
                      where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
  loop
    v_had_auth := pg_catalog.has_function_privilege(v_auth, r.oid, 'EXECUTE');
    -- Явные гранты раньше снятия PUBLIC, чтобы те, кто остаётся, не потеряли вызов.
    if pg_catalog.has_function_privilege(v_svc, r.oid, 'EXECUTE')
       and not exists (select 1 from pg_catalog.aclexplode(r.proacl) a
                       where a.grantee = v_svc and a.privilege_type = 'EXECUTE') then
      execute pg_catalog.format('grant execute on function %s to service_role', r.fn);
    end if;
    if r.oid = any (v_dep) or (r.oid = any (v_static) and v_had_auth) then
      if not exists (select 1 from pg_catalog.aclexplode(r.proacl) a
                     where a.grantee = v_auth and a.privilege_type = 'EXECUTE') then
        execute pg_catalog.format('grant execute on function %s to authenticated', r.fn);
      end if;
    elsif exists (select 1 from pg_catalog.aclexplode(r.proacl) a where a.grantee = v_auth) then
      perform pg_temp.rp_revoke('function', r.oid, 'authenticated');
    end if;
    -- proacl NULL значит «по умолчанию», а это EXECUTE для PUBLIC.
    if exists (select 1 from pg_catalog.aclexplode(coalesce(r.proacl, pg_catalog.acldefault('f', r.proowner))) a
               where a.grantee in (0, v_anon)) then
      perform pg_temp.rp_revoke('function', r.oid, 'public');
      perform pg_temp.rp_revoke('function', r.oid, 'anon');
    end if;
  end loop;

  -- ─── 5. Права по умолчанию ──────────────────────────────────────────────────
  for r in
    select pg_catalog.pg_get_userbyid(d.defaclrole) as rolname, d.defaclnamespace, d.defaclobjtype,
           exists (select 1 from pg_catalog.aclexplode(d.defaclacl) a where a.grantee = v_anon) as has_anon,
           d.defaclobjtype in ('r', 'S')
             and exists (select 1 from pg_catalog.aclexplode(d.defaclacl) a where a.grantee = 0) as has_public
    from pg_catalog.pg_default_acl d
    where d.defaclnamespace in (0, v_public)
  loop
    continue when not (r.has_anon or r.has_public);
    if r.defaclobjtype not in ('r', 'S', 'f', 'T', 'n') then
      raise exception 'reapply-privileges: неизвестный тип default ACL % у роли %', r.defaclobjtype, r.rolname;
    end if;
    if r.has_anon then
      execute pg_catalog.format('alter default privileges for role %I %s revoke all on %s from anon',
        r.rolname,
        case when r.defaclnamespace = 0 then '' else 'in schema public' end,
        case r.defaclobjtype when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                             when 'T' then 'types' when 'n' then 'schemas' end);
    end if;
    if r.has_public then
      execute pg_catalog.format('alter default privileges for role %I %s revoke all on %s from public',
        r.rolname,
        case when r.defaclnamespace = 0 then '' else 'in schema public' end,
        case r.defaclobjtype when 'r' then 'tables' else 'sequences' end);
    end if;
  end loop;

  -- Новые функции роли postgres: без PUBLIC (через него их получал anon);
  -- authenticated, service_role и c_direct_fn_roles — явным default в public; в
  -- extensions PUBLIC остаётся, чтобы расширения, созданные там позже, работали.
  -- Как шаг 4 в 0036.
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres') then
    execute 'alter default privileges for role postgres in schema public grant execute on functions to authenticated, service_role';
    for r in
      select ro.rolname from pg_catalog.pg_roles ro
      where ro.rolname = any (c_direct_fn_roles) and not ro.rolsuper
      order by 1
    loop
      execute pg_catalog.format('alter default privileges for role postgres in schema public grant execute on functions to %I', r.rolname);
    end loop;
    if pg_catalog.to_regnamespace('extensions') is not null then
      execute 'alter default privileges for role postgres in schema extensions grant execute on functions to public';
    end if;
    execute 'alter default privileges for role postgres revoke execute on functions from public';
  end if;

  -- ─── 6. lockdown_backup ─────────────────────────────────────────────────────
  if pg_catalog.to_regnamespace('lockdown_backup') is not null then
    if exists (select 1 from pg_catalog.pg_namespace n, pg_catalog.aclexplode(n.nspacl) a
               where n.nspname = 'lockdown_backup' and a.grantee in (0, v_anon, v_auth, v_svc)) then
      execute 'revoke all on schema lockdown_backup from public, anon, authenticated, service_role';
    end if;
    for r in
      select c.oid, case when c.relkind = 'S' then 'sequence' else 'table' end as kw, a.grantee
      from pg_catalog.pg_class c, pg_catalog.aclexplode(c.relacl) a
      where c.relnamespace = 'lockdown_backup'::regnamespace and a.grantee in (0, v_anon, v_auth, v_svc)
      group by c.oid, c.relkind, a.grantee
    loop
      perform pg_temp.rp_revoke(r.kw, r.oid,
        case when r.grantee = 0 then 'public' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(r.grantee)) end);
    end loop;
  end if;

  -- ─── 7. Самопроверка: нарушение откатывает всё, стек не стартует ────────────
  -- 7a. anon/PUBLIC на отношениях: только осознанные права.
  select string_agg(c.oid::regclass::text, ', ') into v_bad
  from pg_catalog.pg_class c
  where c.relnamespace = v_public and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    and (case when c.relkind = 'S'
              then pg_catalog.has_sequence_privilege(v_anon, c.oid, 'USAGE,SELECT,UPDATE')
              else pg_catalog.has_table_privilege(v_anon, c.oid,
                     'UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
                     || case when c.oid = any (v_sel) then '' else ',SELECT' end
                     || case when c.oid = any (v_ins) then '' else ',INSERT' end) end
         or exists (select 1 from pg_catalog.aclexplode(c.relacl) a
                    where a.grantee in (0, v_anon)
                      and not (a.grantee = v_anon and c.relkind <> 'S'
                               and ((a.privilege_type = 'SELECT' and c.oid = any (v_sel))
                                    or (a.privilege_type = 'INSERT' and c.oid = any (v_ins)))))
         or exists (select 1 from pg_catalog.pg_attribute att, pg_catalog.aclexplode(att.attacl) a
                    where att.attrelid = c.oid and a.grantee in (0, v_anon)));
  if v_bad is not null then
    raise exception 'reapply-privileges: anon или PUBLIC всё ещё имеют права на %', v_bad;
  end if;
  select string_agg(o::regclass::text, ', ') into v_bad from unnest(v_sel) o
  where not pg_catalog.has_table_privilege(v_anon, o, 'SELECT');
  if v_bad is not null then raise exception 'reapply-privileges: нет осознанного anon SELECT на %', v_bad; end if;
  select string_agg(o::regclass::text, ', ') into v_bad from unnest(v_ins) o
  where not pg_catalog.has_table_privilege(v_anon, o, 'INSERT');
  if v_bad is not null then raise exception 'reapply-privileges: нет осознанного anon INSERT на %', v_bad; end if;

  -- 7b. Вьюхи закрыты для anon и authenticated.
  select string_agg(c.oid::regclass::text, ', ') into v_bad
  from pg_catalog.pg_class c
  where c.relnamespace = v_public and c.relkind in ('v', 'm') and not (c.oid = any (v_jwt))
    and (pg_catalog.has_table_privilege(v_auth, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         or pg_catalog.has_any_column_privilege(v_auth, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'));
  if v_bad is not null then
    raise exception 'reapply-privileges: вьюхи открыты authenticated: %', v_bad;
  end if;

  -- 7c. Service-only таблицы и их сиквенсы закрыты для authenticated.
  select string_agg(c.oid::regclass::text, ', ') into v_bad
  from unnest(c_service_only) t
  join pg_catalog.pg_class c on c.oid = pg_catalog.to_regclass(t)::oid and c.relkind in ('r', 'p')
  where pg_catalog.has_table_privilege(v_auth, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     or pg_catalog.has_any_column_privilege(v_auth, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
     or exists (select 1 from pg_catalog.pg_depend d
                join pg_catalog.pg_class sq on sq.oid = d.objid and sq.relkind = 'S'
                where d.classid = 'pg_catalog.pg_class'::regclass and d.refobjid = c.oid and d.deptype in ('a', 'i')
                  -- зависимости 'i' есть и у TOAST-таблицы: без CASE функция
                  -- для сиквенсов упала бы на ней
                  and case when sq.relkind = 'S'
                           then pg_catalog.has_sequence_privilege(v_auth, sq.oid, 'USAGE,SELECT,UPDATE')
                           else false end);
  if v_bad is not null then
    raise exception 'reapply-privileges: service-only таблицы открыты authenticated: %', v_bad;
  end if;

  -- 7d. Definer-функции: ни PUBLIC, ни anon; authenticated только из списка и
  --     зависимостей; каждая функция политики для authenticated ему доступна.
  select string_agg(p.oid::regprocedure::text, ', ') into v_bad
  from pg_catalog.pg_proc p
  where p.pronamespace = v_public and p.prosecdef
    and not exists (select 1 from pg_catalog.pg_depend d
                    where d.classid = 'pg_catalog.pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    and (pg_catalog.has_function_privilege(v_anon, p.oid, 'EXECUTE')
         or exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))) a
                    where a.grantee = 0)
         or (pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE')
             and not (p.oid = any (v_static) or p.oid = any (v_dep))));
  if v_bad is not null then
    raise exception 'reapply-privileges: SECURITY DEFINER-функции открыты PUBLIC/anon или authenticated вне списка: %', v_bad;
  end if;
  select string_agg(o::regprocedure::text, ', ') into v_bad from unnest(v_dep) o
  where not pg_catalog.has_function_privilege(v_auth, o, 'EXECUTE');
  if v_bad is not null then
    raise exception 'reapply-privileges: политики/ограничения вызывают функции, недоступные authenticated: %', v_bad;
  end if;

  -- 7e. Права по умолчанию.
  select string_agg(pg_catalog.pg_get_userbyid(d.defaclrole) || '/' || d.defaclobjtype::text || '/'
                    || case when d.defaclnamespace = 0 then '*' else d.defaclnamespace::regnamespace::text end, ', ')
    into v_bad
  from pg_catalog.pg_default_acl d
  where d.defaclnamespace in (0, v_public)
    and exists (select 1 from pg_catalog.aclexplode(d.defaclacl) a
                where a.grantee = v_anon or (a.grantee = 0 and d.defaclobjtype in ('r', 'S')));
  if v_bad is not null then
    raise exception 'reapply-privileges: права по умолчанию всё ещё выдают anon/PUBLIC: %', v_bad;
  end if;
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'postgres')
     and not exists (select 1 from pg_catalog.pg_default_acl d
                     where d.defaclrole = 'postgres'::regrole and d.defaclnamespace = 0 and d.defaclobjtype = 'f'
                       and not exists (select 1 from pg_catalog.aclexplode(d.defaclacl) a where a.grantee = 0)) then
    raise exception 'reapply-privileges: новые функции роли postgres остаются исполнимыми через PUBLIC';
  end if;

  -- 7f. lockdown_backup закрыта.
  if pg_catalog.to_regnamespace('lockdown_backup') is not null
     and (pg_catalog.has_schema_privilege(v_anon, 'lockdown_backup', 'USAGE')
          or pg_catalog.has_schema_privilege(v_auth, 'lockdown_backup', 'USAGE')
          or pg_catalog.has_schema_privilege(v_svc, 'lockdown_backup', 'USAGE')) then
    raise exception 'reapply-privileges: схема lockdown_backup открыта API-ролям';
  end if;

  -- 7g. Проба так, как запрос идёт через PostgREST: anon не вызывает
  --     is_internal_staff() и не читает profiles.
  if pg_catalog.to_regprocedure('public.is_internal_staff()') is not null then
    begin
      perform pg_catalog.set_config('role', 'anon', true);
      perform public.is_internal_staff();
      perform pg_catalog.set_config('role', v_prev_role, true);
      raise exception 'reapply-privileges: anon вызывает public.is_internal_staff()' using errcode = 'P0001';
    exception when insufficient_privilege then
      perform pg_catalog.set_config('role', v_prev_role, true);
    end;
  end if;
  if pg_catalog.to_regclass('public.profiles') is not null then
    begin
      perform pg_catalog.set_config('role', 'anon', true);
      execute 'select 1 from public.profiles where false';
      perform pg_catalog.set_config('role', v_prev_role, true);
      raise exception 'reapply-privileges: anon читает public.profiles' using errcode = 'P0001';
    exception when insufficient_privilege then
      perform pg_catalog.set_config('role', v_prev_role, true);
    end;
  end if;

  -- ─── Предупреждения: не ошибка, но оператору стоит посмотреть ───────────────
  -- Осознанные anon-объекты читаются (политика может звать закрытую функцию).
  for r in select o from unnest(v_sel) o loop
    begin
      perform pg_catalog.set_config('role', 'anon', true);
      execute pg_catalog.format('select 1 from %s limit 1', r.o::regclass);
      perform pg_catalog.set_config('role', v_prev_role, true);
    exception when others then
      perform pg_catalog.set_config('role', v_prev_role, true);
      raise warning 'reapply-privileges: anon не читает %: %', r.o::regclass, sqlerrm;
    end;
  end loop;
  -- Таблицы без RLS, которые fix-roles.sql открыл authenticated: дамп старше 0032
  -- или таблицу создали без RLS. Любой вошедший читает и пишет их целиком.
  select count(*), string_agg(x, ', ' order by x) filter (where rn <= 30) into v_n, v_bad
  from (select c.oid::regclass::text as x, row_number() over (order by c.oid::regclass::text) as rn
        from pg_catalog.pg_class c
        where c.relnamespace = v_public and c.relkind in ('r', 'p') and not c.relrowsecurity
          and pg_catalog.has_table_privilege(v_auth, c.oid, 'SELECT,INSERT,UPDATE,DELETE')) z;
  if v_n > 0 then
    raise warning 'reapply-privileges: % таблиц без RLS открыты authenticated (до 30 имён): %', v_n, v_bad;
  end if;

  raise notice 'reapply-privileges: готово. anon: % осознанных объекта; definer-функций у authenticated: %',
    cardinality(v_sel),
    (select count(*) from pg_catalog.pg_proc p
     where p.pronamespace = v_public and p.prosecdef and pg_catalog.has_function_privilege(v_auth, p.oid, 'EXECUTE'));
end;
$reapply$;

drop function pg_temp.rp_revoke(text, oid, text);
