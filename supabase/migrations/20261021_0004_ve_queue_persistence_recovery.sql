-- A completed checkpoint can be followed by a failed queue UPDATE. Recover
-- the same saved parent, not the explicit retry path (which grants more work).
create function public.ve_auto_resume_queue_persistence_failures(
  p_limit integer default 4,p_now timestamptz default now()
) returns integer language plpgsql security definer set search_path='' as $$
declare
  item record;
  prep public.ve_outreach_preparations%rowtype;
  setup public.ve_outreach_setups%rowtype;
  job public.ve_jobs%rowtype;
  base public.ve_bases%rowtype;
  info jsonb;
  progress jsonb;
  pipeline jsonb;
  recovery jsonb;
  recovered integer;
  total integer := 0;
  resume_limit integer := greatest(1,least(coalesce(p_limit,4),10));
  failure_pattern constant text := '^ve_jobs requeue: (An invalid response was received from the upstream server|The upstream server is (currently unavailable|timing out)|name resolution failed|failure to get a peer from the ring-balancer|fetch failed|connection (reset|terminated|closed)|[A-Za-z]*Error: VE2 database [A-Z]+ request (timeout after|connection lost)|VE2 database [A-Z]+ request (timeout after|connection lost))';
begin
  if p_now is null then return 0; end if;
  for item in select p.project_id,p.hypothesis_id,p.base_id
    from public.ve_outreach_preparations p
    where p.status='error' and p.paused_at is null and p.cancelled_at is null
      and p.last_error ~* failure_pattern and p.updated_at<=p_now-interval '20 minutes'
    -- Old ineligible history must not fill the whole recovery allowance.
    -- The outer scan reads IDs only and remains bounded; stop at resume_limit
    -- successful checkpoints, not resume_limit historical errors inspected.
    order by p.updated_at limit 100
  loop
    exit when total>=resume_limit;
    begin
      if not pg_try_advisory_xact_lock(hashtextextended(item.project_id::text,22082029)) then continue; end if;
      select * into prep from public.ve_outreach_preparations
        where project_id=item.project_id and hypothesis_id=item.hypothesis_id for update nowait;
      if not found or prep.status<>'error' or prep.base_id is distinct from item.base_id
        or prep.paused_at is not null or prep.cancelled_at is not null or prep.template_id is not null
        or prep.locked_until>p_now or prep.updated_at>p_now-interval '20 minutes'
        or prep.last_error is null or prep.last_error !~* failure_pattern then continue; end if;
      select * into setup from public.ve_outreach_setups where project_id=item.project_id for share nowait;
      if not found or (not prep.independent_control and
        (not (item.hypothesis_id=any(setup.selected_hypothesis_ids)) or prep.language<>setup.language))
        or setup.approved_bases ? item.base_id::text
        or not exists(select 1 from public.ve_hypotheses h where h.id=item.hypothesis_id
          and h.project_id=item.project_id and h.status<>'rejected' and h.vertical_id is not null)
        or public.ve_base_audience_frozen(item.base_id)
        or exists(select 1 from public.ve_outreach_runs r where r.project_id=item.project_id
          and r.status in ('queued','running','waiting') and exists(select 1 from jsonb_array_elements(r.request->'items') x
            where x->>'hypothesis_id'=item.hypothesis_id::text)) then continue; end if;
      -- Match the stage writer's job-before-base lock order. A newer job or
      -- another active base for the same hypothesis makes this history obsolete.
      select * into job from public.ve_jobs j where j.project_id=item.project_id
        and j.payload->>'base_id'=item.base_id::text order by j.created_at desc,j.id desc limit 1 for update nowait;
      if not found or job.stage<>'base_collect' or job.status<>'failed' or job.error is null or job.error !~* failure_pattern
        or job.error is distinct from prep.last_error or job.payload->>'collection_mode' is distinct from 'preview'
        or job.payload->>'hypothesis_id' is distinct from item.hypothesis_id::text
        or coalesce(job.payload->'refill','false'::jsonb)<>'false'::jsonb
        or coalesce(job.payload->'review_relevance','false'::jsonb)<>'false'::jsonb
        or coalesce(job.payload->'requesty_billing_wait','null'::jsonb)<>'null'::jsonb
        or exists(select 1 from public.ve_jobs j join public.ve_bases b on b.id::text=j.payload->>'base_id'
          where j.project_id=item.project_id and b.hypothesis_id=item.hypothesis_id and j.status in ('pending','running'))
        then continue; end if;
      select * into base from public.ve_bases b where b.id=item.base_id for update nowait;
      if not found or base.project_id<>item.project_id or base.hypothesis_id is distinct from item.hypothesis_id
        or base.status<>'failed' or base.source<>'auto' or base.error is distinct from job.error
        or not exists(select 1 from public.ve_hypotheses h where h.id=item.hypothesis_id and h.vertical_id=base.vertical_id)
        or exists(select 1 from public.ve_bases b where b.project_id=item.project_id and b.hypothesis_id=item.hypothesis_id
          and b.id<>base.id and (b.created_at,b.id)>(base.created_at,base.id)) then continue; end if;
      info:=base.collect_info; progress:=info->'target_progress'; pipeline:=info->'preview_pipeline';
      if info->>'collection_mode' is distinct from 'preview' or progress->>'mode' is distinct from 'preview'
        or coalesce(info->'refill','false'::jsonb)<>'false'::jsonb
        or progress->>'status' is distinct from 'error' or progress->>'reason' is distinct from job.error
        or jsonb_typeof(base.data) is distinct from 'array' or base.row_count<>jsonb_array_length(base.data)
        or jsonb_typeof(info->'target_checkpoint') is distinct from 'object'
        or jsonb_typeof(info#>'{target_checkpoint,seen_rows}') is distinct from 'array'
        or exists(select 1 from unnest(array['round','max_rounds','max_candidates','candidates_processed','ready_target','ready_rows']) k
          where jsonb_typeof(progress->k) is distinct from 'number' or coalesce(progress->>k,'') !~ '^[0-9]{1,8}$')
        or coalesce(info#>>'{target_checkpoint,completed_round}','') !~ '^[0-9]{1,8}$'
        or jsonb_typeof(info#>'{target_checkpoint,completed_round}') is distinct from 'number'
        then continue; end if;
      -- Resume only the already-open next round. Completed review retries have
      -- separate recovery rules and cannot be inferred from a generic DB error.
      if (progress->>'round')::integer not between 1 and (progress->>'max_rounds')::integer
        or (progress->>'max_rounds')::integer not between 1 and 10000
        or (progress->>'max_candidates')::integer not between 1 and 10000
        or (progress->>'candidates_processed')::integer not between 0 and (progress->>'max_candidates')::integer
        or (progress->>'ready_target')::integer not between 1 and (progress->>'max_candidates')::integer
        or (progress->>'ready_rows')::integer>base.row_count
        or info->>'ready_target' is distinct from progress->>'ready_target'
        or (info#>>'{target_checkpoint,completed_round}')::integer<>(progress->>'round')::integer-1
        then continue; end if;
      -- Never restart shared child work. Every retained constructor must already
      -- be complete; pending pipeline batches are consumed from these same IDs.
      if jsonb_typeof(info->'tasks') is distinct from 'array'
        or exists(select 1 from jsonb_array_elements(info->'tasks') t where t->>'status' is distinct from 'done')
        or (coalesce(info->'construct','null'::jsonb)<>'null'::jsonb and
          (coalesce(info#>>'{construct,status}','') not in ('dispatched','done')
            or not exists(select 1 from public.base_constructor_jobs c where c.id::text=info#>>'{construct,bc_job_id}' and c.status='completed')))
        then continue; end if;
      if coalesce(pipeline,'null'::jsonb)<>'null'::jsonb then
        if pipeline->'version' is distinct from '1'::jsonb or jsonb_typeof(pipeline->'batches') is distinct from 'array'
          or jsonb_typeof(pipeline->'job_ids') is distinct from 'array' or nullif(pipeline->>'error','') is not null
          or exists(select 1 from jsonb_array_elements_text(pipeline->'job_ids') child_id
            where not exists(select 1 from public.base_constructor_jobs c where c.id::text=child_id and c.status='completed'))
          or exists(select 1 from jsonb_array_elements(pipeline->'batches') batch
            where jsonb_typeof(batch->'rows') is distinct from 'array' or batch->'inserted' is distinct from 'true'::jsonb
              or not exists(select 1 from public.base_constructor_jobs c where c.id::text=batch->>'id' and c.status='completed'))
          then continue; end if;
      end if;
      recovery:=job.payload->'queue_persistence_recovery';
      if coalesce(recovery,'null'::jsonb)='null'::jsonb then recovered:=0;
      elsif recovery->'version'='1'::jsonb and coalesce(recovery->>'count','') ~ '^[0-9]$' then
        recovered:=(recovery->>'count')::integer;
      else continue; end if;
      if recovered>=3 then continue; end if;
      update public.ve_jobs set status='pending',error=null,started_at=null,finished_at=null,run_after=p_now,updated_at=p_now,
        payload=payload||jsonb_build_object('queue_persistence_recovery',jsonb_build_object('version',1,'count',recovered+1,
          'resumed_at',p_now,'previous_error',job.error)) where id=job.id;
      update public.ve_bases set status='collecting',error=null,updated_at=p_now,
        collect_info=jsonb_set(info,'{target_progress}',(progress-'reason')||jsonb_build_object('status','collecting')) where id=base.id;
      update public.ve_outreach_preparations set status='collecting',last_error=null,claim_token=null,locked_until=null,
        updated_at=p_now where project_id=item.project_id and hypothesis_id=item.hypothesis_id;
      total:=total+1;
    exception when lock_not_available then null;
    end;
  end loop;
  return total;
end;
$$;
alter function public.ve_auto_resume_queue_persistence_failures(integer,timestamptz) owner to postgres;
revoke all on function public.ve_auto_resume_queue_persistence_failures(integer,timestamptz) from public,anon,authenticated;
grant execute on function public.ve_auto_resume_queue_persistence_failures(integer,timestamptz) to service_role;

-- Queue persistence has its own same-job recovery above. The older generic
-- provider-retry path must never grant a new round budget for this error.
create or replace function public.ve_transient_collect_error(p_error text)
returns boolean language sql immutable set search_path='' as $$
  select p_error is not null
    and p_error !~* '^ve_jobs requeue:'
    and p_error !~* '\m(402|insufficient|not enough credits|payment required|billing)\M'
    and p_error !~* '\m(401|403|api[_ -]?key|unauthorized|forbidden)\M'
    and p_error !~* 'Отменено пользователем'
    and (p_error ~* 'Serper transient'
      or p_error ~* '\mRequesty\s+(408|425|429|500|502|503|504)\M'
      or p_error ~* '(timeout|timed out|timing out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network error)'
      or p_error ~* 'временно (недоступн|ограничил)'
      or p_error ~* 'завершил(ась|ся) не полностью'
      or p_error ~* 'не завершен\w*: *provider');
$$;
revoke all on function public.ve_transient_collect_error(text) from public,anon,authenticated;
grant execute on function public.ve_transient_collect_error(text) to service_role;
