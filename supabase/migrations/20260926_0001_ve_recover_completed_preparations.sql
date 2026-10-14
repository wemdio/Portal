-- A coordinator failure can outlive the successful collection/analysis it
-- observed. Recover that transition, not a failed paid stage or a cancelled run.
create or replace function public.ve_completed_preparation_recoverable(
  p_project_id uuid, p_hypothesis_id uuid
) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from public.ve_outreach_preparations p
      join public.ve_outreach_setups s on s.project_id = p.project_id
      join public.ve_hypotheses h on h.id = p.hypothesis_id and h.project_id = p.project_id
      join public.ve_bases b on b.id = p.base_id and b.project_id = p.project_id
        and b.hypothesis_id = p.hypothesis_id
      cross join lateral (
        select j.status, j.created_at, j.finished_at
          from public.ve_jobs j
         where j.project_id = p.project_id and j.stage = 'base_analyze'
           and j.payload->>'base_id' = b.id::text
         order by j.created_at desc, j.id desc limit 1
      ) analysis_job
     where p.project_id = p_project_id and p.hypothesis_id = p_hypothesis_id
       and p.status = 'error' and p.cancelled_at is null
       and (p.locked_until is null or p.locked_until < now())
       and p.hypothesis_id = any(s.selected_hypothesis_ids) and p.language = s.language
       and h.status <> 'rejected' and h.vertical_id is not null
       and b.source = 'auto' and b.status = 'analyzed' and b.error is null and b.row_count > 0
       and jsonb_typeof(b.analysis) = 'object'
       and b.collect_info->>'collection_mode' = 'preview'
       and b.collect_info->'target_progress'->>'status' in ('target_reached', 'limited', 'exhausted')
       and analysis_job.status = 'done' and analysis_job.finished_at is not null
       and (
         p.last_error in (
           'Сбор базы остановлен. Нажмите «Продолжить подготовку»',
           'Разбор базы остановлен. Нажмите «Продолжить подготовку»',
           'Задача сбора завершилась, но база не готова. Нажмите «Продолжить подготовку»',
           'База ещё не готова к выбранной стадии'
         )
         -- A successful analysis AFTER the read failure proves the old
         -- coordinator error is obsolete. Do not retry a newer failure.
         or (analysis_job.finished_at > p.updated_at and p.last_error ~*
           '^(An invalid response was received from the upstream server|(?:TypeError: )?fetch failed|network error|(?:statement |request )?timeout)\.?$')
       )
       and not (s.approved_bases ? b.id::text)
       and not public.ve_base_audience_frozen(b.id)
       and not exists (select 1 from public.ve_templates t
         where t.base_id = b.id and t.launch_info is not null)
       and not exists (select 1 from public.ve_jobs j
         where j.project_id = p.project_id and j.payload->>'base_id' = b.id::text
           and j.status in ('pending', 'running'))
       and (select j.status from public.ve_jobs j
         where j.project_id = p.project_id and j.payload->>'base_id' = b.id::text
           and j.stage = 'base_collect'
         order by j.created_at desc, j.id desc limit 1) = 'done'
       and not exists (select 1 from public.ve_jobs j
         where j.project_id = p.project_id and j.payload->>'base_id' = b.id::text
           and j.stage = 'template' and j.status in ('failed', 'cancelled')
           and j.created_at >= analysis_job.created_at)
  );
$$;

create or replace function public.ve_claim_outreach_preparation()
returns setof public.ve_outreach_preparations
language plpgsql security definer set search_path = '' as $$
declare
  candidate record;
  v_row public.ve_outreach_preparations;
begin
  for candidate in
    select p.project_id, p.hypothesis_id
      from public.ve_outreach_preparations p
      join public.ve_outreach_setups s using(project_id)
     where p.hypothesis_id = any(s.selected_hypothesis_ids) and p.language = s.language
       and p.cancelled_at is null
       and (p.locked_until is null or p.locked_until < now())
       and (p.status in ('pending', 'collecting', 'generating')
         or public.ve_completed_preparation_recoverable(p.project_id, p.hypothesis_id))
     order by p.updated_at, p.project_id, p.hypothesis_id
     limit 32
  loop
    -- Same lock order as explicit preparation/cancellation. Never wait behind
    -- an operator transaction while holding the preparation row lock.
    if not pg_try_advisory_xact_lock(hashtextextended(candidate.project_id::text, 22082029)) then
      continue;
    end if;
    -- Recheck after the project lock: selection, cancellation or approval may
    -- have changed since the candidate scan, including in another worker.
    select p.* into v_row
      from public.ve_outreach_preparations p
      join public.ve_outreach_setups s using(project_id)
     where p.project_id = candidate.project_id and p.hypothesis_id = candidate.hypothesis_id
       and p.hypothesis_id = any(s.selected_hypothesis_ids) and p.language = s.language
       and p.cancelled_at is null
       and (p.locked_until is null or p.locked_until < now())
       and (p.status in ('pending', 'collecting', 'generating')
         or public.ve_completed_preparation_recoverable(p.project_id, p.hypothesis_id))
     for update of p skip locked;
    if not found then continue; end if;
    update public.ve_outreach_preparations
       -- NOT pending: pending explicitly grants another collection attempt
       -- below 500. Here only the completed analysis may advance to letters.
       set status = case when v_row.status = 'error' then 'collecting' else v_row.status end,
           last_error = case when v_row.status = 'error' then null else v_row.last_error end,
           locked_until = clock_timestamp() + interval '2 minutes',
           claim_token = gen_random_uuid(), updated_at = clock_timestamp()
     where project_id = v_row.project_id and hypothesis_id = v_row.hypothesis_id
     returning * into v_row;
    return next v_row;
    return;
  end loop;
end;
$$;

revoke all on function public.ve_completed_preparation_recoverable(uuid,uuid),
  public.ve_claim_outreach_preparation() from public, anon, authenticated;
grant execute on function public.ve_completed_preparation_recoverable(uuid,uuid),
  public.ve_claim_outreach_preparation() to service_role;
