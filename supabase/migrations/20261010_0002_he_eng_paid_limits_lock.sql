-- ENG («Движок вертикалей», self-serve кабинет): лимит проектов и лимит
-- стартов исследования за сутки — ПОД ЗАМКОМ на клиента.
--
-- ЗАЧЕМ. Гейт платных шагов (app/src/lib/hypothesisEngine/engPaidAccess.ts,
-- requireEngPaidAccess) считает лимиты ЧТЕНИЕМ: активных проектов клиента
-- (HE_US_MAX_PROJECTS_PER_CLIENT, дефолт 3) и стартов site_profile по его
-- проектам с 00:00 UTC (HE_US_MAX_RESEARCH_PER_DAY, дефолт 5). Вставка идёт
-- отдельным запросом после чтения, поэтому N одновременных запросов одного
-- клиента проходили лимит на N−1 сверх него: двойной клик «Create & start
-- research» на последнем месте давал два проекта и два платных исследования.
--
-- ЧТО ДЕЛАЕТ. Две функции, обе берут advisory-замок ТРАНЗАКЦИИ по id клиента
-- (один ключ на обе — создание проекта и повтор исследования одного клиента
-- идут по очереди друг с другом), пересчитывают лимиты и в той же транзакции
-- ставят работу. Второй из параллельных запросов ждёт замок и пересчитывает
-- уже с тем, что вставил первый.
--
--   he_eng_create_project — POST api/client/eng/projects: лимит проектов, лимит
--     исследований, затем вставка he_projects (market 'us', status
--     'researching') и джобы site_profile одной транзакцией. Прежний путь
--     ставил проект и исследование двумя запросами (insert, затем
--     enqueueHeResearchJob) — теперь сорвавшаяся постановка не оставляет
--     проект без исследования.
--   he_eng_start_research — POST api/client/eng/projects/[id]/research: у
--     проекта в 'failed' — лимит проектов (повтор делает его активным; сам
--     проект в счёт не идёт), лимит исследований; затем дедуп активной
--     research-стадии (список стадий передаёт код — HE_RESEARCH_STAGES из
--     researchJob.ts, второй копии здесь нет), вставка site_profile (23505 по
--     he_jobs_one_active_site_profile = тот же 'conflict') и перевод проекта в
--     'researching' с error = null — ровно то, что делает enqueueHeResearchJob.
--
-- Ответ — jsonb с полем outcome:
--   'created' {project, job} | 'started' {job} — строки целиком (роут сужает
--     их белыми списками кабинета);
--   'project_limit' {active} | 'research_limit' {started} — ничего не
--     вставлено, числа для английской фразы отказа;
--   'conflict' — research этого проекта уже идёт, ничего не вставлено;
--   'not_found' — проекта с таким id у этого клиента нет.
--
-- КТО ЗОВЁТ. Только клиентские ENG-роуты и только для роли 'client'
-- (сотрудник лимитов не имеет и идёт прежним путём). staff-роуты
-- исследования, RU-кабинет, RU staff-инструмент и verticalEngineV2 эти
-- функции не зовут.
--
-- КОД ДО МИГРАЦИИ. Функции нет (42883 / PGRST202) — роуты идут прежним путём:
-- предпроверка чтением, затем insert / enqueueHeResearchJob, гонка двойного
-- клика открыта (как до этой правки); строка warn раз в 10 минут.
--
-- ПРАВА. security invoker (зовёт service_role, у которого есть права на
-- he_projects / he_jobs и обход RLS), set search_path = '', имена
-- квалифицированы. anon/authenticated/public отозваны поимённо, execute —
-- service_role и postgres.
--
-- Миграция в транзакции (маркера `migrate:no-transaction` нет). Повторный
-- прогон безопасен: create or replace, повторяемые revoke/grant/comment.
-- Новых таблиц и индексов нет.

create or replace function public.he_eng_create_project(
  p_user_id uuid,
  p_name text,
  p_website_url text,
  p_max_projects integer,
  p_max_research_per_day integer,
  p_day_start timestamptz
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_active  bigint;
  v_started bigint;
  v_project public.he_projects;
  v_job     public.he_jobs;
begin
  if p_user_id is null then
    raise exception 'he_eng_create_project: user id is required';
  end if;
  if p_max_projects is null or p_max_projects < 1
     or p_max_research_per_day is null or p_max_research_per_day < 1 then
    raise exception 'he_eng_create_project: limits must be >= 1';
  end if;
  if p_day_start is null then
    raise exception 'he_eng_create_project: day start is required';
  end if;

  -- Один клиент — по очереди (тот же ключ у he_eng_start_research).
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('he_eng_paid_limits'),
    pg_catalog.hashtext(p_user_id::text)
  );

  select pg_catalog.count(*)
    into v_active
    from public.he_projects p
   where p.created_by = p_user_id
     and p.market = 'us'
     and p.status <> 'failed';
  if v_active >= p_max_projects then
    return pg_catalog.jsonb_build_object('outcome', 'project_limit', 'active', v_active);
  end if;

  select pg_catalog.count(*)
    into v_started
    from public.he_jobs j
    join public.he_projects p on p.id = j.project_id
   where p.created_by = p_user_id
     and p.market = 'us'
     and j.stage = 'site_profile'
     and j.created_at >= p_day_start;
  if v_started >= p_max_research_per_day then
    return pg_catalog.jsonb_build_object('outcome', 'research_limit', 'started', v_started);
  end if;

  insert into public.he_projects (created_by, name, website_url, status, market)
  values (p_user_id, p_name, p_website_url, 'researching', 'us')
  returning * into v_project;

  insert into public.he_jobs (project_id, stage, status, payload)
  values (v_project.id, 'site_profile', 'pending', '{}'::jsonb)
  returning * into v_job;

  return pg_catalog.jsonb_build_object(
    'outcome', 'created',
    'project', pg_catalog.to_jsonb(v_project),
    'job', pg_catalog.to_jsonb(v_job)
  );
end;
$$;

comment on function public.he_eng_create_project(uuid, text, text, integer, integer, timestamptz) is
  'ENG: создать проект клиента и поставить ему site_profile под advisory-замком клиента, если лимит проектов и лимит стартов исследования за сутки (с p_day_start) это позволяют. outcome: created | project_limit | research_limit.';

revoke all on function public.he_eng_create_project(uuid, text, text, integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.he_eng_create_project(uuid, text, text, integer, integer, timestamptz)
  to service_role, postgres;

create or replace function public.he_eng_start_research(
  p_user_id uuid,
  p_project_id uuid,
  p_research_stages text[],
  p_max_projects integer,
  p_max_research_per_day integer,
  p_day_start timestamptz
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_status  text;
  v_active  bigint;
  v_started bigint;
  v_job     public.he_jobs;
begin
  if p_user_id is null or p_project_id is null then
    raise exception 'he_eng_start_research: user id and project id are required';
  end if;
  if p_max_projects is null or p_max_projects < 1
     or p_max_research_per_day is null or p_max_research_per_day < 1 then
    raise exception 'he_eng_start_research: limits must be >= 1';
  end if;
  if p_day_start is null then
    raise exception 'he_eng_start_research: day start is required';
  end if;
  if p_research_stages is null or pg_catalog.cardinality(p_research_stages) = 0
     or not ('site_profile' = any (p_research_stages)) then
    raise exception 'he_eng_start_research: research stages must include site_profile';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('he_eng_paid_limits'),
    pg_catalog.hashtext(p_user_id::text)
  );

  -- Статус — под замком: решение «нужен ли лимит проектов» принимается по
  -- нему, а не по чтению роута до замка.
  select p.status
    into v_status
    from public.he_projects p
   where p.id = p_project_id
     and p.created_by = p_user_id;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;

  if v_status = 'failed' then
    select pg_catalog.count(*)
      into v_active
      from public.he_projects p
     where p.created_by = p_user_id
       and p.market = 'us'
       and p.status <> 'failed'
       and p.id <> p_project_id;
    if v_active >= p_max_projects then
      return pg_catalog.jsonb_build_object('outcome', 'project_limit', 'active', v_active);
    end if;
  end if;

  select pg_catalog.count(*)
    into v_started
    from public.he_jobs j
    join public.he_projects p on p.id = j.project_id
   where p.created_by = p_user_id
     and p.market = 'us'
     and j.stage = 'site_profile'
     and j.created_at >= p_day_start;
  if v_started >= p_max_research_per_day then
    return pg_catalog.jsonb_build_object('outcome', 'research_limit', 'started', v_started);
  end if;

  if exists (
    select 1
      from public.he_jobs j
     where j.project_id = p_project_id
       and j.stage = any (p_research_stages)
       and j.status in ('pending', 'running')
  ) then
    return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end if;

  begin
    insert into public.he_jobs (project_id, stage, status, payload)
    values (p_project_id, 'site_profile', 'pending', '{}'::jsonb)
    returning * into v_job;
  exception when unique_violation then
    -- he_jobs_one_active_site_profile (20260929_0002): research этого проекта
    -- поставил запрос, который замок клиента не держит (staff-роут).
    return pg_catalog.jsonb_build_object('outcome', 'conflict');
  end;

  update public.he_projects
     set status = 'researching', error = null
   where id = p_project_id;

  return pg_catalog.jsonb_build_object('outcome', 'started', 'job', pg_catalog.to_jsonb(v_job));
end;
$$;

comment on function public.he_eng_start_research(uuid, uuid, text[], integer, integer, timestamptz) is
  'ENG: поставить site_profile проекту клиента под advisory-замком клиента, если лимит проектов (только у проекта в failed) и лимит стартов исследования за сутки это позволяют и research проекта не идёт. outcome: started | project_limit | research_limit | conflict | not_found.';

revoke all on function public.he_eng_start_research(uuid, uuid, text[], integer, integer, timestamptz)
  from public, anon, authenticated;
grant execute on function public.he_eng_start_research(uuid, uuid, text[], integer, integer, timestamptz)
  to service_role, postgres;
