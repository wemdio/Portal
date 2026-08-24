-- Atomically advances one Portal project period.
--
-- Campaign links are reserved in the separate Instantly database first. The
-- route then calls this idempotent function with pre-generated period IDs. A
-- lost PostgREST response can therefore be reconciled by reading
-- p_new_period_id without deleting committed rows or replaying history
-- triggers during compensation.

create or replace function public.transition_project_period(
  p_project_id uuid,
  p_expected_period_count integer,
  p_expected_active_period_id uuid,
  p_first_period_id uuid,
  p_new_period_id uuid,
  p_period_start date,
  p_has_contacts_obligation boolean,
  p_contacts_obligation text,
  p_has_kpi_plan boolean,
  p_kpi_plan text,
  p_has_deadline boolean,
  p_deadline date,
  p_has_budget boolean,
  p_budget text,
  p_has_margin boolean,
  p_margin text,
  p_has_payment_date boolean,
  p_payment_date date
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_project public.projects%rowtype;
  v_existing public.project_periods%rowtype;
  v_active public.project_periods%rowtype;
  v_new public.project_periods%rowtype;
  v_period_count integer;
  v_prior_start date;
  v_legacy_launch_date date;
  v_legacy_payment_date date;
  v_legacy_deadline date;
  v_contacts_obligation text;
  v_kpi_plan text;
  v_deadline date;
  v_budget text;
  v_margin text;
  v_payment_date date;
begin
  if p_project_id is null
    or p_new_period_id is null
    or p_period_start is null
    or p_expected_period_count is null
    or p_expected_period_count < 0
  then
    raise exception using errcode = '22023', message = 'invalid_project_period_transition';
  end if;

  if p_first_period_id is not null and p_first_period_id = p_new_period_id then
    raise exception using errcode = '22023', message = 'period_ids_must_be_distinct';
  end if;

  -- Every cooperating transition for this project is serialized here. The
  -- project row also supplies the commercial/KPI snapshot used below.
  select p.*
    into v_project
    from public.projects p
   where p.id = p_project_id
   for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'project_not_found';
  end if;

  -- Idempotency must precede the old-state fence: after the first call commits,
  -- the expected count/active ID are intentionally stale on a retry.
  select pp.*
    into v_existing
    from public.project_periods pp
   where pp.id = p_new_period_id;

  if found then
    if v_existing.project_id <> p_project_id then
      raise exception using
        errcode = '23505',
        message = 'new_period_id_belongs_to_another_project';
    end if;
    return jsonb_build_object(
      'period', to_jsonb(v_existing),
      'first_period_id', null
    );
  end if;

  select count(*)::integer
    into v_period_count
    from public.project_periods pp
   where pp.project_id = p_project_id;

  select pp.*
    into v_active
    from public.project_periods pp
   where pp.project_id = p_project_id
     and pp.status = 'active'
   order by pp.period_start desc, pp.created_at desc
   limit 1
   for update;

  if v_period_count <> p_expected_period_count
    or v_active.id is distinct from p_expected_active_period_id
  then
    raise exception using errcode = '40001', message = 'project_period_state_changed';
  end if;

  -- These project columns are legacy text in production, while period columns
  -- are dates. The shared parser accepts supported legacy formats and returns
  -- null (rather than aborting the transition) for malformed values.
  v_legacy_launch_date := public.team_statistics_safe_date(v_project.launch_date);
  v_legacy_payment_date := public.team_statistics_safe_date(v_project.payment_date);
  v_legacy_deadline := public.team_statistics_safe_date(v_project.deadline);

  if v_period_count = 0 then
    v_prior_start := coalesce(
      v_legacy_launch_date,
      v_legacy_payment_date,
      (v_project.created_at at time zone 'UTC')::date
    );
  else
    v_prior_start := v_active.period_start;
  end if;

  if v_prior_start is not null and p_period_start <= v_prior_start then
    raise exception using errcode = '22023', message = 'period_start_must_follow_previous';
  end if;

  if v_period_count = 0 then
    if p_first_period_id is null then
      raise exception using errcode = '22023', message = 'first_period_id_required';
    end if;

    insert into public.project_periods (
      id,
      project_id,
      name,
      status,
      period_start,
      period_end,
      contacts_obligation,
      contacts_done,
      kpi_plan,
      kpi_fact,
      deadline,
      budget,
      margin,
      payment_date
    ) values (
      p_first_period_id,
      p_project_id,
      'Period 1',
      'closed',
      coalesce(v_prior_start, p_period_start),
      p_period_start - 1,
      v_project.contacts_obligation,
      v_project.contacts_done,
      v_project.kpi_plan,
      v_project.kpi_fact,
      v_legacy_deadline,
      v_project.budget,
      v_project.margin,
      v_legacy_payment_date
    );
  elsif v_active.id is not null then
    update public.project_periods
       set status = 'closed',
           period_end = p_period_start - 1,
           updated_at = clock_timestamp()
     where id = v_active.id;
  end if;

  v_contacts_obligation := case
    when coalesce(p_has_contacts_obligation, false) then nullif(btrim(p_contacts_obligation), '')
    else v_project.contacts_obligation
  end;
  v_kpi_plan := case
    when coalesce(p_has_kpi_plan, false) then nullif(btrim(p_kpi_plan), '')
    else v_project.kpi_plan
  end;
  v_deadline := case
    when coalesce(p_has_deadline, false) then p_deadline
    else v_legacy_deadline
  end;
  v_budget := case
    when coalesce(p_has_budget, false) then nullif(btrim(p_budget), '')
    else v_project.budget
  end;
  v_margin := case
    when coalesce(p_has_margin, false) then nullif(btrim(p_margin), '')
    else v_project.margin
  end;
  v_payment_date := case
    when coalesce(p_has_payment_date, false) then p_payment_date
    else v_legacy_payment_date
  end;

  insert into public.project_periods (
    id,
    project_id,
    name,
    status,
    period_start,
    period_end,
    contacts_obligation,
    contacts_done,
    kpi_plan,
    kpi_fact,
    deadline,
    budget,
    margin,
    payment_date
  ) values (
    p_new_period_id,
    p_project_id,
    format('Period %s', v_period_count + case when v_period_count = 0 then 2 else 1 end),
    'active',
    p_period_start,
    null,
    v_contacts_obligation,
    '0',
    v_kpi_plan,
    '0',
    v_deadline,
    v_budget,
    v_margin,
    v_payment_date
  )
  returning * into v_new;

  update public.projects
     set contacts_obligation = v_contacts_obligation,
         contacts_done = '0',
         contacts_done_synced_at = null,
         kpi_plan = v_kpi_plan,
         kpi_fact = '0',
         deadline = v_deadline,
         budget = v_budget,
         margin = v_margin,
         payment_date = v_payment_date,
         updated_at = clock_timestamp()
   where id = p_project_id;

  return jsonb_build_object(
    'period', to_jsonb(v_new),
    'first_period_id', case when v_period_count = 0 then p_first_period_id else null end
  );
end;
$$;

revoke all on function public.transition_project_period(
  uuid, integer, uuid, uuid, uuid, date,
  boolean, text, boolean, text, boolean, date,
  boolean, text, boolean, text, boolean, date
) from public, anon, authenticated;

grant execute on function public.transition_project_period(
  uuid, integer, uuid, uuid, uuid, date,
  boolean, text, boolean, text, boolean, date,
  boolean, text, boolean, text, boolean, date
) to service_role;
