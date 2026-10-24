-- «Рассылка»: кампании запусков VE2 и их привязка к проекту и периоду
-- (решение владельца 24.10.2026: новые запуски вертикалей — через «Рассылку»).
--
-- Кампания запуска VE2 — источник 've2'. Одна кампания на запуск и сегмент:
-- source_job_id = резервирование запуска, source_ref = сегмент, повторный
-- проход запуска находит уже созданную, а не плодит вторую.
--
-- Привязка к проекту и периоду — как у кампаний Instantly
-- (project_period_instantly_campaigns): по ней первые письма «Рассылки» идут в
-- contacts_done и в периоды проекта. Удалить привязанную кампанию нельзя.
--
-- Сама по себе миграция ничего не меняет: кампаний 've2' и привязок ещё нет.

alter table public.sender_campaigns
  drop constraint if exists sender_campaigns_source_kind_check;
alter table public.sender_campaigns
  add constraint sender_campaigns_source_kind_check
  check (source_kind in ('manual', 'polza_ru', 'polza_en', 've2'));

alter table public.sender_campaigns
  add column if not exists source_ref text;

create unique index if not exists sender_campaigns_ve2_source_ref_key
  on public.sender_campaigns (source_job_id, source_ref)
  where source_kind = 've2';

comment on column public.sender_campaigns.source_ref is
  'Part of the source run this campaign belongs to; for ve2 — the segment (or default), unique with source_job_id.';

-- ─── Привязка к проекту и периоду ─────────────────────────────────────────
-- period_id null — проект без периодов. baseline_contacts — сколько первых
-- писем у кампании уже было на момент привязки к периоду: в период идёт только
-- прирост сверх него (кампания, созданная до открытия периода, не задваивает
-- прошлый период).
create table if not exists public.project_sender_campaigns (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects(id) on delete cascade,
  period_id         uuid references public.project_periods(id) on delete cascade,
  campaign_id       uuid not null references public.sender_campaigns(id) on delete restrict,
  baseline_contacts integer not null default 0 check (baseline_contacts >= 0),
  match_source      text not null default 've2' check (match_source in ('ve2', 'manual')),
  match_reason      text,
  created_by        uuid,
  created_at        timestamptz not null default now()
);

create unique index if not exists project_sender_campaigns_no_period_key
  on public.project_sender_campaigns (campaign_id)
  where period_id is null;
create unique index if not exists project_sender_campaigns_period_key
  on public.project_sender_campaigns (period_id, campaign_id)
  where period_id is not null;
create index if not exists project_sender_campaigns_project_idx
  on public.project_sender_campaigns (project_id);

-- Кампания принадлежит одному проекту: тому, что записан в ней самой, и ни
-- одна её привязка не ведёт в другой проект; период — того же проекта.
create or replace function public.project_sender_campaigns_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select c.project_id into v_owner from public.sender_campaigns c where c.id = new.campaign_id;
  if v_owner is distinct from new.project_id then
    raise exception 'sender campaign % belongs to project %, not %', new.campaign_id, v_owner, new.project_id;
  end if;
  if exists (
    select 1 from public.project_sender_campaigns l
     where l.campaign_id = new.campaign_id and l.project_id <> new.project_id and l.id <> new.id
  ) then
    raise exception 'sender campaign % is already linked to another project', new.campaign_id;
  end if;
  if new.period_id is not null and not exists (
    select 1 from public.project_periods pp where pp.id = new.period_id and pp.project_id = new.project_id
  ) then
    raise exception 'period % does not belong to project %', new.period_id, new.project_id;
  end if;
  return new;
end;
$$;

drop trigger if exists project_sender_campaigns_guard on public.project_sender_campaigns;
create trigger project_sender_campaigns_guard
  before insert or update on public.project_sender_campaigns
  for each row execute function public.project_sender_campaigns_guard();

revoke all on function public.project_sender_campaigns_guard() from public, anon, authenticated;

-- И с другой стороны: проект привязанной кампании не меняется (сначала
-- отвязать). Удаление проекта пропускается: его привязки уходят каскадом, а
-- project_id кампании обнуляется раньше, чем они удалены.
create or replace function public.sender_campaigns_project_link_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.project_id is distinct from old.project_id and exists (
    select 1 from public.project_sender_campaigns l
     where l.campaign_id = new.id
       and l.project_id is distinct from new.project_id
       and exists (select 1 from public.projects p where p.id = l.project_id)
  ) then
    raise exception 'sender campaign % is linked to another project; unlink it first', new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists sender_campaigns_project_link_guard on public.sender_campaigns;
create trigger sender_campaigns_project_link_guard
  before update of project_id on public.sender_campaigns
  for each row execute function public.sender_campaigns_project_link_guard();

revoke all on function public.sender_campaigns_project_link_guard() from public, anon, authenticated;

alter table public.project_sender_campaigns enable row level security;
revoke all on public.project_sender_campaigns from public, anon, authenticated;
grant all on public.project_sender_campaigns to service_role;

comment on table public.project_sender_campaigns is
  'Sender campaigns of a Portal project (and period): their first letters count into contacts_done and the period fact, like project_period_instantly_campaigns for Instantly.';

-- ─── Первые письма по кампаниям ────────────────────────────────────────────
-- «Взято в работу» — получатели, которым ушло первое письмо (то же правило,
-- что new_leads_contacted_count в sender_auto_report).
create or replace function public.sender_campaign_first_contacted(p_campaign_ids uuid[])
returns table (campaign_id uuid, first_contacted bigint)
language sql
stable
set search_path = ''
as $$
  select c.id,
         (select count(*) from public.sender_recipients r
           where r.campaign_id = c.id and r.last_step_sent >= 1)
    from public.sender_campaigns c
   where c.id = any(p_campaign_ids);
$$;

revoke all on function public.sender_campaign_first_contacted(uuid[]) from public, anon, authenticated;
grant execute on function public.sender_campaign_first_contacted(uuid[]) to service_role;

-- ─── Привязать кампании к проекту (и периоду) ──────────────────────────────
-- Идемпотентно. Кампания чужого проекта (или без проекта) — отказ (conflict) со
-- списком других проектов, а не перепривязка; остальные кампании привязываются.
-- База: 0, если период не задан или кампания создана после открытия периода
-- (created_at периода — нажатие «Новый период»), иначе — текущее число первых
-- писем, как у ручной привязки кампаний Instantly (campaignStartsInsidePeriod).
create or replace function public.reserve_project_sender_campaigns(
  p_project_id uuid,
  p_period_id uuid,
  p_campaign_ids uuid[],
  p_reason text,
  p_actor uuid
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_campaign_id uuid;
  v_owner uuid;
  v_conflicts uuid[] := '{}';
  v_found uuid[];
  v_skipped integer := 0;
  v_period_created timestamptz;
  v_campaign_created timestamptz;
  v_baseline integer;
begin
  if p_period_id is not null then
    select pp.created_at into v_period_created
      from public.project_periods pp
     where pp.id = p_period_id and pp.project_id = p_project_id;
    if not found then
      raise exception 'period % does not belong to project %', p_period_id, p_project_id;
    end if;
  end if;

  foreach v_campaign_id in array coalesce(p_campaign_ids, '{}') loop
    perform pg_advisory_xact_lock(hashtextextended('project_sender_campaigns:' || v_campaign_id::text, 0));

    select c.project_id, c.created_at into v_owner, v_campaign_created
      from public.sender_campaigns c where c.id = v_campaign_id;
    if not found then
      raise exception 'sender campaign % not found', v_campaign_id;
    end if;
    v_found := array(
      select distinct x from (
        select l.project_id as x from public.project_sender_campaigns l
         where l.campaign_id = v_campaign_id and l.project_id <> p_project_id
        union all
        select v_owner where v_owner is distinct from p_project_id
      ) o where x is not null
    );
    if v_owner is distinct from p_project_id or cardinality(v_found) > 0 then
      -- Кампания без проекта — тоже отказ; в списке её не видно.
      v_conflicts := array(select distinct x from unnest(v_conflicts || v_found) x);
      v_skipped := v_skipped + 1;
      continue;
    end if;

    if p_period_id is null or v_campaign_created >= v_period_created then
      v_baseline := 0;
    else
      select count(*)::integer into v_baseline
        from public.sender_recipients r
       where r.campaign_id = v_campaign_id and r.last_step_sent >= 1;
    end if;

    insert into public.project_sender_campaigns (project_id, period_id, campaign_id, baseline_contacts, match_source, match_reason, created_by)
    values (p_project_id, p_period_id, v_campaign_id, v_baseline, 've2', p_reason, p_actor)
    on conflict do nothing;
  end loop;

  if v_skipped > 0 then
    return jsonb_build_object('status', 'conflict', 'conflicting_project_ids', to_jsonb(v_conflicts));
  end if;
  return jsonb_build_object('status', 'ok');
end;
$$;

revoke all on function public.reserve_project_sender_campaigns(uuid, uuid, uuid[], text, uuid) from public, anon, authenticated;
grant execute on function public.reserve_project_sender_campaigns(uuid, uuid, uuid[], text, uuid) to service_role;

-- ─── Ящики пресета в «Рассылке» ────────────────────────────────────────────
-- Пресет хранит адреса ящиков (Instantly); здесь — какие из них есть в
-- «Рассылке» и в каком они состоянии. Без учёта регистра.
create or replace function public.ve_sender_pool_for_emails(p_emails text[])
returns table (id uuid, email text, status text, enabled boolean)
language sql
stable
set search_path = ''
as $$
  select m.id, m.email, m.status, m.enabled
    from public.sender_mailboxes m
   where lower(m.email) = any(select lower(btrim(e)) from unnest(p_emails) as e);
$$;

revoke all on function public.ve_sender_pool_for_emails(text[]) from public, anon, authenticated;
grant execute on function public.ve_sender_pool_for_emails(text[]) to service_role;
