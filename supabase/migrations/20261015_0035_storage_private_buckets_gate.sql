-- Close the briefs and knowledge-base storage buckets to non-staff accounts.
--
-- LEAK. storage.objects policies from 20260419_0001 (briefs) and 20260320_0001
-- (knowledge-base) check only bucket_id for authenticated. Any signed-in account,
-- including an open ENG self-serve signup or the demo account, can list, download,
-- overwrite and delete every brief PDF (staff project briefs, brief-scoring uploads of
-- every client) and every knowledge-base file (sales scripts, call transcripts) through
-- /storage/v1 with its own JWT. storage-api runs each request as the caller's role, so
-- storage.objects RLS is the only guard.
--
-- FIX. Two RESTRICTIVE policies on storage.objects that only speak about these two
-- buckets:
--   lockdown_private_buckets_gate, TO authenticated:
--   * other buckets: unchanged (the policy is true for them);
--   * staff (public.is_internal_staff()): unchanged, every object of both buckets;
--   * everybody else: only objects they own under briefs/brief-scoring/, the path
--     BaseConstructorView.tsx uploads to on /client/base-constructor before calling
--     /api/brief-scoring/parse-pdf (which then reads the file with the service role).
--     Nothing in knowledge-base.
--   lockdown_private_buckets_anon_gate, TO anon: nothing in either bucket, everything
--     else unchanged. The repo has no anon policy on these buckets, but on prod anon
--     holds ALL on storage.objects (fix-roles.sql) and a hand-made Studio policy
--     "TO public USING (bucket_id = 'briefs')" would otherwise survive. It calls no
--     helper (anon cannot execute is_internal_staff()), so anonymous reads of other
--     buckets keep working.
--
-- NOT CHANGED. storage.buckets, other buckets (reglament-assets, inn-enrich, exports,
-- tg-outreach-sessions, ...), the service role (BYPASSRLS) and storage-api's own
-- connection (superuser).
--
-- STILL OPEN IN CODE. /api/brief-scoring/parse-pdf takes {bucket, path} from the request
-- body and downloads with the service role, so a client that knows a path can still
-- read any briefs object through it. The route must check the path prefix and the
-- object owner before its service-role download (release notes).
--
-- SAFETY. CREATE POLICY takes ACCESS EXCLUSIVE on storage.objects, which every storage
-- request reads; the lock wait is capped at 3s. The self-check probes both buckets as
-- anon, staff, a client and a JWT without a profile. Any mismatch raises and the file
-- rolls back.
--
-- ROLLBACK: supabase/operator-sql/20261015_0035_storage_private_buckets_gate.rollback.sql
--   begin; set local lock_timeout = '3s';
--   drop policy if exists lockdown_private_buckets_anon_gate on storage.objects;
--   drop policy if exists lockdown_private_buckets_gate on storage.objects; commit;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

do $$
declare
  v_own text;
  v_has_owner boolean;
  v_has_owner_id boolean;
begin
  if to_regprocedure('public.is_internal_staff()') is null then
    raise exception 'private buckets gate: public.is_internal_staff() is missing; apply 20261015_0030 first';
  end if;
  if to_regclass('storage.objects') is null then
    raise exception 'private buckets gate: storage.objects is missing';
  end if;
  if not (select relrowsecurity from pg_catalog.pg_class where oid = 'storage.objects'::regclass) then
    raise exception 'private buckets gate: RLS is disabled on storage.objects';
  end if;

  -- storage-api fills owner (uuid, older) and owner_id (text, newer) with the JWT sub.
  select exists (select 1 from pg_catalog.pg_attribute where attrelid = 'storage.objects'::regclass and attname = 'owner' and not attisdropped),
         exists (select 1 from pg_catalog.pg_attribute where attrelid = 'storage.objects'::regclass and attname = 'owner_id' and not attisdropped)
    into v_has_owner, v_has_owner_id;
  if not (v_has_owner or v_has_owner_id) then
    raise exception 'private buckets gate: storage.objects has neither owner nor owner_id';
  end if;
  v_own := concat_ws(' or ',
             case when v_has_owner then 'owner = (select auth.uid())' end,
             case when v_has_owner_id then 'owner_id = (select auth.uid())::text' end);

  drop policy if exists lockdown_private_buckets_gate on storage.objects;
  execute format($p$create policy lockdown_private_buckets_gate on storage.objects
    as restrictive for all to authenticated
    using (bucket_id not in ('briefs', 'knowledge-base')
           or (select public.is_internal_staff())
           or (bucket_id = 'briefs' and name like 'brief-scoring/%%' and (%1$s)))
    with check (bucket_id not in ('briefs', 'knowledge-base')
           or (select public.is_internal_staff())
           or (bucket_id = 'briefs' and name like 'brief-scoring/%%' and (%1$s)))$p$, v_own);

  drop policy if exists lockdown_private_buckets_anon_gate on storage.objects;
  create policy lockdown_private_buckets_anon_gate on storage.objects
    as restrictive for all to anon
    using (bucket_id not in ('briefs', 'knowledge-base'))
    with check (bucket_id not in ('briefs', 'knowledge-base'));
end;
$$;

-- Self-check.
do $$
declare
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_unknown uuid := '00000000-0000-4000-8000-00000000dead';
  v_staff uuid;
  v_client uuid;
  v_total bigint;
  v_n bigint;
  v_expect bigint;
begin
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'lockdown_private_buckets_gate'
      and permissive = 'RESTRICTIVE' and cmd = 'ALL' and roles = array['authenticated']::name[]
      and qual like '%is_internal_staff()%' and with_check like '%is_internal_staff()%'
  ) then
    raise exception 'private buckets gate: the restrictive policy is missing or wrong';
  end if;
  if not exists (
    select 1 from pg_catalog.pg_policies
    where schemaname = 'storage' and tablename = 'objects' and policyname = 'lockdown_private_buckets_anon_gate'
      and permissive = 'RESTRICTIVE' and cmd = 'ALL' and roles = array['anon']::name[]
      and qual like '%briefs%knowledge-base%' and with_check like '%briefs%knowledge-base%'
      and qual not like '%is_internal_staff%'
  ) then
    raise exception 'private buckets gate: the restrictive anon policy is missing or wrong';
  end if;
  if not pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER')
     or not pg_catalog.pg_has_role(current_user, 'anon', 'MEMBER') then
    raise exception 'private buckets gate: % cannot SET ROLE anon/authenticated for the self-check', current_user;
  end if;

  select p.id into v_staff from public.profiles p
   where p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(p.is_demo, false) = false
   order by (p.role = 'admin') desc, p.created_at nulls last, p.id limit 1;
  select p.id into v_client from public.profiles p
   where p.role = 'client' order by p.created_at nulls last, p.id limit 1;

  select count(*) into v_total from storage.objects where bucket_id in ('briefs', 'knowledge-base');

  -- anon: nothing in the two buckets (no table privilege counts as nothing).
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform set_config('role', 'anon', true);
    select count(*) into v_n from storage.objects where bucket_id in ('briefs', 'knowledge-base');
    perform set_config('role', v_prev_role, true);
  exception when insufficient_privilege then
    v_n := 0;
  end;
  if v_n <> 0 then
    raise exception 'private buckets gate probe: anon sees % objects in the private buckets', v_n;
  end if;

  -- A JWT without a profile: nothing in the two buckets.
  perform set_config('request.jwt.claims', json_build_object('sub', v_unknown, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_unknown::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from storage.objects where bucket_id in ('briefs', 'knowledge-base');
  perform set_config('role', v_prev_role, true);
  if v_n <> 0 then
    raise exception 'private buckets gate probe: a JWT without a profile sees % objects', v_n;
  end if;

  if v_staff is not null then
    perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_staff::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into v_n from storage.objects where bucket_id in ('briefs', 'knowledge-base');
    perform set_config('role', v_prev_role, true);
    if v_n <> v_total then
      raise exception 'private buckets gate probe: staff sees % of % objects', v_n, v_total;
    end if;
  end if;

  if v_client is not null then
    select count(*) into v_expect from storage.objects o
     where o.bucket_id = 'briefs' and o.name like 'brief-scoring/%' and o.owner = v_client;
    perform set_config('request.jwt.claims', json_build_object('sub', v_client, 'role', 'authenticated')::text, true);
    perform set_config('request.jwt.claim.sub', v_client::text, true);
    perform set_config('role', 'authenticated', true);
    select count(*) into v_n from storage.objects where bucket_id in ('briefs', 'knowledge-base');
    perform set_config('role', v_prev_role, true);
    if v_n > v_expect then
      raise exception 'private buckets gate probe: client sees % objects in the private buckets, owns %', v_n, v_expect;
    end if;
  end if;

  perform set_config('request.jwt.claims', v_prev_claims, true);
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
end;
$$;
