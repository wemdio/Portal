-- A completed launch retains its historical goal. An explicit project-wide
-- goal edit changes the current plan and supply rules, not that launch record.
-- Accept the historical goal only when the immutable edit ledger connects it
-- to the current project revision. A missing, foreign or broken chain fails
-- closed; audience, approval, account and period bindings remain unchanged.
create or replace function public.ve_launch_contact_target_current(
  p_project_id uuid, p_launch_target integer
) returns boolean language sql stable security definer set search_path = '' as $$
  with recursive goal_history(revision, target_contacts) as (
    select p.delivery_target_revision, p.target_contacts
      from public.ve_projects p where p.id=p_project_id
    union all
    select c.revision-1, c.previous_target
      from goal_history h
      join public.ve_contact_target_changes c
        on c.project_id=p_project_id and c.revision=h.revision
        and c.target_contacts=h.target_contacts
      where h.revision>0
  )
  select p_launch_target>0 and exists (
    select 1 from goal_history h where h.target_contacts=p_launch_target
  );
$$;
alter function public.ve_launch_contact_target_current(uuid,integer) owner to postgres;
revoke all on function public.ve_launch_contact_target_current(uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.ve_launch_contact_target_current(uuid,integer) to postgres;

create or replace function public.ve_observe_manual_campaigns(
  p_item_id uuid, p_campaigns jsonb, p_now timestamptz
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_item public.ve_launch_queue_items%rowtype;
  v_observation record;
  v_ids text[] := '{}';
  v_count integer;
begin
  if p_now is null or p_campaigns is null or jsonb_typeof(p_campaigns)<>'array'
     or jsonb_array_length(p_campaigns)=0 then raise exception 'exact campaign observations required'; end if;
  select * into v_item from public.ve_launch_queue_items where id=p_item_id for update;
  if not found then raise exception 'prepared launch not found'; end if;
  if v_item.status not in ('prepared','queued','active','uncertain') then
    raise exception 'cancelled, released or in-flight launch cannot be enrolled';
  end if;
  if not exists (
    select 1 from public.ve_templates t
    join public.ve_segmentation_audits a on a.id=(t.launch_info->>'segmentation_audit_id')::uuid
    join public.ve_projects p on p.id=v_item.project_id
    where t.id=v_item.template_id and a.template_id=t.id and a.project_id=p.id
      and a.launch_status='succeeded' and t.status='ready'
      and coalesce((t.launch_info->>'reconciliation_required')::boolean,false)=false
      and t.launch_info->>'preset_id'=v_item.preset_id
      and t.launch_info->>'instantly_account_id'=v_item.instantly_account_id
      and t.launch_info->>'portal_project_id'=p.portal_project_id::text
      and (t.launch_info->>'portal_period_id')::uuid is not distinct from p.portal_period_id
      and public.ve_launch_contact_target_current(p.id,(t.launch_info->>'target_contacts')::integer)
      and p.delivery_plan_bound_at is not null and p.delivery_plan_bound_by is not null
      and p.launch_preset_id::text=v_item.preset_id
      and p.launch_instantly_account_id=v_item.instantly_account_id
  ) then raise exception 'campaign preparation or bound delivery plan is not confirmed'; end if;
  if exists (select 1 from public.ve_contact_supply_plans s where s.item_id=p_item_id
    and not public.ve_contact_supply_approval_current(s.id)) then
    raise exception 'supply approval is stale';
  end if;
  for v_observation in select * from jsonb_to_recordset(p_campaigns)
    as x(campaign_id text,status integer,status_observed_at timestamptz)
  loop
    if v_observation.campaign_id is null or v_observation.status is null
      or v_observation.status not in (-99,-2,-1,0,1,2,3,4)
      or v_observation.status_observed_at is null
      or v_observation.status_observed_at < p_now-interval '5 minutes'
      or v_observation.status_observed_at > p_now+interval '1 minute'
      or v_observation.campaign_id=any(v_ids) then raise exception 'invalid or stale campaign observation'; end if;
    v_ids:=array_append(v_ids,v_observation.campaign_id);
    update public.ve_launch_queue_campaigns c set
      remote_status=v_observation.status, status_observed_at=v_observation.status_observed_at,
      activated_at=case when v_observation.status in (1,3,4)
        then coalesce(c.activated_at,v_observation.status_observed_at) else c.activated_at end,
      completed_at=case when v_observation.status=3
        then coalesce(c.completed_at,v_observation.status_observed_at) else c.completed_at end,
      updated_at=p_now
    where c.item_id=p_item_id and c.campaign_id=v_observation.campaign_id
      and (c.status_observed_at is null or c.status_observed_at<=v_observation.status_observed_at);
    if not found then raise exception 'campaign identity changed or observation is older than stored state'; end if;
  end loop;
  select count(*) into v_count from public.ve_launch_queue_campaigns where item_id=p_item_id;
  if v_count<>cardinality(v_ids) then raise exception 'observations must include every campaign'; end if;
  update public.ve_launch_queue_items set status='active', activation_error=null,
    ever_active_at=case when exists(select 1 from public.ve_launch_queue_campaigns
      where item_id=p_item_id and remote_status in (1,3,4)) then coalesce(ever_active_at,p_now) else ever_active_at end,
    updated_at=p_now where id=p_item_id;
  return jsonb_build_object('observed',true);
end;
$$;
alter function public.ve_observe_manual_campaigns(uuid,jsonb,timestamptz) owner to postgres;
revoke all on function public.ve_observe_manual_campaigns(uuid,jsonb,timestamptz) from public,anon,authenticated;
grant execute on function public.ve_observe_manual_campaigns(uuid,jsonb,timestamptz) to service_role,postgres;
