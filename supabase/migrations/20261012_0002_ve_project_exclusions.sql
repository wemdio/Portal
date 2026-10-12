-- Project-scoped exclusions. No provider calls, collection restarts or legacy HE changes.
create table public.ve_project_exclusions (
  project_id uuid primary key references public.ve_projects(id) on delete cascade,
  revision integer not null check (revision > 0),
  inns text[] not null default '{}',
  domains text[] not null default '{}',
  updated_by uuid not null,
  updated_at timestamptz not null default clock_timestamp(),
  check (cardinality(inns) + cardinality(domains) <= 10000)
);
create table public.ve_project_exclusion_changes (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.ve_projects(id) on delete cascade,
  revision integer not null,
  actor_id uuid not null,
  inn_count integer not null,
  domain_count integer not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.ve_project_exclusions enable row level security;
alter table public.ve_project_exclusion_changes enable row level security;
revoke all on public.ve_project_exclusions, public.ve_project_exclusion_changes from public, anon, authenticated, service_role;
grant select on public.ve_project_exclusions to service_role;
grant select on public.ve_project_exclusion_changes to service_role;

create function public.ve_save_project_exclusions(
  p_project_id uuid, p_revision integer, p_inns text[], p_domains text[], p_actor_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_previous integer;
  v_result public.ve_project_exclusions%rowtype;
begin
  -- Also serializes two concurrent first saves, before a settings row exists.
  perform 1 from public.ve_projects where id = p_project_id for update;
  if not found then return jsonb_build_object('error', 'not_found'); end if;
  if p_actor_id is null or p_revision is null or p_revision < 0
    or p_inns is null or p_domains is null
    or cardinality(p_inns) + cardinality(p_domains) > 10000
    or exists (select 1 from unnest(p_inns) x where x is null or x !~ '^([0-9]{10}|[0-9]{12})$')
    or exists (select 1 from unnest(p_domains) x where x is null or length(x) > 253
      or x !~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z0-9-]+$')
    then return jsonb_build_object('error', 'invalid'); end if;
  select revision into v_previous from public.ve_project_exclusions where project_id = p_project_id for update;
  if coalesce(v_previous, 0) <> p_revision then return jsonb_build_object('error', 'conflict'); end if;
  insert into public.ve_project_exclusions(project_id,revision,inns,domains,updated_by)
    values(p_project_id,p_revision+1,
      array(select distinct x from unnest(p_inns) x order by x),
      array(select distinct x from unnest(p_domains) x order by x),p_actor_id)
    on conflict(project_id) do update set revision=excluded.revision,inns=excluded.inns,domains=excluded.domains,
      updated_by=excluded.updated_by,updated_at=clock_timestamp()
    returning * into v_result;
  insert into public.ve_project_exclusion_changes(project_id,revision,actor_id,inn_count,domain_count)
    values(p_project_id,v_result.revision,p_actor_id,cardinality(v_result.inns),cardinality(v_result.domains));
  return jsonb_build_object('revision',v_result.revision,'inns',v_result.inns,'domains',v_result.domains,'updated_at',v_result.updated_at);
end;
$$;
revoke all on function public.ve_save_project_exclusions(uuid,integer,text[],text[],uuid) from public, anon, authenticated;
grant execute on function public.ve_save_project_exclusions(uuid,integer,text[],text[],uuid) to service_role;


-- Excluded retained rows are private worker state, never project polling payloads.
create or replace function public.ve_base_public_info(b public.ve_bases)
returns jsonb language plpgsql stable parallel safe set search_path = '' as $$
declare
  -- ПОРЯДОК ЗДЕСЬ — ЭТО ПРОИЗВОДИТЕЛЬНОСТЬ, А НЕ СТИЛЬ. Сначала ОДНОЙ операцией
  -- снимаем тяжёлые ветки: дальше все обращения идут по документу в сотни раз
  -- меньше. Замер на проекте «Аврора» (17 баз, 586 МБ): такой порядок — 1,7 с,
  -- белый список сразу по полному документу — 12,7 с, а двадцать два отдельных
  -- обращения по ключам — 31 с, потому что переменная детоастится на каждое.
  v jsonb := b.collect_info - array['project_exclusion_reserve', 'relevance_reserve', 'target_checkpoint',
    'relevance_checkpoint', 'source_contact_recovery', 'preview_pipeline',
    'company_name_checkpoint', 'company_name_queue'];
  info jsonb;
  adaptive jsonb;
  completed jsonb;
  batches integer;
begin
  if b.collect_info is null then return null; end if;

  -- Белый список публичных ключей. Чего здесь нет — до клиента не доедет,
  -- поэтому новый публичный ключ добавляется и сюда тоже.
  info := coalesce((
    select jsonb_object_agg(e.key, e.value)
      from jsonb_each(v) e
     where e.value <> 'null'::jsonb
       and e.key in ('collection_mode', 'ready_target', 'supply_hold', 'waiting_for_base_id',
                     'limit', 'target_progress', 'construct', 'plan', 'estimate', 'stats',
                     'project_exclusions', 'relevance_summary', 'company_contact_cap', 'company_name_cleanup',
                     'company_name_recovery', 'source_contact_discovery',
                     'relevance_review_requested', 'validation_retry', 'hypothesis_id',
                     'hypothesis_ids', 'hypotheses', 'plan_repair', 'slice_probe')), '{}'::jsonb);

  -- search_policy: наружу только фаза. deferred_rows — рабочие строки воркера.
  if v->'search_policy' ? 'version' then
    info := info || jsonb_build_object('search_policy', jsonb_strip_nulls(jsonb_build_object(
      'version', v->'search_policy'->'version',
      'phase', v->'search_policy'->'phase')));
  end if;

  -- adaptive_collection: сводка. pending.ready_before — хэши уже готовых
  -- контактов, их нельзя отдавать наружу, поэтому берём только признак.
  adaptive := v->'adaptive_collection';
  if adaptive ? 'version' then
    completed := case when jsonb_typeof(adaptive->'completed') = 'array'
                      then adaptive->'completed' else '[]'::jsonb end;
    batches := jsonb_array_length(completed);
    info := info || jsonb_build_object('adaptive_collection', jsonb_strip_nulls(jsonb_build_object(
      'version', adaptive->'version',
      'switches', adaptive->'switches',
      'note', adaptive->'note',
      'replan_error', adaptive->'replan_error',
      'checking_batch', to_jsonb((adaptive->'pending'->>'id') is not null),
      'completed_batches', to_jsonb(batches),
      'last_batch', case when batches > 0 then completed->(batches - 1) end)));
  end if;

  -- saved_email_recovery: наружу только флаг ожидания, не карта проверенных.
  if (v->'saved_email_recovery'->>'attempt_id') is not null then
    info := info || jsonb_build_object('saved_email_review_pending', to_jsonb(
      (v->'saved_email_recovery'->'batch'->>'id') is not null
      and (v->'saved_email_recovery'->>'error') is null));
  end if;

  -- tasks: три поля для прогресс-карты. harvest внутри задачи — до 50 тысяч
  -- строк, именно он и делал документ неподъёмным.
  if jsonb_typeof(v->'tasks') = 'array' and jsonb_array_length(v->'tasks') > 0 then
    info := info || jsonb_build_object('tasks', (
      select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'source', t->'source', 'status', t->'status', 'rows', t->'rows')) order by ord), '[]'::jsonb)
        from jsonb_array_elements(v->'tasks') with ordinality as x(t, ord)));
  end if;

  return case when info = '{}'::jsonb then null else info end;
end $$;
