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
--   * staff (public.is_internal_staff()): unchanged, i.e. exactly what the permissive
--     policies give them today. In the repo that is every object of both buckets
--     (briefs_authenticated_*, kb_storage_*). Prod differs: briefs has only the hand-made
--     "briefs read own" (SELECT, owner = auth.uid()) and "briefs uploads by authenticated"
--     (INSERT), so on prod a staff JWT sees only its own briefs uploads (read-only prod
--     check 15.10.2026: the probe admin sees 0 of 937 briefs objects). The gate keeps that
--     as it is; the self-check therefore compares staff before and after, not with the
--     object total;
--   * everybody else: only objects they own under briefs/brief-scoring/, the path
--     BaseConstructorView.tsx uploads to on /client/base-constructor before calling
--     /api/brief-scoring/parse-pdf. Nothing in knowledge-base.
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
-- CODE. Until the lockdown code commit is deployed, /api/brief-scoring/parse-pdf takes
-- {bucket, path} from the request body and downloads with the service role, so a client
-- that knows a path can still read any briefs object through it. That commit allowlists
-- brief-scoring/ paths and makes non-staff download with their own JWT, so this gate
-- decides.
--
-- SAFETY. The file locks storage.objects ACCESS EXCLUSIVE first (CREATE POLICY needs that
-- lock anyway; every storage request reads the table), so the staff "before" probe and
-- the self-check see the same rows; the lock wait is capped at 3s. The self-check probes
-- both buckets as anon, staff (same count as before the gate), a client (at most its own
-- brief-scoring objects) and a JWT without a profile. Any mismatch raises and the file
-- rolls back.
--
-- ROLLBACK: supabase/operator-sql/20261015_0035_storage_private_buckets_gate.rollback.sql
--   begin; set local lock_timeout = '3s';
--   drop policy if exists lockdown_private_buckets_anon_gate on storage.objects;
--   drop policy if exists lockdown_private_buckets_gate on storage.objects; commit;

set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- Lock first, so the "before" probe and the self-check see the same rows.
lock table storage.objects in access exclusive mode;

-- What the staff probe account sees in the two buckets under today's policies. The gate must
-- leave it exactly as it is (see FIX: on prod that is not "every object").
create temp table lockdown_0035_staff_before (staff uuid not null, n bigint not null) on commit drop;
do $$
declare
  v_prev_role   text := current_setting('role');
  v_prev_claims text := coalesce(current_setting('request.jwt.claims', true), '');
  v_prev_sub    text := coalesce(current_setting('request.jwt.claim.sub', true), '');
  v_staff uuid;
  v_n bigint;
begin
  if to_regclass('storage.objects') is null then
    return; -- the next block raises with a clear message
  end if;
  select p.id into v_staff from public.profiles p
   where p.role in ('technician', 'manager', 'director', 'admin', 'sales', 'marketer', 'lead')
     and coalesce(p.is_demo, false) = false
   order by (p.role = 'admin') desc, p.created_at nulls last, p.id limit 1;
  if v_staff is null then
    return;
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_staff, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_staff::text, true);
  perform set_config('role', 'authenticated', true);
  select count(*) into v_n from storage.objects where bucket_id in ('briefs', 'knowledge-base');
  perform set_config('role', v_prev_role, true);
  perform set_config('request.jwt.claims', v_prev_claims, true);
  perform set_config('request.jwt.claim.sub', v_prev_sub, true);
  insert into pg_temp.lockdown_0035_staff_before (staff, n) values (v_staff, v_n);
end;
$$;

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
  v_staff_before bigint;
  v_client uuid;
  v_n bigint;
  v_expect bigint;
  v_client_own text;
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

  -- The same staff account the "before" probe used (none: no staff profile, probe skipped).
  select b.staff, b.n into v_staff, v_staff_before from pg_temp.lockdown_0035_staff_before b limit 1;
  select p.id into v_client from public.profiles p
   where p.role = 'client' order by p.created_at nulls last, p.id limit 1;

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
    if v_n is distinct from v_staff_before then
      raise exception 'private buckets gate probe: staff sees % objects in the private buckets, % before the gate', v_n, v_staff_before;
    end if;
  end if;

  if v_client is not null then
    -- Own = the gate's own predicate (owner and/or owner_id, whichever columns exist).
    v_client_own := concat_ws(' or ',
      case when exists (select 1 from pg_catalog.pg_attribute where attrelid = 'storage.objects'::regclass and attname = 'owner' and not attisdropped)
           then 'o.owner = $1' end,
      case when exists (select 1 from pg_catalog.pg_attribute where attrelid = 'storage.objects'::regclass and attname = 'owner_id' and not attisdropped)
           then 'o.owner_id = $1::text' end);
    execute format('select count(*) from storage.objects o where o.bucket_id = %L and o.name like %L and (%s)',
                   'briefs', 'brief-scoring/%', v_client_own)
       into v_expect using v_client;
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
