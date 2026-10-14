-- ENG («Движок вертикалей», self-serve кабинет): ПУЛ ящиков отправки.
--
-- РЕШЕНИЕ ВЛАДЕЛЬЦА 10–11.10.2026. Клиент ENG ящики не подключает: письма уходят
-- из НАШИХ заранее прогретых безымянных ящиков. Каждый us-проект получает из
-- пула HE_US_POOL_MAILBOXES_PER_PROJECT ящиков (по умолчанию 3, читает код —
-- app/src/lib/hypothesisEngine/sendingPool.ts), и эти ящики принадлежат только
-- ему. Дальше код (engSendingPreset.ts) кладёт их в ЕДИНСТВЕННЫЙ пресет отправки
-- клиента (client_campaign_presets в БД рассыльщика), а ядро запуска создаёт
-- кампании с ними — в воркспейсе рассыльщика, где ящики заведены.
--
-- ЧТО ЗДЕСЬ.
--
-- 1. he_sending_pool — одна строка на ящик рассыльщика, который мы положили в
--    пул.
--      email                — адрес ящика (lowercase). У рассыльщика ящик
--                             адресуется ИМЕННО адресом (GET /accounts/{email},
--                             email_list кампании, email_account_ids пресета), то
--                             есть адрес и есть id ящика; отдельного id нет.
--                             Уникален во всём пуле: один ящик не может стоять в
--                             пуле дважды, даже в разных воркспейсах;
--      instantly_account_id — воркспейс рассыльщика, где ящик заведён (id из
--                             INSTANTLY_ACCOUNTS_JSON или 'main'); кампании
--                             проекта создаются там же;
--      status               — 'available' (свободен) | 'assigned' (отдан проекту)
--                             | 'disabled' (выключен сотрудником, не выдаётся);
--      project_id           — кому отдан; есть ровно у 'assigned' (CHECK ниже);
--      assigned_at          — когда отдан; есть ровно у 'assigned';
--      released_at          — когда ящик последний раз вернули в пул (история
--                             для экрана сотрудника);
--      notes                — заметка сотрудника;
--      created_at           — когда добавлен; свободные ящики выдаются в порядке
--                             добавления.
--
--    ПЕРЕХОДЫ (все — функциями ниже под одним advisory-замком пула; вставку
--    делает staff-роут, ряд всегда 'available'):
--      available → assigned   he_sending_pool_assign (запуск клиента);
--      assigned  → available  he_sending_pool_release (сотрудник, runbook смены
--                             сайта) — только у проекта БЕЗ запуска;
--      available ↔ disabled   he_sending_pool_set_status (сотрудник).
--    Выключить ОТДАННЫЙ ящик нельзя: его адрес уже стоит в кампаниях проекта, и
--    выключение здесь их не остановит. Отдельного «заменить один ящик проекта»
--    нет (кампании пришлось бы править у рассыльщика).
--
--    project_id → he_projects ON DELETE RESTRICT, а не cascade/set null: удалить
--    проект с отданными ящиками нельзя, пока их не вернули в пул. Cascade удалил
--    бы саму строку пула (ящик пропал бы из учёта, а у рассыльщика остался), set
--    null нарушил бы CHECK (assigned без проекта) — и ящик навсегда застрял бы
--    «отданным». Runbook смены сайта (docs/runbooks/eng-change-client-website.md)
--    возвращает ящики до удаления.
--
-- 2. he_sending_pool_launched(uuid[]) — есть ли у этих проектов запуск. То же
--    правило, что у runbook (шаг 5.1) и heTemplateLaunchMarked: в launch_info
--    шаблона непустой campaign_id (кампания у рассыльщика создана) ЛИБО аренда
--    running_until в будущем (попытка идёт сейчас) ЛИБО running_until, не
--    похожее на дату (разбирать руками — считаем запущенным). running_until в
--    прошлом без кампании — законченная попытка без кампании, НЕ запуск.
--
-- 3. he_sending_pool_assign(project, count, workspaces, preset_workspace) — выдать
--    проекту ящики. Под advisory-замком ВСЕГО пула (выдача, возврат и смена
--    статуса идут по очереди — исключительность держится замком, а не чтением).
--    Ответ jsonb, поле outcome:
--      'assigned' {instantly_account_id, mailboxes:[{id,email}], newly_assigned,
--        free_left}
--        — у проекта уже есть ящики: вернуть ИХ ЖЕ, ничего не меняя
--          (newly_assigned 0, free_left null; повторный вызов — тот же ответ;
--          p_count больше роли не играет — поднятое число новым проектам, не
--          прежним); иначе взять p_count свободных из ОДНОГО воркспейса (из
--          p_workspaces — списка воркспейсов, которые код знает; среди годных —
--          где свободных больше, при равенстве — по имени), старейшие первыми;
--          free_left — сколько свободных осталось в этом воркспейсе (код по нему
--          заранее предупреждает команду, что следующий клиент получит отказ);
--      'shortage' {need, best_free, pinned_workspace, by_workspace} — в одном
--        годном воркспейсе свободных меньше p_count: НЕ отдано НИЧЕГО (выдача
--        «сколько есть» не делается);
--      'workspace_conflict' {reason, instantly_account_id?, preset_workspace?} —
--        ничего не отдано и не изменено:
--          'mixed'          — ящики проекта лежат в разных воркспейсах (руками);
--          'unconfigured'   — воркспейс ящиков проекта / закреплённый воркспейс
--                             код не знает (нет в INSTANTLY_ACCOUNTS_JSON);
--          'preset_pinned'  — у клиента есть запуск, а ящики проекта в другом
--                             воркспейсе, чем пресет клиента;
--          'preset_missing' — у клиента есть запуск, а пресета нет;
--      'not_found' — проекта нет; 'not_us' — проект не рынка us.
--
--    ЗАКРЕПЛЕНИЕ ВОРКСПЕЙСА (p_preset_workspace — воркспейс текущего пресета
--    клиента или null, если пресета нет). Пресет у клиента ОДИН, и ночной долив
--    (appendLeadsToClientCampaign) ищет кампании в воркспейсе ПРЕСЕТА, а не
--    запуска: сменить воркспейс пресета после запуска — долив во все прежние
--    кампании отвечает «не найдено». Поэтому, если у ЛЮБОГО проекта клиента
--    (created_by) есть запуск, ящики выдаются только в воркспейсе его пресета,
--    а уже отданные в другом — конфликт. Без запуска воркспейс выбирается
--    свободно, и код пресет перепишет.
--
-- 4. he_sending_pool_release(project) — вернуть ВСЕ ящики проекта в пул. Под
--    тем же замком. outcome: 'released' {mailboxes:[{id,email,
--    instantly_account_id}]} | 'nothing_assigned' | 'launched' (у проекта есть
--    запуск — ничего не возвращено: адреса стоят в его кампаниях у рассыльщика,
--    и следующий проект слал бы из них же; такой возврат — решение владельца и
--    руками).
--
-- 5. he_sending_pool_set_status(id, status) — 'available' ↔ 'disabled'. Под тем
--    же замком. outcome: 'updated' {status} | 'unchanged' | 'assigned' (ящик
--    отдан проекту — не меняется) | 'not_found'.
--
-- КОД ДО МИГРАЦИИ (fail-closed для отправки). Нет функции (42883 / PGRST202) или
-- таблицы (42P01 / PGRST205): выдача отвечает «пул недоступен», и
-- ensureHeEngPresetForProject (engSendingPreset.ts) отвечает 503 с фразой
-- «проблема на нашей стороне, напишите в Support» и алертом команде, ничего не
-- записав, — роут запуска по её контракту отказывает; экран сотрудника пишет
-- «миграция не применена». Без пресета ядро запуска и так отказывает 409
-- preset_no_mailboxes — последняя страховка.
--
-- ПРАВА. Таблица и функции — только service_role (роуты Next); anon /
-- authenticated / public отозваны поимённо (линт
-- app/tests/migrations/grants.test.ts). RLS включён без политик. Функции —
-- security invoker, set search_path = '', имена квалифицированы.
--
-- ПОРЯДОК ВЫКАТА: миграция ДО кода (код без неё отказывает запуску, см. выше).
-- Идемпотентна: if not exists / create or replace, повторяемые
-- revoke/grant/comment. В транзакции (маркера no-transaction нет).

-- ─── 1. Таблица пула ─────────────────────────────────────────────────────

create table if not exists public.he_sending_pool (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique
                         check (email <> '' and email = lower(btrim(email))),
  instantly_account_id text not null check (instantly_account_id <> ''),
  status               text not null default 'available'
                         check (status in ('available', 'assigned', 'disabled')),
  project_id           uuid references public.he_projects(id) on delete restrict,
  assigned_at          timestamptz,
  released_at          timestamptz,
  notes                text,
  created_at           timestamptz not null default now(),
  constraint he_sending_pool_assignment_shape check (
    (status = 'assigned') = (project_id is not null)
    and (status = 'assigned') = (assigned_at is not null)
  )
);

-- Ящики проекта (выдача, возврат) и проверка FK при удалении проекта.
create index if not exists idx_he_sending_pool_project
  on public.he_sending_pool(project_id)
  where project_id is not null;

comment on table public.he_sending_pool is
  'ENG: пул наших ящиков отправки. Строка — ящик рассыльщика (адрес = его id) в воркспейсе instantly_account_id; available → assigned (проекту, he_sending_pool_assign) → available (he_sending_pool_release); available ↔ disabled (he_sending_pool_set_status).';
comment on column public.he_sending_pool.project_id is
  'Проект, которому ящик отдан (только у status = assigned). ON DELETE RESTRICT: проект с отданными ящиками не удаляется, пока их не вернули.';

alter table public.he_sending_pool enable row level security;

revoke all privileges on table public.he_sending_pool from public, anon, authenticated;
grant all on table public.he_sending_pool to service_role, postgres;

-- ─── 2. Есть ли у проектов запуск ────────────────────────────────────────

create or replace function public.he_sending_pool_launched(p_project_ids uuid[])
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
      from public.he_templates t
     where (t.vertical_id in (select v.id from public.he_verticals v where v.project_id = any (p_project_ids))
         or t.base_id in (select b.id from public.he_bases b where b.project_id = any (p_project_ids)))
       and (coalesce(t.launch_info->>'campaign_id', '') <> ''
         or case when t.launch_info->>'running_until' ~ '^\d{4}-\d{2}-\d{2}'
                 then (t.launch_info->>'running_until')::timestamptz > pg_catalog.now()
                 else coalesce(t.launch_info->>'running_until', '') <> ''
            end)
  );
$$;

comment on function public.he_sending_pool_launched(uuid[]) is
  'ENG: есть ли у проектов запуск (непустой launch_info.campaign_id, живая или неразборчивая аренда running_until) — правило runbook смены сайта и heTemplateLaunchMarked.';

revoke all on function public.he_sending_pool_launched(uuid[])
  from public, anon, authenticated;
grant execute on function public.he_sending_pool_launched(uuid[])
  to service_role, postgres;

-- ─── 3. Выдача ящиков проекту ────────────────────────────────────────────

create or replace function public.he_sending_pool_assign(
  p_project_id uuid,
  p_count integer,
  p_workspaces text[],
  p_preset_workspace text
)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_market     text;
  v_owner      uuid;
  v_projects   uuid[];
  v_have       integer;
  v_have_ws    text[];
  v_preset_ws  text := nullif(pg_catalog.btrim(coalesce(p_preset_workspace, '')), '');
  v_launched   boolean;
  v_pin        text;
  v_ws         text;
  v_free       integer := 0;
  v_taken      integer;
  v_free_left  integer;
  v_by_ws      jsonb;
begin
  if p_project_id is null then
    raise exception 'he_sending_pool_assign: project id is required';
  end if;
  if p_count is null or p_count < 1 or p_count > 50 then
    raise exception 'he_sending_pool_assign: count must be 1..50';
  end if;
  if p_workspaces is null or pg_catalog.cardinality(p_workspaces) = 0 then
    raise exception 'he_sending_pool_assign: at least one workspace is required';
  end if;

  -- Весь пул — по очереди: выдача, возврат и смена статуса берут этот ключ.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('he_sending_pool'), 0);

  select p.market, p.created_by
    into v_market, v_owner
    from public.he_projects p
   where p.id = p_project_id;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  if v_market is distinct from 'us' then
    return pg_catalog.jsonb_build_object('outcome', 'not_us');
  end if;

  -- Проекты клиента — для правила закрепления воркспейса (пресет у клиента один).
  if v_owner is null then
    v_projects := array[p_project_id];
  else
    select pg_catalog.array_agg(h.id) into v_projects
      from public.he_projects h
     where h.created_by = v_owner;
  end if;

  -- Уже отданные ящики проекта — вернуть их же.
  select pg_catalog.count(*)::integer,
         pg_catalog.array_agg(distinct s.instantly_account_id)
    into v_have, v_have_ws
    from public.he_sending_pool s
   where s.project_id = p_project_id
     and s.status = 'assigned';

  if v_have > 0 then
    if pg_catalog.cardinality(v_have_ws) > 1 then
      return pg_catalog.jsonb_build_object(
        'outcome', 'workspace_conflict', 'reason', 'mixed',
        'workspaces', pg_catalog.to_jsonb(v_have_ws));
    end if;
    v_ws := v_have_ws[1];
    if not (v_ws = any (p_workspaces)) then
      return pg_catalog.jsonb_build_object(
        'outcome', 'workspace_conflict', 'reason', 'unconfigured', 'instantly_account_id', v_ws);
    end if;
    if v_preset_ws is distinct from v_ws then
      v_launched := public.he_sending_pool_launched(v_projects);
      if v_launched and v_preset_ws is null then
        return pg_catalog.jsonb_build_object(
          'outcome', 'workspace_conflict', 'reason', 'preset_missing', 'instantly_account_id', v_ws);
      end if;
      if v_launched then
        return pg_catalog.jsonb_build_object(
          'outcome', 'workspace_conflict', 'reason', 'preset_pinned',
          'instantly_account_id', v_ws, 'preset_workspace', v_preset_ws);
      end if;
    end if;
    v_taken := 0;
  else
    v_launched := public.he_sending_pool_launched(v_projects);
    if v_launched and v_preset_ws is null then
      return pg_catalog.jsonb_build_object('outcome', 'workspace_conflict', 'reason', 'preset_missing');
    end if;
    if v_launched then
      v_pin := v_preset_ws;
      if not (v_pin = any (p_workspaces)) then
        return pg_catalog.jsonb_build_object(
          'outcome', 'workspace_conflict', 'reason', 'unconfigured', 'preset_workspace', v_pin);
      end if;
    end if;

    select s.instantly_account_id, pg_catalog.count(*)::integer
      into v_ws, v_free
      from public.he_sending_pool s
     where s.status = 'available'
       and s.instantly_account_id = any (p_workspaces)
       and (v_pin is null or s.instantly_account_id = v_pin)
     group by s.instantly_account_id
     order by pg_catalog.count(*) desc, s.instantly_account_id
     limit 1;
    v_free := coalesce(v_free, 0);

    if v_ws is null or v_free < p_count then
      select coalesce(pg_catalog.jsonb_object_agg(f.ws, f.free), '{}'::jsonb)
        into v_by_ws
        from (
          select s.instantly_account_id as ws, pg_catalog.count(*)::integer as free
            from public.he_sending_pool s
           where s.status = 'available'
             and s.instantly_account_id = any (p_workspaces)
           group by s.instantly_account_id
        ) f;
      return pg_catalog.jsonb_build_object(
        'outcome', 'shortage',
        'need', p_count,
        'best_free', v_free,
        'pinned_workspace', v_pin,
        'by_workspace', v_by_ws);
    end if;

    with picked as (
      select s.id
        from public.he_sending_pool s
       where s.status = 'available'
         and s.instantly_account_id = v_ws
       order by s.created_at, s.id
       limit p_count
         for update
    )
    update public.he_sending_pool u
       set status = 'assigned',
           project_id = p_project_id,
           assigned_at = pg_catalog.now()
      from picked
     where u.id = picked.id;
    get diagnostics v_taken = row_count;

    -- Под замком пула свободные ящики никто, кроме нас, не трогает: меньше —
    -- значит кто-то писал мимо функций. Откат всей выдачи, а не «сколько есть».
    if v_taken <> p_count then
      raise exception 'he_sending_pool_assign: took % of % mailboxes', v_taken, p_count;
    end if;

    select pg_catalog.count(*)::integer
      into v_free_left
      from public.he_sending_pool s
     where s.status = 'available'
       and s.instantly_account_id = v_ws;
  end if;

  return pg_catalog.jsonb_build_object(
    'outcome', 'assigned',
    'instantly_account_id', v_ws,
    'newly_assigned', v_taken,
    'free_left', v_free_left,
    'mailboxes', (
      select coalesce(pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('id', s.id, 'email', s.email) order by s.email), '[]'::jsonb)
        from public.he_sending_pool s
       where s.project_id = p_project_id
         and s.status = 'assigned'));
end;
$$;

comment on function public.he_sending_pool_assign(uuid, integer, text[], text) is
  'ENG: выдать us-проекту p_count ящиков пула из одного воркспейса под advisory-замком пула; у проекта уже есть ящики — вернуть их же. outcome: assigned | shortage (ничего не отдано) | workspace_conflict | not_found | not_us.';

revoke all on function public.he_sending_pool_assign(uuid, integer, text[], text)
  from public, anon, authenticated;
grant execute on function public.he_sending_pool_assign(uuid, integer, text[], text)
  to service_role, postgres;

-- ─── 4. Возврат ящиков проекта в пул ─────────────────────────────────────

create or replace function public.he_sending_pool_release(p_project_id uuid)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if p_project_id is null then
    raise exception 'he_sending_pool_release: project id is required';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('he_sending_pool'), 0);

  perform 1
    from public.he_sending_pool s
   where s.project_id = p_project_id
     and s.status = 'assigned';
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'nothing_assigned');
  end if;

  if public.he_sending_pool_launched(array[p_project_id]) then
    return pg_catalog.jsonb_build_object('outcome', 'launched');
  end if;

  with released as (
    update public.he_sending_pool s
       set status = 'available',
           project_id = null,
           assigned_at = null,
           released_at = pg_catalog.now()
     where s.project_id = p_project_id
       and s.status = 'assigned'
    returning s.id, s.email, s.instantly_account_id
  )
  select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object('id', r.id, 'email', r.email, 'instantly_account_id', r.instantly_account_id)
           order by r.email), '[]'::jsonb)
    into v_rows
    from released r;

  return pg_catalog.jsonb_build_object('outcome', 'released', 'mailboxes', v_rows);
end;
$$;

comment on function public.he_sending_pool_release(uuid) is
  'ENG: вернуть все ящики проекта в пул под advisory-замком пула, если у проекта нет запуска. outcome: released | nothing_assigned | launched (ничего не возвращено).';

revoke all on function public.he_sending_pool_release(uuid)
  from public, anon, authenticated;
grant execute on function public.he_sending_pool_release(uuid)
  to service_role, postgres;

-- ─── 5. Выключить / включить свободный ящик ──────────────────────────────

create or replace function public.he_sending_pool_set_status(p_id uuid, p_status text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_id is null then
    raise exception 'he_sending_pool_set_status: id is required';
  end if;
  if p_status is null or p_status not in ('available', 'disabled') then
    raise exception 'he_sending_pool_set_status: status must be available or disabled';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('he_sending_pool'), 0);

  select s.status into v_status
    from public.he_sending_pool s
   where s.id = p_id
     for update;
  if not found then
    return pg_catalog.jsonb_build_object('outcome', 'not_found');
  end if;
  if v_status = 'assigned' then
    return pg_catalog.jsonb_build_object('outcome', 'assigned');
  end if;
  if v_status = p_status then
    return pg_catalog.jsonb_build_object('outcome', 'unchanged', 'status', v_status);
  end if;

  update public.he_sending_pool
     set status = p_status
   where id = p_id;

  return pg_catalog.jsonb_build_object('outcome', 'updated', 'status', p_status);
end;
$$;

comment on function public.he_sending_pool_set_status(uuid, text) is
  'ENG: перевести НЕ отданный ящик пула между available и disabled под advisory-замком пула. outcome: updated | unchanged | assigned (отдан — не меняется) | not_found.';

revoke all on function public.he_sending_pool_set_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.he_sending_pool_set_status(uuid, text)
  to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_sending_pool to readonly';
  end if;
end $$;
