-- Final editor and launch share the template lock. No ENG objects are changed.
create or replace function public.ve_save_final_template(
  p_template_id uuid, p_expected_updated_at timestamptz, p_letters jsonb,
  p_personalization_plan jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_template public.ve_templates%rowtype;
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_template_id::text, 22082028));
  select * into v_template from public.ve_templates where id=p_template_id for update;
  if not found then raise exception 'Письма не найдены'; end if;
  if p_expected_updated_at is null or v_template.updated_at is distinct from p_expected_updated_at then
    raise exception 'Письма изменились. Обновите страницу перед сохранением.';
  end if;
  if v_template.launch_info is not null or v_template.supply_batch_id is not null
    or exists(select 1 from public.ve_launch_queue_items where template_id=p_template_id)
    or exists(select 1 from public.ve_segmentation_audits where template_id=p_template_id
      and (status in ('pending','running') or launch_status in ('running','uncertain','succeeded'))) then
    raise exception 'Запущенные письма и письма во время проверки нельзя менять.';
  end if;
  if jsonb_typeof(p_letters) is distinct from 'array' or jsonb_array_length(p_letters) not between 1 and 6
    or jsonb_typeof(p_personalization_plan) is distinct from 'object' then raise exception 'Некорректные письма'; end if;
  update public.ve_templates set letters=p_letters, personalization_plan=p_personalization_plan,
    updated_at=clock_timestamp() where id=p_template_id returning * into v_template;
  -- Existing supply rules/preview hashes include letters and mapping, so any
  -- previous approval now fails freshness checks without deleting its history.
  return to_jsonb(v_template);
end;
$$;

create or replace function public.ve_reserve_final_template_launch(
  p_template_id uuid, p_audit_id uuid, p_reservation_id uuid, p_preset_id text,
  p_expected_updated_at timestamptz, p_force boolean default false
) returns boolean language plpgsql security definer set search_path = '' as $$
declare v_template public.ve_templates%rowtype; v_reserved uuid; v_now timestamptz:=clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_template_id::text, 22082028));
  select * into v_template from public.ve_templates where id=p_template_id for update;
  if not found or v_template.status<>'ready' or p_expected_updated_at is null
    or v_template.updated_at is distinct from p_expected_updated_at then
    raise exception 'Письма изменились после проверки. Проверьте финальную версию заново.';
  end if;
  update public.ve_segmentation_audits set launch_status='running', launch_reservation_id=p_reservation_id,
    launch_preset_id=p_preset_id, launch_started_at=v_now, launch_heartbeat_at=v_now,
    launch_completed_at=null, launch_error=null, launch_resolution_id=null,
    launch_resolved_by=null, launch_resolved_at=null, updated_at=v_now
    where id=p_audit_id and template_id=p_template_id and status='ready'
      and (launch_status in ('idle','failed') or (p_force and launch_status='succeeded'))
    returning id into v_reserved;
  return v_reserved is not null;
end;
$$;

revoke all on function public.ve_save_final_template(uuid,timestamptz,jsonb,jsonb) from public, anon, authenticated;
revoke all on function public.ve_reserve_final_template_launch(uuid,uuid,uuid,text,timestamptz,boolean) from public, anon, authenticated;
grant execute on function public.ve_save_final_template(uuid,timestamptz,jsonb,jsonb) to service_role;
grant execute on function public.ve_reserve_final_template_launch(uuid,uuid,uuid,text,timestamptz,boolean) to service_role;
