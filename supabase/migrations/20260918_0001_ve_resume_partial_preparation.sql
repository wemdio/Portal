-- A completed letter template does not mean that the preview reached its goal.
-- Only an explicit Continue action for this hypothesis may resume a partial base.
create or replace function public.ve_request_outreach_hypothesis_preparation(
  p_project_id uuid, p_revision bigint, p_hypothesis_id uuid
) returns void language plpgsql security definer set search_path='' as $$
declare v_setup public.ve_outreach_setups;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_project_id::text,22082029));
  select * into v_setup from public.ve_outreach_setups where project_id=p_project_id for update;
  if not found or v_setup.revision is distinct from p_revision then
    raise exception 'Выбор изменился. Обновите страницу';
  end if;
  if p_hypothesis_id is null or not (p_hypothesis_id=any(v_setup.selected_hypothesis_ids))
    or not exists(select 1 from public.ve_hypotheses h where h.id=p_hypothesis_id
      and h.project_id=p_project_id and h.vertical_id is not null and h.status is distinct from 'rejected') then
    raise exception 'Выберите доступную гипотезу этого проекта';
  end if;
  if exists(select 1 from public.ve_outreach_preparations p where p.project_id=p_project_id
    and p.hypothesis_id=p_hypothesis_id and p.language<>v_setup.language
    and (p.base_id is not null or p.template_id is not null or p.status<>'pending' or p.locked_until>clock_timestamp())) then
    raise exception 'Язык сохранённой подготовки не совпадает с выбором. Верните прежний язык.';
  end if;
  insert into public.ve_outreach_preparations as prep(project_id,hypothesis_id,language)
    values(p_project_id,p_hypothesis_id,v_setup.language)
    on conflict(project_id,hypothesis_id) do update set
      status=case when prep.status='error' or (prep.status='ready'
        and (prep.base_id is null or prep.template_id is null or exists(
          select 1 from public.ve_bases b
          where b.id=prep.base_id and b.project_id=prep.project_id and b.hypothesis_id=prep.hypothesis_id
            and b.source='auto' and b.status='analyzed'
            and b.collect_info->>'collection_mode'='preview'
            and b.collect_info->'target_progress'->>'status' in ('limited','exhausted','error')
            and case when jsonb_typeof(b.collect_info->'target_progress'->'ready_rows')='number'
              and jsonb_typeof(b.collect_info->'target_progress'->'ready_target')='number'
              then (b.collect_info->'target_progress'->>'ready_rows')::numeric
                < (b.collect_info->'target_progress'->>'ready_target')::numeric
              else false end
            and not exists(select 1 from public.ve_templates t where t.base_id=b.id and t.launch_info is not null)
        ))) then 'pending' else prep.status end,
      language=excluded.language, last_error=null, cancelled_at=null, updated_at=now();
end $$;
revoke all on function public.ve_request_outreach_hypothesis_preparation(uuid,bigint,uuid) from public,anon,authenticated;
grant execute on function public.ve_request_outreach_hypothesis_preparation(uuid,bigint,uuid) to service_role;
