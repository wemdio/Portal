-- ROLLBACK of 20261015_0036_anon_definer_view_lockdown.sql. Run as postgres:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 20261015_0036_anon_definer_view_lockdown.rollback.sql
-- lockdown_backup.acl_20261015_0036 (written by 0036 inside its own transaction) holds,
-- for every public relation, column and function and every default ACL, the ACL just
-- before 0036 (acl) and the ACL 0036 left (acl_after). For each entry 0036 changed
-- (acl <> acl_after) this file restores acl, but ONLY while the entry still equals
-- acl_after. An entry that changed again after 0036 (a later migration, a hand GRANT,
-- a restore from a dump that carries this table) is left alone and named in a WARNING:
-- restoring it would silently undo that later change. Decide those by hand, or, only
-- if they must go back to the pre-0036 state too, re-run with
--   set lockdown.rollback_0036_force = 'on';   (psql: PGOPTIONS='-c lockdown.rollback_0036_force=on')
-- Entries 0036 did not change, and objects created after 0036, are never touched.
-- Grants made by a non-owner grantor are restored as that grantor.
-- Run it as postgres with that role's default search_path: the snapshot names functions
-- as regprocedure text, which leaves out "public." exactly as the migration runner's
-- search_path printed it.
-- Review first what would change (read-only): before / after 0036 / now, per entry.
--   select b.kind, b.ident, b.acl as before, b.acl_after as after_0036,
--          coalesce(c.relacl::text, p.proacl::text) as now
--   from lockdown_backup.acl_20261015_0036 b
--   left join pg_class c on b.kind = 'rel' and c.oid = to_regclass(b.ident)
--   left join pg_proc p on b.kind = 'fn' and p.oid = to_regprocedure(b.ident)
--   where b.kind in ('rel', 'fn') and b.acl is distinct from b.acl_after;
-- Keep the 0036 row in public.portal_migrations; ship a corrected fix as a NEW migration.
-- Only catalog ACLs change; no table lock stronger than the GRANT/REVOKE row update.
-- The snapshot table is kept; drop it by hand once it is no longer needed:
--   drop schema lockdown_backup cascade;
begin;
set local lock_timeout = '3s';
do $$
declare
  v_prev_role text := current_setting('role');
  v_force boolean := coalesce(pg_catalog.current_setting('lockdown.rollback_0036_force', true), '') = 'on';
  b record;
  e record;
  v_oid oid;
  v_owner oid;
  v_acl aclitem[];
  v_cur aclitem[];
  v_old aclitem[];
  v_after aclitem[];
  v_obj text;
  v_col text;
  v_role oid;
  v_nsp oid;
  v_type "char";
  v_word text;
  v_who text;
  v_changed int := 0;
  v_skipped text[] := array[]::text[];
begin
  if to_regclass('lockdown_backup.acl_20261015_0036') is null then
    raise exception '0036 rollback: lockdown_backup.acl_20261015_0036 is missing';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute
                 where attrelid = 'lockdown_backup.acl_20261015_0036'::regclass and attname = 'after_captured_at') then
    raise exception '0036 rollback: the snapshot has no acl_after column (written by an older 0036); compare by hand';
  end if;

  -- Relations, columns and functions.
  for b in select * from lockdown_backup.acl_20261015_0036 where kind in ('rel', 'col', 'fn') order by kind, ident loop
    v_col := null;
    if b.kind = 'rel' then
      select c.oid, c.relowner, c.relacl,
             case when c.relkind = 'S' then 'sequence ' else 'table ' end || b.ident,
             case when c.relkind = 'S' then 's' else 'r' end
        into v_oid, v_owner, v_acl, v_obj, v_type
      from pg_catalog.pg_class c where c.oid = to_regclass(b.ident);
      if v_oid is null then continue; end if;
      v_cur := coalesce(v_acl, pg_catalog.acldefault(v_type, v_owner));
      v_old := coalesce(b.acl::aclitem[], pg_catalog.acldefault(v_type, v_owner));
      v_after := coalesce(b.acl_after::aclitem[], pg_catalog.acldefault(v_type, v_owner));
    elsif b.kind = 'col' then
      select c.oid, c.relowner, a.attacl, 'table ' || split_part(b.ident, ' ', 1), a.attname
        into v_oid, v_owner, v_acl, v_obj, v_col
      from pg_catalog.pg_class c
      join pg_catalog.pg_attribute a on a.attrelid = c.oid
      where c.oid = to_regclass(split_part(b.ident, ' ', 1))
        and pg_catalog.quote_ident(a.attname) = substr(b.ident, length(split_part(b.ident, ' ', 1)) + 2);
      if v_oid is null then continue; end if;
      -- aclexplode() rejects an empty array, so "no column grants" stays NULL.
      v_cur := nullif(v_acl, '{}'::aclitem[]);
      v_old := nullif(b.acl::aclitem[], '{}'::aclitem[]);
      v_after := nullif(b.acl_after::aclitem[], '{}'::aclitem[]);
    else
      select p.oid, p.proowner, p.proacl, 'function ' || b.ident
        into v_oid, v_owner, v_acl, v_obj
      from pg_catalog.pg_proc p where p.oid = to_regprocedure(b.ident);
      if v_oid is null then continue; end if;
      v_cur := coalesce(v_acl, pg_catalog.acldefault('f', v_owner));
      v_old := coalesce(b.acl::aclitem[], pg_catalog.acldefault('f', v_owner));
      v_after := coalesce(b.acl_after::aclitem[], pg_catalog.acldefault('f', v_owner));
    end if;

    -- Already as before 0036.
    if array(select x::text from unnest(v_cur) x order by 1) = array(select x::text from unnest(v_old) x order by 1) then
      continue;
    end if;
    -- 0036 did not change this entry: whatever changed it later is not ours to undo.
    if b.after_captured_at is not null
       and array(select x::text from unnest(v_old) x order by 1) = array(select x::text from unnest(v_after) x order by 1) then
      continue;
    end if;
    -- Changed by 0036 and again afterwards (or no after-state recorded): list it, unless forced.
    if not v_force
       and (b.after_captured_at is null
            or array(select x::text from unnest(v_cur) x order by 1) <> array(select x::text from unnest(v_after) x order by 1)) then
      v_skipped := v_skipped || (b.kind || ' ' || b.ident);
      continue;
    end if;
    v_changed := v_changed + 1;

    -- Remove what 0036 added (non-owner grantors first, they may depend on the owner's).
    for e in
      select x.grantor, x.grantee, x.privilege_type, x.is_grantable
      from (select * from pg_catalog.aclexplode(v_cur) except select * from pg_catalog.aclexplode(v_old)) x
      where x.grantee <> v_owner
      order by (x.grantor = v_owner), x.grantee, x.privilege_type
    loop
      v_who := case when e.grantee = 0 then 'public' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(e.grantee)) end;
      if e.grantor <> v_owner then
        perform pg_catalog.set_config('role', pg_catalog.pg_get_userbyid(e.grantor), true);
      end if;
      execute pg_catalog.format('revoke %s%s on %s from %s cascade', e.privilege_type,
        case when v_col is not null then ' (' || pg_catalog.quote_ident(v_col) || ')' else '' end, v_obj, v_who);
      perform pg_catalog.set_config('role', v_prev_role, true);
    end loop;

    -- Put back what 0036 removed (the owner's grants first).
    for e in
      select x.grantor, x.grantee, x.privilege_type, x.is_grantable
      from (select * from pg_catalog.aclexplode(v_old)
            except
            select * from pg_catalog.aclexplode(
              case b.kind
                when 'rel' then coalesce((select c.relacl from pg_catalog.pg_class c where c.oid = v_oid),
                                         pg_catalog.acldefault(v_type, v_owner))
                when 'col' then nullif((select a.attacl from pg_catalog.pg_attribute a
                                        where a.attrelid = v_oid and a.attname = v_col), '{}'::aclitem[])
                else coalesce((select p.proacl from pg_catalog.pg_proc p where p.oid = v_oid),
                              pg_catalog.acldefault('f', v_owner))
              end)) x
      where x.grantee <> v_owner
      order by (x.grantor <> v_owner), x.grantee, x.privilege_type
    loop
      v_who := case when e.grantee = 0 then 'public' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(e.grantee)) end;
      if e.grantor <> v_owner then
        perform pg_catalog.set_config('role', pg_catalog.pg_get_userbyid(e.grantor), true);
      end if;
      execute pg_catalog.format('grant %s%s on %s to %s%s', e.privilege_type,
        case when v_col is not null then ' (' || pg_catalog.quote_ident(v_col) || ')' else '' end, v_obj, v_who,
        case when e.is_grantable then ' with grant option' else '' end);
      perform pg_catalog.set_config('role', v_prev_role, true);
    end loop;
  end loop;

  -- Default ACLs. A global row (no schema) replaces the built-in defaults; a schema row adds to them.
  for b in select * from lockdown_backup.acl_20261015_0036 where kind = 'defacl' order by ident loop
    v_role := (select oid from pg_catalog.pg_roles where rolname = split_part(b.ident, '|', 1));
    if v_role is null then continue; end if;
    v_nsp := case when split_part(b.ident, '|', 2) = '' then 0 else to_regnamespace(split_part(b.ident, '|', 2))::oid end;
    if v_nsp is null then continue; end if;
    v_type := split_part(b.ident, '|', 3)::"char";
    v_word := case v_type when 'r' then 'tables' when 'S' then 'sequences' when 'f' then 'functions'
                          when 'T' then 'types' when 'n' then 'schemas' end;
    select d.defaclacl into v_acl from pg_catalog.pg_default_acl d
     where d.defaclrole = v_role and d.defaclnamespace = v_nsp and d.defaclobjtype = v_type;
    if v_nsp = 0 then
      v_cur := coalesce(v_acl, pg_catalog.acldefault(v_type, v_role));
      v_old := coalesce(b.acl::aclitem[], pg_catalog.acldefault(v_type, v_role));
      v_after := coalesce(b.acl_after::aclitem[], pg_catalog.acldefault(v_type, v_role));
    else
      v_cur := nullif(v_acl, '{}'::aclitem[]);
      v_old := nullif(b.acl::aclitem[], '{}'::aclitem[]);
      v_after := nullif(b.acl_after::aclitem[], '{}'::aclitem[]);
    end if;
    -- Same rule as above: only entries 0036 changed and nobody changed since.
    if array(select x::text from unnest(v_cur) x order by 1) = array(select x::text from unnest(v_old) x order by 1) then
      continue;
    end if;
    if b.after_captured_at is not null
       and array(select x::text from unnest(v_old) x order by 1) = array(select x::text from unnest(v_after) x order by 1) then
      continue;
    end if;
    if not v_force
       and (b.after_captured_at is null
            or array(select x::text from unnest(v_cur) x order by 1) <> array(select x::text from unnest(v_after) x order by 1)) then
      v_skipped := v_skipped || (b.kind || ' ' || b.ident);
      continue;
    end if;
    for e in
      select x.grantee, x.privilege_type from (select * from pg_catalog.aclexplode(v_cur) except select * from pg_catalog.aclexplode(v_old)) x
      where x.grantee <> v_role
    loop
      v_who := case when e.grantee = 0 then 'public' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(e.grantee)) end;
      execute pg_catalog.format('alter default privileges for role %I %s revoke %s on %s from %s',
        pg_catalog.pg_get_userbyid(v_role),
        case when v_nsp = 0 then '' else 'in schema ' || pg_catalog.quote_ident(v_nsp::regnamespace::text) end,
        e.privilege_type, v_word, v_who);
    end loop;
    for e in
      select x.grantee, x.privilege_type, x.is_grantable from (select * from pg_catalog.aclexplode(v_old) except select * from pg_catalog.aclexplode(v_cur)) x
      where x.grantee <> v_role
    loop
      v_who := case when e.grantee = 0 then 'public' else pg_catalog.quote_ident(pg_catalog.pg_get_userbyid(e.grantee)) end;
      execute pg_catalog.format('alter default privileges for role %I %s grant %s on %s to %s%s',
        pg_catalog.pg_get_userbyid(v_role),
        case when v_nsp = 0 then '' else 'in schema ' || pg_catalog.quote_ident(v_nsp::regnamespace::text) end,
        e.privilege_type, v_word, v_who, case when e.is_grantable then ' with grant option' else '' end);
    end loop;
  end loop;

  raise notice '0036 rollback: % relation/column/function ACLs restored', v_changed;
  if cardinality(v_skipped) > 0 then
    raise warning '0036 rollback: % entr(y/ies) changed again after 0036 were NOT restored (review by hand, or force): %',
      cardinality(v_skipped), array_to_string(v_skipped, '; ');
  end if;
end;
$$;
commit;
