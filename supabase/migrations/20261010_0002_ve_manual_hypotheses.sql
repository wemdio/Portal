-- Manual VE2 audiences are append-only; no research, selection or campaign reset.
alter table public.ve_hypotheses
  add column if not exists origin text not null default 'generated';
alter table public.ve_hypotheses drop constraint if exists ve_hypotheses_origin_check;
alter table public.ve_hypotheses add constraint ve_hypotheses_origin_check
  check (origin in ('generated', 'manual'));

create table if not exists public.ve_manual_hypothesis_requests (
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  request_id uuid not null,
  title text not null,
  description text not null,
  hypothesis_id uuid references public.ve_hypotheses(id) on delete set null,
  vertical_id uuid references public.ve_verticals(id) on delete set null,
  created_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (project_id, request_id)
);
alter table public.ve_manual_hypothesis_requests enable row level security;
revoke all on table public.ve_manual_hypothesis_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.ve_manual_hypothesis_requests to service_role;

-- Existing research enqueue writes ve_jobs before updating the project. Lock
-- the project first in that transaction, including retry transitions, so a
-- concurrent append/brief change cannot overlook an uncommitted research job.
create or replace function public.ve_lock_research_project()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.stage in ('site_profile','competitors','brand_cloud','hypotheses','evidence','clustering','broad_hypotheses')
    and new.status in ('pending','running') then
    perform 1 from public.ve_projects where id = new.project_id for update;
  end if;
  return new;
end;
$$;
drop trigger if exists ve_lock_research_project on public.ve_jobs;
create trigger ve_lock_research_project before insert or update of status, project_id, stage
  on public.ve_jobs for each row execute function public.ve_lock_research_project();
revoke all on function public.ve_lock_research_project() from public, anon, authenticated;
grant execute on function public.ve_lock_research_project() to service_role;

create or replace function public.ve_add_manual_hypothesis(
  p_project_id uuid, p_request_id uuid, p_title text, p_description text, p_created_by uuid
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_project public.ve_projects%rowtype;
  v_request public.ve_manual_hypothesis_requests%rowtype;
  v_hypothesis public.ve_hypotheses%rowtype;
  v_vertical public.ve_verticals%rowtype;
  v_title text;
  v_description text;
  v_key text;
  v_rank integer;
begin
  if p_project_id is null or p_request_id is null or p_created_by is null
    or p_title is null or char_length(p_title) > 160
    or p_description is null or char_length(p_description) > 2000 then
    raise exception 've_manual_invalid_input';
  end if;
  v_title := btrim(regexp_replace(p_title, '[[:space:]]+', ' ', 'g'));
  v_description := btrim(replace(replace(p_description, E'\r\n', E'\n'), E'\r', E'\n'));
  v_key := public.ve_broad_title_key(v_title);
  if coalesce(v_key, '') = '' or v_title ~ '[[:cntrl:]]'
    or coalesce(public.ve_broad_title_key(v_description), '') = ''
    or replace(replace(v_description, E'\n', ''), E'\t', '') ~ '[[:cntrl:]]' then
    raise exception 've_manual_invalid_input';
  end if;

  select * into v_project from public.ve_projects where id = p_project_id for update;
  if not found then raise exception 've_manual_project_not_found'; end if;
  -- Read the committed receipt before readiness checks: a lost response may be
  -- retried after another operation changed the project's state.
  select * into v_request from public.ve_manual_hypothesis_requests
    where project_id = p_project_id and request_id = p_request_id;
  if found then
    if v_request.title <> v_title or v_request.description <> v_description then
      raise exception 've_manual_request_conflict';
    end if;
    select * into v_hypothesis from public.ve_hypotheses
      where id = v_request.hypothesis_id and project_id = p_project_id;
    if not found then raise exception 've_manual_result_removed'; end if;
    select * into v_vertical from public.ve_verticals
      where id = v_request.vertical_id and project_id = p_project_id;
    if not found or v_hypothesis.vertical_id is distinct from v_vertical.id then
      raise exception 've_manual_result_removed';
    end if;
    return jsonb_build_object('ok', true, 'existing', true,
      'hypothesis', to_jsonb(v_hypothesis), 'vertical', to_jsonb(v_vertical));
  end if;

  if v_project.status = 'researching' or exists (
    select 1 from public.ve_jobs where project_id = p_project_id
      and stage in ('site_profile','competitors','brand_cloud','hypotheses','evidence','clustering','broad_hypotheses')
      and status in ('pending','running')
  ) then raise exception 've_manual_research_busy'; end if;
  if v_project.status <> 'researched' or not exists (
    select 1 from public.ve_verticals where project_id = p_project_id
  ) then raise exception 've_manual_project_not_ready'; end if;

  if exists (
    select 1 from public.ve_hypotheses h where h.project_id = p_project_id
      and public.ve_broad_title_key(h.title) = v_key
    union all
    select 1 from public.ve_verticals v where v.project_id = p_project_id
      and (public.ve_broad_title_key(v.name) = v_key or exists (
        select 1 from jsonb_array_elements_text(
          case when jsonb_typeof(v.synonyms) = 'array' then v.synonyms else '[]'::jsonb end
        ) s where public.ve_broad_title_key(s.value) = v_key
      ))
  ) then raise exception 've_manual_duplicate_title'; end if;

  select greatest(coalesce(max(rank), 0), count(*)) + 1 into v_rank
    from public.ve_verticals where project_id = p_project_id;
  insert into public.ve_verticals(project_id, name, summary, synonyms, potential_pct, rank)
    values (p_project_id, v_title, v_description, jsonb_build_array(v_title), 0, v_rank)
    returning * into v_vertical;
  insert into public.ve_hypotheses(
    project_id, vertical_id, tier, title, description, fit_rationale,
    evidence, seasonality, potential_pct, status, broad, origin
  ) values (
    p_project_id, v_vertical.id, 1, v_title, v_description, 'Аудитория задана специалистом.',
    '[]'::jsonb, null, 0, 'proposed', false, 'manual'
  ) returning * into v_hypothesis;
  insert into public.ve_manual_hypothesis_requests(
    project_id, request_id, title, description, hypothesis_id, vertical_id, created_by
  ) values (p_project_id, p_request_id, v_title, v_description, v_hypothesis.id, v_vertical.id, p_created_by);
  return jsonb_build_object('ok', true, 'existing', false,
    'hypothesis', to_jsonb(v_hypothesis), 'vertical', to_jsonb(v_vertical));
end;
$$;
revoke all on function public.ve_add_manual_hypothesis(uuid, uuid, text, text, uuid) from public, anon, authenticated;
grant execute on function public.ve_add_manual_hypothesis(uuid, uuid, text, text, uuid) to service_role;

-- Atomic narrow brief patch: concurrent site extraction / specialist changes
-- retain each other's keys. Never accept arbitrary project-column updates.
create or replace function public.ve_patch_project_brief(
  p_project_id uuid, p_patch jsonb, p_remove_keys text[] default '{}',
  p_require_idle_research boolean default false, p_expected_priority_niches jsonb default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_project public.ve_projects%rowtype;
  v_brief jsonb;
  v_key text;
  v_niches jsonb;
  v_expected jsonb;
  v_priority_changed boolean := false;
  v_allowed constant text[] := array[
    'offer_override','style_override','signature_override','business_override',
    'priority_niches','priority_niche_results','client_brief','website_url','site_profile','site_thin',
    'site_text_chars','site_fetch_error','captured_at'
  ];
begin
  if p_project_id is null or jsonb_typeof(p_patch) is distinct from 'object'
    or p_remove_keys is null or p_require_idle_research is null then
    raise exception 've_brief_invalid_patch';
  end if;
  for v_key in select jsonb_object_keys(p_patch) loop
    if not v_key = any(v_allowed) or v_key = any(p_remove_keys) then
      raise exception 've_brief_invalid_patch';
    end if;
    if v_key in ('offer_override','style_override','signature_override','business_override','website_url','captured_at')
      and jsonb_typeof(p_patch->v_key) <> 'string' then raise exception 've_brief_invalid_patch'; end if;
  end loop;
  foreach v_key in array p_remove_keys loop
    if v_key is null or not v_key = any(v_allowed) then raise exception 've_brief_invalid_patch'; end if;
  end loop;
  if p_patch ? 'client_brief' and jsonb_typeof(p_patch->'client_brief') <> 'object'
    or p_patch ? 'site_profile' and jsonb_typeof(p_patch->'site_profile') <> 'object'
    or p_patch ? 'site_thin' and jsonb_typeof(p_patch->'site_thin') <> 'boolean'
    or p_patch ? 'site_text_chars' and (jsonb_typeof(p_patch->'site_text_chars') <> 'number'
      or (p_patch->>'site_text_chars') !~ '^[0-9]+$')
    or p_patch ? 'site_fetch_error' and p_patch->'site_fetch_error' <> 'null'::jsonb
      and p_patch->>'site_fetch_error' not in ('timeout','unavailable') then
    raise exception 've_brief_invalid_patch';
  end if;
  if p_patch ? 'priority_niches' then
    if jsonb_typeof(p_patch->'priority_niches') <> 'array'
      or jsonb_array_length(p_patch->'priority_niches') > 8 then raise exception 've_brief_invalid_patch'; end if;
    if exists (select 1 from jsonb_array_elements(p_patch->'priority_niches') n
      where jsonb_typeof(n) <> 'string' or char_length(n #>> '{}') not between 1 and 120
        or public.ve_broad_title_key(n #>> '{}') = ''
        or (n #>> '{}') <> btrim(regexp_replace(n #>> '{}', '[[:space:]]+', ' ', 'g'))
    ) then raise exception 've_brief_invalid_patch'; end if;
    if (select count(*) from jsonb_array_elements_text(p_patch->'priority_niches'))
      <> (select count(distinct lower(n)) from jsonb_array_elements_text(p_patch->'priority_niches') n) then
      raise exception 've_brief_invalid_patch';
    end if;
  end if;
  if p_patch ? 'priority_niche_results' then
    if p_patch ? 'priority_niches' or 'priority_niches' = any(p_remove_keys)
      or p_expected_priority_niches is null
      or jsonb_typeof(p_patch->'priority_niche_results') <> 'object'
      or jsonb_typeof(p_patch#>'{priority_niche_results,results}') is distinct from 'array'
      or p_patch#>'{priority_niche_results,niches}' is distinct from p_expected_priority_niches then
      raise exception 've_brief_invalid_patch';
    end if;
  end if;

  select * into v_project from public.ve_projects where id = p_project_id for update;
  if not found then raise exception 've_project_not_found'; end if;
  v_brief := coalesce(v_project.brief, '{}'::jsonb);
  if p_require_idle_research or p_patch ? 'priority_niches' or 'priority_niches' = any(p_remove_keys) then
    if v_project.status = 'researching' or exists (
      select 1 from public.ve_jobs where project_id = p_project_id
        and stage in ('site_profile','competitors','brand_cloud','hypotheses','evidence','clustering','broad_hypotheses')
        and status in ('pending','running')
    ) then raise exception 've_brief_research_busy'; end if;
  end if;
  v_expected := coalesce(v_brief->'priority_niches', '[]'::jsonb);
  if p_patch ? 'priority_niche_results' and v_expected is distinct from p_expected_priority_niches then
    raise exception 've_brief_priority_snapshot_changed';
  end if;
  if p_patch ? 'priority_niches' or 'priority_niches' = any(p_remove_keys) then
    v_niches := coalesce(p_patch->'priority_niches', '[]'::jsonb);
    v_priority_changed := v_niches is distinct from v_expected;
  end if;
  v_brief := (v_brief - p_remove_keys) || p_patch;
  if v_priority_changed then v_brief := v_brief - 'priority_niche_results'; end if;
  update public.ve_projects set brief = v_brief, updated_at = now()
    where id = p_project_id returning * into v_project;
  return to_jsonb(v_project);
end;
$$;
revoke all on function public.ve_patch_project_brief(uuid, jsonb, text[], boolean, jsonb) from public, anon, authenticated;
grant execute on function public.ve_patch_project_brief(uuid, jsonb, text[], boolean, jsonb) to service_role;
