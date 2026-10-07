-- A shared search queue. Manual jobs keep their parser configuration; VE2 buys
-- small discovery pages only. All admission/budget decisions are atomic.
create table public.search_execution_leases (
  job_id uuid primary key references public.search_parser_jobs(id) on delete cascade,
  token uuid not null,
  expires_at timestamptz not null
);
create table public.ve_search_probes (
  job_id uuid primary key references public.search_parser_jobs(id) on delete cascade,
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  hypothesis_id uuid not null references public.ve_hypotheses(id) on delete cascade,
  base_id uuid not null references public.ve_bases(id) on delete cascade,
  parent_job_id uuid not null references public.ve_jobs(id) on delete cascade,
  query text not null check(length(query) between 1 and 300),
  locale text not null check(locale in ('ru','en')),
  page integer not null check(page between 1 and 3),
  attempted_at timestamptz,
  not_before timestamptz not null default now(),
  results jsonb,
  created_at timestamptz not null default now(),
  unique(hypothesis_id,query,locale,page)
);
create index ve_search_probes_base on public.ve_search_probes(base_id);
create table public.ve_search_budget_bases (
  base_id uuid primary key references public.ve_bases(id) on delete cascade
);
alter table public.ve_search_budget_bases enable row level security;
revoke all on public.ve_search_budget_bases from public,anon,authenticated,service_role;
grant select on public.ve_search_budget_bases to service_role;
create table public.ve_search_spend (
  attempt_id uuid primary key,
  base_id uuid references public.ve_bases(id) on delete set null,
  reserved_usd numeric not null check(reserved_usd>0),
  charged_usd numeric not null check(charged_usd>=0),
  created_at timestamptz not null default clock_timestamp()
);
create index ve_search_spend_date on public.ve_search_spend(created_at);
create table public.ve_search_control (
  singleton boolean primary key default true check(singleton),
  enabled boolean not null default false,
  daily_usd numeric not null default 3 check(daily_usd between 0 and 3),
  blocked_reason text
);
-- Deployment alone must not initiate spending before capacity/billing review.
insert into public.ve_search_control(singleton) values(true);
alter table public.search_execution_leases enable row level security;
alter table public.ve_search_probes enable row level security;
alter table public.ve_search_spend enable row level security;
alter table public.ve_search_control enable row level security;
revoke all on public.search_execution_leases,public.ve_search_probes,public.ve_search_spend,public.ve_search_control from public,anon,authenticated,service_role;
grant select on public.search_execution_leases to service_role;
grant select on public.ve_search_probes to service_role;
grant select on public.ve_search_spend to service_role;
grant select on public.ve_search_control to service_role;

create function public.search_claim_job(p_job_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_token uuid:=gen_random_uuid(); v_probe jsonb; v_active integer;
begin
  perform pg_advisory_xact_lock(73104,1);
  -- Deleting a VE project/base must never turn its pending probe into a full
  -- unbudgeted manual parser job after the FK cascade removes its metadata.
  update public.search_parser_jobs j set status='failed',completed_at=clock_timestamp(),error_message='Поисковая проба больше не связана с базой'
    where j.status in ('pending','running') and j.config->>'ve_search_probe'='true'
      and not exists(select 1 from public.ve_search_probes p where p.job_id=j.id);
  -- Never reclaim another healthy process's work on worker startup.
  update public.search_parser_jobs j set status='failed',completed_at=clock_timestamp(),
    error_message='Результат платного поискового запроса неизвестен. Автоматический повтор не выполняется.'
    from public.search_execution_leases l, public.ve_search_probes p
    where j.id=l.job_id and p.job_id=j.id and l.expires_at<clock_timestamp()
      and j.status='running' and p.attempted_at is not null and p.results is null;
  update public.search_parser_jobs j set status='pending'
    from public.search_execution_leases l where j.id=l.job_id and j.status='running'
      and l.expires_at<clock_timestamp();
  -- Legacy running jobs have no lease. Allow the previous deployment to drain.
  update public.search_parser_jobs j set status='pending' where j.status='running'
    and coalesce(j.started_at,j.created_at)<clock_timestamp()-interval '3 hours'
    and not exists(select 1 from public.search_execution_leases l where l.job_id=j.id);
  delete from public.search_execution_leases l where l.expires_at<clock_timestamp()
    or not exists(select 1 from public.search_parser_jobs j where j.id=l.job_id and j.status='running');
  -- A cancelled parent cannot buy a search later while its child waits in queue.
  update public.search_parser_jobs j set status='failed',completed_at=clock_timestamp(),error_message='Подготовка базы отменена'
    from public.ve_search_probes p where p.job_id=j.id and j.status='pending'
    and not exists(select 1 from public.ve_jobs v join public.ve_bases b on b.id=p.base_id
      where v.id=p.parent_job_id and v.status in ('running','pending') and b.status='collecting');
  select count(*) into v_active from public.search_parser_jobs where status='running';
  if v_active>=5 then return null; end if;
  select j.id into v_id from public.search_parser_jobs j
    where j.status='pending' and (p_job_id is null or j.id=p_job_id)
    and (not exists(select 1 from public.ve_search_probes p where p.job_id=j.id)
      or (exists(select 1 from public.ve_search_probes p where p.job_id=j.id and p.not_before<=clock_timestamp())
        and exists(select 1 from public.ve_search_control where enabled and blocked_reason is null)
        and not exists(select 1 from public.search_parser_jobs m where m.status='pending'
          and not exists(select 1 from public.ve_search_probes p where p.job_id=m.id))
        and not exists(select 1 from public.search_parser_jobs a join public.ve_search_probes p on p.job_id=a.id where a.status='running')))
    order by exists(select 1 from public.ve_search_probes p where p.job_id=j.id),j.created_at,j.id
    limit 1 for update of j skip locked;
  if v_id is null then return null; end if;
  update public.search_parser_jobs set status='running',started_at=clock_timestamp() where id=v_id;
  insert into public.search_execution_leases values(v_id,v_token,clock_timestamp()+interval '5 minutes');
  select to_jsonb(p) into v_probe from public.ve_search_probes p where p.job_id=v_id;
  return jsonb_build_object('job_id',v_id,'token',v_token,'probe',v_probe);
end $$;

create function public.search_heartbeat(p_job_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(73104,1);
  update public.search_execution_leases l set expires_at=clock_timestamp()+interval '5 minutes'
    where l.job_id=p_job_id and l.token=p_token and l.expires_at>clock_timestamp()
      and exists(select 1 from public.search_parser_jobs j where j.id=l.job_id and j.status='running');
  return found;
end $$;

create function public.search_save_progress(p_job_id uuid,p_token uuid,p_patch jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(73104,1);
  perform 1 from public.search_execution_leases where job_id=p_job_id and token=p_token
    and expires_at>clock_timestamp() for update;
  if not found then return false; end if;
  update public.search_parser_jobs j set
    status=coalesce(p_patch->>'status',j.status),
    config=coalesce(p_patch->'config',j.config),
    total_queries=coalesce((p_patch->>'total_queries')::integer,j.total_queries),
    processed_queries=coalesce((p_patch->>'processed_queries')::integer,j.processed_queries),
    total_results=case when p_patch?'total_results' then
      (select count(*)::integer from public.search_results r where r.job_id=j.id) else j.total_results end,
    progress_percent=coalesce((p_patch->>'progress_percent')::integer,j.progress_percent),
    progress_stage=coalesce(p_patch->>'progress_stage',j.progress_stage),
    error_message=case when p_patch?'error_message' then p_patch->>'error_message' else j.error_message end,
    completed_at=coalesce((p_patch->>'completed_at')::timestamptz,j.completed_at)
    where j.id=p_job_id and j.status='running';
  return found;
end $$;

create function public.search_save_results(p_job_id uuid,p_token uuid,p_rows jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare v_count integer;
begin
  perform pg_advisory_xact_lock(73104,1);
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows)>250 then raise exception 'Invalid result batch'; end if;
  perform 1 from public.search_execution_leases l join public.search_parser_jobs j on j.id=l.job_id
    where l.job_id=p_job_id and l.token=p_token and l.expires_at>clock_timestamp() and j.status='running' for update of l,j;
  if not found then raise exception 'Search execution ownership lost'; end if;
  insert into public.search_results(job_id,query,title,link,snippet,position,company_name,site,description,email,provider)
    select p_job_id,r.query,r.title,r.link,r.snippet,r.position,r.company_name,r.site,r.description,r.email,r.provider
    from jsonb_to_recordset(p_rows) as r(query text,title text,link text,snippet text,position integer,company_name text,site text,description text,email text,provider text)
    where not exists(select 1 from public.search_results e where e.job_id=p_job_id and e.site=r.site);
  get diagnostics v_count=row_count;
  return v_count;
end $$;

create function public.ve_reserve_search_spend(p_base_id uuid,p_attempt_id uuid,p_reserved_usd numeric) returns text
language plpgsql security definer set search_path='' as $$
declare v_limit numeric; v_spent numeric;
begin
  if not exists(select 1 from public.ve_bases where id=p_base_id) then return 'inactive_base'; end if;
  if not exists(select 1 from public.ve_search_budget_bases where base_id=p_base_id) then return 'not_applicable'; end if;
  perform pg_advisory_xact_lock(73104,2);
  if exists(select 1 from public.ve_search_spend where attempt_id=p_attempt_id and base_id=p_base_id) then return 'reserved'; end if;
  select daily_usd into v_limit from public.ve_search_control where enabled and blocked_reason is null;
  if v_limit is null then return 'disabled'; end if;
  if p_reserved_usd is null or p_reserved_usd<=0 or p_reserved_usd>3 then return 'unknown_price'; end if;
  -- Rolling 24h is stricter than a calendar day and cannot double at midnight.
  select coalesce(sum(charged_usd),0) into v_spent from public.ve_search_spend
    where created_at>clock_timestamp()-interval '24 hours';
  if v_spent+p_reserved_usd>v_limit then return 'budget'; end if;
  insert into public.ve_search_spend values(p_attempt_id,p_base_id,p_reserved_usd,p_reserved_usd,clock_timestamp());
  return 'reserved';
end $$;

create function public.ve_settle_search_spend(p_attempt_id uuid,p_actual_usd numeric) returns void
language plpgsql security definer set search_path='' as $$
declare v_reserved numeric;
begin
  perform pg_advisory_xact_lock(73104,2);
  select reserved_usd into v_reserved from public.ve_search_spend where attempt_id=p_attempt_id for update;
  if not found or p_actual_usd is null or p_actual_usd<0 then return; end if;
  update public.ve_search_spend set charged_usd=p_actual_usd where attempt_id=p_attempt_id;
  if p_actual_usd>v_reserved then
    update public.ve_search_control set blocked_reason='Стоимость провайдера превысила резерв: требуется проверка тарифа';
  end if;
end $$;

create function public.ve_enqueue_search_probe(p_base_id uuid,p_parent_job_id uuid,p_query text,p_locale text,p_page integer) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_base record; v_owner uuid; v_id uuid; v_cached jsonb;
begin
  perform pg_advisory_xact_lock(73104,1);
  select project_id,hypothesis_id into v_base from public.ve_bases where id=p_base_id and status='collecting';
  if not found or not exists(select 1 from public.ve_jobs where id=p_parent_job_id and project_id=v_base.project_id
    and stage='base_collect' and status='running') then raise exception 'Inactive collection'; end if;
  if p_query is null or p_locale is null or p_page is null or length(btrim(p_query)) not between 1 and 300 or p_locale not in ('ru','en') or p_page not between 1 and 3 then raise exception 'Invalid probe'; end if;
  select job_id into v_id from public.ve_search_probes where hypothesis_id=v_base.hypothesis_id and query=p_query and locale=p_locale and page=p_page;
  if found then
    insert into public.ve_search_budget_bases values(p_base_id) on conflict do nothing;
    return jsonb_build_object('job_id',v_id);
  end if;
  if not exists(select 1 from public.ve_search_control where enabled and blocked_reason is null) then return jsonb_build_object('wait','disabled'); end if;
  if (select count(*) from public.ve_search_probes p join public.search_parser_jobs j on j.id=p.job_id where j.status in ('pending','running'))>=20 then
    return jsonb_build_object('wait','capacity');
  end if;
  insert into public.ve_search_budget_bases values(p_base_id) on conflict do nothing;
  select created_by into v_owner from public.ve_projects where id=v_base.project_id;
  if v_owner is null then raise exception 'Search job owner missing'; end if;
  -- Public SERP cache only; never consume another specialist's private job.
  select results into v_cached from public.ve_search_probes where query=p_query and locale=p_locale and page=p_page
    and results is not null and created_at>clock_timestamp()-interval '30 days' order by created_at desc limit 1;
  insert into public.search_parser_jobs(user_id,status,config,total_queries) values(v_owner,'pending',jsonb_build_object('queries',jsonb_build_array(p_query),'search_depth',1,'ve_search_probe',true),1) returning id into v_id;
  insert into public.ve_search_probes(job_id,project_id,hypothesis_id,base_id,parent_job_id,query,locale,page,results)
    values(v_id,v_base.project_id,v_base.hypothesis_id,p_base_id,p_parent_job_id,p_query,p_locale,p_page,v_cached);
  return jsonb_build_object('job_id',v_id);
end $$;

create function public.ve_begin_search_probe(p_job_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(73104,1);
  perform 1 from public.search_execution_leases l join public.search_parser_jobs j on j.id=l.job_id
    where l.job_id=p_job_id and l.token=p_token and l.expires_at>clock_timestamp() and j.status='running' for update of l,j;
  if not found then return false; end if;
  update public.ve_search_probes p set attempted_at=clock_timestamp() where p.job_id=p_job_id and p.attempted_at is null
    and exists(select 1 from public.ve_jobs j join public.ve_bases b on b.id=p.base_id
      where j.id=p.parent_job_id and j.status in ('running','pending') and b.status='collecting');
  return found;
end $$;

create function public.ve_finish_search_probe(p_job_id uuid,p_token uuid,p_results jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(73104,1);
  if jsonb_typeof(p_results) is distinct from 'array' or jsonb_array_length(p_results)>10 then raise exception 'Invalid search page'; end if;
  perform 1 from public.search_execution_leases l join public.search_parser_jobs j on j.id=l.job_id
    where l.job_id=p_job_id and l.token=p_token and l.expires_at>clock_timestamp() and j.status='running' for update of l,j;
  if not found then return false; end if;
  update public.ve_search_probes set results=p_results where job_id=p_job_id;
  update public.search_parser_jobs set status='completed',completed_at=clock_timestamp(),processed_queries=1,
    progress_stage='completed',progress_percent=100,total_results=jsonb_array_length(p_results) where id=p_job_id;
  return true;
end $$;

revoke all on function public.search_claim_job(uuid),public.search_heartbeat(uuid,uuid),public.search_save_progress(uuid,uuid,jsonb),public.search_save_results(uuid,uuid,jsonb),public.ve_reserve_search_spend(uuid,uuid,numeric),public.ve_settle_search_spend(uuid,numeric),public.ve_enqueue_search_probe(uuid,uuid,text,text,integer),public.ve_begin_search_probe(uuid,uuid),public.ve_finish_search_probe(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.search_claim_job(uuid),public.search_heartbeat(uuid,uuid),public.search_save_progress(uuid,uuid,jsonb),public.search_save_results(uuid,uuid,jsonb),public.ve_reserve_search_spend(uuid,uuid,numeric),public.ve_settle_search_spend(uuid,numeric),public.ve_enqueue_search_probe(uuid,uuid,text,text,integer),public.ve_begin_search_probe(uuid,uuid),public.ve_finish_search_probe(uuid,uuid,jsonb) to service_role;

create function public.ve_delay_search_probe(p_job_id uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform pg_advisory_xact_lock(73104,1);
  perform 1 from public.search_execution_leases l join public.search_parser_jobs j on j.id=l.job_id
    where l.job_id=p_job_id and l.token=p_token and l.expires_at>clock_timestamp() and j.status='running' for update of l,j;
  if not found then return false; end if;
  update public.ve_search_probes set not_before=clock_timestamp()+interval '1 hour' where job_id=p_job_id and attempted_at is null;
  if not found then return false; end if;
  update public.search_parser_jobs set status='pending',progress_stage='budget_wait',
    error_message='Поисковый добор ожидает освобождения общего бюджета $3 за 24 часа' where id=p_job_id;
  return true;
end $$;
revoke all on function public.ve_delay_search_probe(uuid,uuid) from public,anon,authenticated;
grant execute on function public.ve_delay_search_probe(uuid,uuid) to service_role;
