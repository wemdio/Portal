-- «Рассылка» для Движка вертикалей: выключатели (этап 6, план 24.10.2026).
--
-- Остановить за минуты, не трогая Instantly и папки «Рассылки»:
--   1) новые запуски — только Instantly: ve_launch_transport_settings.mode
--      (mode_before_stop помнит, что вернуть);
--   2) подача контактов в «Рассылку»: sender_uploads_enabled (уже есть);
--   3) отправка кампаний Движка: ve_sender_global_settings.sending_enabled +
--      пауза идущих кампаний ve2 (ve_sender_pause_running) + запрет запуска
--      триггером. Пауза — в данных, поэтому работает и на почтовых хостах со
--      старым кодом: письма раздаёт claim_sender_messages только идущим кампаниям;
--   4) карточки лидов: sender_project_lead_settings (этап 5) — кто и когда.
--
-- Выключатели пишет админская панель Движка (/api/admin/ve2-sender), запасной
-- путь — psql (функции разрешают p_user = null). Сама миграция ничего не
-- останавливает: всё включено, кампаний ve2 в работе нет.

set local lock_timeout = '5s';
-- Триггер и внешний ключ берут эту блокировку всё равно; берём её сразу, чтобы
-- ждать (не дольше lock_timeout) до любой работы.
lock table public.sender_campaigns in share row exclusive mode;

-- ─── Отправка кампаний Движка: выключатель ─────────────────────────────────
create table if not exists public.ve_sender_global_settings (
  id                 boolean primary key default true check (id),
  sending_enabled    boolean not null default true,
  sending_changed_at timestamptz,
  sending_changed_by uuid,
  sending_note       text,
  updated_at         timestamptz not null default now()
);

-- Повторное применение не должно молча вернуть отправку: только do nothing.
insert into public.ve_sender_global_settings (id) values (true)
  on conflict (id) do nothing;

alter table public.ve_sender_global_settings enable row level security;
revoke all on public.ve_sender_global_settings from public, anon, authenticated;
grant all on public.ve_sender_global_settings to service_role;

comment on table public.ve_sender_global_settings is
  'Kill switch for sending of ve2 sender campaigns: off — ve2 campaigns are paused (ve_sender_pause_running) and cannot be started.';

-- Переключили не панелью (psql на случай, когда портал лежит): «когда» — сейчас,
-- «кто» — неизвестно. Иначе health-check считал бы остановку от старой отметки.
create or replace function public.ve_sender_global_settings_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.sending_enabled is distinct from old.sending_enabled
     and new.sending_changed_at is not distinct from old.sending_changed_at then
    new.sending_changed_at := now();
    new.sending_changed_by := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ve_sender_global_settings_touch on public.ve_sender_global_settings;
create trigger ve_sender_global_settings_touch
  before update on public.ve_sender_global_settings
  for each row execute function public.ve_sender_global_settings_touch();

revoke all on function public.ve_sender_global_settings_touch() from public, anon, authenticated;

-- ─── Новые запуски: что вернуть после «только Instantly» ───────────────────
alter table public.ve_launch_transport_settings
  add column if not exists mode_before_stop text;
alter table public.ve_launch_transport_settings
  drop constraint if exists ve_launch_transport_settings_mode_before_stop_check;
alter table public.ve_launch_transport_settings
  add constraint ve_launch_transport_settings_mode_before_stop_check
  check (mode_before_stop is null or mode_before_stop in ('pilot', 'sender'));

comment on column public.ve_launch_transport_settings.mode_before_stop is
  'Mode to restore after the «only Instantly» kill switch; null — nothing to restore.';

-- Как и с переключателем рынка: правка не панелью — «когда» сейчас, «кто» неизвестно.
create or replace function public.ve_launch_transport_settings_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.mode, new.sender_uploads_enabled) is distinct from (old.mode, old.sender_uploads_enabled)
     and new.updated_at is not distinct from old.updated_at then
    new.updated_at := now();
    new.updated_by := null;
  end if;
  return new;
end;
$$;

drop trigger if exists ve_launch_transport_settings_touch on public.ve_launch_transport_settings;
create trigger ve_launch_transport_settings_touch
  before update on public.ve_launch_transport_settings
  for each row execute function public.ve_launch_transport_settings_touch();

revoke all on function public.ve_launch_transport_settings_touch() from public, anon, authenticated;

-- ─── Карточки лидов: кто и когда выключил ──────────────────────────────────
alter table public.sender_project_lead_settings
  add column if not exists disabled_at timestamptz,
  add column if not exists updated_by  uuid,
  add column if not exists note        text;

-- Триггер этапа 5 (20261026_0010) + момент выключения, если выключили не панелью.
create or replace function public.sender_project_lead_settings_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.enabled and not old.enabled then
    new.enabled_at := now();
  end if;
  if old.enabled and not new.enabled and new.disabled_at is not distinct from old.disabled_at then
    new.disabled_at := now();
    new.updated_by := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- ─── Что сделала остановка — продолжение трогает только это ────────────────
-- paused      — идущая кампания встала на паузу;
-- unscheduled — у черновика или паузы снят назначенный запуск.
-- paused_at — updated_at, который записала остановка: другой updated_at значит,
-- что кампанию после остановки трогали люди, и продолжение её не трогает.
create table if not exists public.ve_sender_sending_pauses (
  id                          uuid primary key default gen_random_uuid(),
  batch_id                    uuid not null,
  campaign_id                 uuid not null references public.sender_campaigns(id) on delete cascade,
  action                      text not null check (action in ('paused', 'unscheduled')),
  paused_at                   timestamptz not null,
  prior_status                text not null,
  prior_scheduled_start_at    timestamptz,
  prior_scheduled_start_error text,
  resume_claimed_until        timestamptz,
  resumed_at                  timestamptz,
  resumed_by                  uuid,
  resume_result               text,
  created_at                  timestamptz not null default now()
);

create index if not exists ve_sender_sending_pauses_open_idx
  on public.ve_sender_sending_pauses (created_at)
  where resumed_at is null;
create index if not exists ve_sender_sending_pauses_open_campaign_idx
  on public.ve_sender_sending_pauses (campaign_id)
  where resumed_at is null;

alter table public.ve_sender_sending_pauses enable row level security;
revoke all on public.ve_sender_sending_pauses from public, anon, authenticated;
grant all on public.ve_sender_sending_pauses to service_role;

comment on table public.ve_sender_sending_pauses is
  'What the ve2 sending kill switch paused or unscheduled; resume restarts only rows still open and untouched since.';

-- ─── Запуск кампании Движка при остановленной отправке — отказ ─────────────
-- Страховка для кода, который мы не контролируем (почтовые хосты со старым
-- образом, ручной SQL). Флаг читается FOR SHARE: запуск, проверивший флаг,
-- держит строку до своего коммита, и остановка (отдельная транзакция) ждёт его —
-- пауза после неё увидит кампанию идущей. Нет строки — отправка включена.
create or replace function public.sender_campaigns_ve2_sending_hold()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_enabled boolean;
begin
  if new.source_kind = 've2' and new.status = 'running' then
    if tg_op = 'INSERT' or old.status is distinct from 'running' then
      select s.sending_enabled into v_enabled
        from public.ve_sender_global_settings s
       where s.id
         for share;
      if v_enabled is false then
        raise exception using
          errcode = 'P0001',
          message = 'VE2_SENDING_STOPPED: Отправка кампаний Движка остановлена администратором';
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists sender_campaigns_ve2_sending_hold on public.sender_campaigns;
create trigger sender_campaigns_ve2_sending_hold
  before insert or update of status on public.sender_campaigns
  for each row execute function public.sender_campaigns_ve2_sending_hold();

revoke all on function public.sender_campaigns_ve2_sending_hold() from public, anon, authenticated;

-- ─── Пауза идущих кампаний Движка ──────────────────────────────────────────
-- Флаг не трогает: его ставят отдельной транзакцией до вызова (иначе запуск,
-- ждущий флаг, и пауза, ждущая кампанию, взаимно блокируются). Письма в
-- 'sending' не отменяет: продолжение удалило бы отменённое письмо, пока воркер
-- пишет «ушло», и шаг ушёл бы второй раз.
create or replace function public.ve_sender_pause_running(p_note text)
returns jsonb
language plpgsql
set search_path = ''
set lock_timeout = '5s'
set statement_timeout = '30s'
as $$
declare
  v_batch uuid := gen_random_uuid();
  v_now timestamptz := now();
  v_paused integer := 0;
  v_unscheduled integer := 0;
  v_canceled integer := 0;
  v_still integer := 0;
begin
  with running as (
    select c.id, c.scheduled_start_at, c.scheduled_start_error
      from public.sender_campaigns c
     where c.source_kind = 've2' and c.status = 'running'
       for update
  ), logged as (
    insert into public.ve_sender_sending_pauses
      (batch_id, campaign_id, action, paused_at, prior_status, prior_scheduled_start_at, prior_scheduled_start_error)
    select v_batch, r.id, 'paused', v_now, 'running', r.scheduled_start_at, r.scheduled_start_error
      from running r
    returning campaign_id
  )
  update public.sender_campaigns c
     set status = 'paused', updated_at = v_now
    from logged l
   where c.id = l.campaign_id;
  get diagnostics v_paused = row_count;

  update public.sender_messages m
     set status = 'canceled'
    from public.ve_sender_sending_pauses p
   where p.batch_id = v_batch and p.action = 'paused'
     and m.campaign_id = p.campaign_id and m.status = 'scheduled';
  get diagnostics v_canceled = row_count;

  with planned as (
    select c.id, c.scheduled_start_at, c.scheduled_start_error, c.status, c.updated_at
      from public.sender_campaigns c
     where c.source_kind = 've2' and c.status in ('draft', 'paused')
       and (c.scheduled_start_at is not null or c.scheduled_start_error = 'запускается')
       for update
  ), logged as (
    insert into public.ve_sender_sending_pauses
      (batch_id, campaign_id, action, paused_at, prior_status, prior_scheduled_start_at, prior_scheduled_start_error)
    select v_batch, p.id, 'unscheduled', v_now, p.status,
           -- «запускается» без времени: запуск уже шёл — вернём его на «сейчас».
           coalesce(p.scheduled_start_at, p.updated_at), p.scheduled_start_error
      from planned p
    returning campaign_id
  )
  update public.sender_campaigns c
     set scheduled_start_at = null, scheduled_start_error = null, updated_at = v_now
    from logged l
   where c.id = l.campaign_id;
  get diagnostics v_unscheduled = row_count;

  select count(*) into v_still
    from public.sender_campaigns c
   where c.source_kind = 've2' and c.status = 'running';

  return jsonb_build_object(
    'batch_id', v_batch,
    'paused', v_paused,
    'unscheduled', v_unscheduled,
    'canceled_messages', v_canceled,
    'still_running', v_still,
    'note', p_note
  );
end;
$$;

-- ─── Продолжение: занять строку, закончить без человека ────────────────────
-- Одно продолжение на строку за раз: занятая строка свободна через 2 минуты.
create or replace function public.ve_sender_resume_claim(p_pause_id uuid)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_row public.ve_sender_sending_pauses;
  v_status text;
  v_updated timestamptz;
  v_active integer;
begin
  update public.ve_sender_sending_pauses p
     set resume_claimed_until = now() + interval '2 minutes'
   where p.id = p_pause_id and p.resumed_at is null
     and (p.resume_claimed_until is null or p.resume_claimed_until < now())
  returning * into v_row;
  if not found then
    return jsonb_build_object('claimed', false);
  end if;
  select c.status, c.updated_at into v_status, v_updated
    from public.sender_campaigns c where c.id = v_row.campaign_id;
  select count(*) into v_active
    from public.sender_recipients r where r.campaign_id = v_row.campaign_id and r.status = 'active';
  return jsonb_build_object(
    'claimed', true,
    'action', v_row.action,
    'campaign_id', v_row.campaign_id,
    'campaign_status', v_status,
    'untouched', v_updated is not distinct from v_row.paused_at,
    'active_recipients', v_active,
    'prior_scheduled_start_at', v_row.prior_scheduled_start_at
  );
end;
$$;

-- p_mode:
--   raw_running      — кампания без активных получателей (между подачами):
--                      startCampaign такую отклоняет, а пауза после активации
--                      не получает подачи — без этого шага она стояла бы навсегда;
--   restore_schedule — вернуть снятый назначенный запуск (прошедшее время — «сейчас»);
--   close            — закрыть строку с итогом (запущена, оставлена на паузе, изменена).
-- Сравнение updated_at = paused_at — здесь, в SQL: в JS микросекунды теряются.
create or replace function public.ve_sender_resume_finish(p_pause_id uuid, p_mode text, p_user uuid, p_result text)
returns text
language plpgsql
set search_path = ''
as $$
declare
  v_rows integer := 0;
begin
  if p_mode = 'raw_running' then
    update public.sender_campaigns c
       set status = 'running', updated_at = now()
      from public.ve_sender_sending_pauses p
     where p.id = p_pause_id and p.resumed_at is null and p.action = 'paused'
       and c.id = p.campaign_id and c.status = 'paused' and c.updated_at = p.paused_at
       and not exists (select 1 from public.sender_recipients r where r.campaign_id = c.id and r.status = 'active');
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return 'skip'; end if;
  elsif p_mode = 'restore_schedule' then
    update public.sender_campaigns c
       set scheduled_start_at = greatest(p.prior_scheduled_start_at, now()), scheduled_start_error = null, updated_at = now()
      from public.ve_sender_sending_pauses p
     where p.id = p_pause_id and p.resumed_at is null and p.action = 'unscheduled'
       and c.id = p.campaign_id and c.status in ('draft', 'paused') and c.scheduled_start_at is null
       and c.updated_at = p.paused_at;
    get diagnostics v_rows = row_count;
    if v_rows = 0 then return 'skip'; end if;
  elsif p_mode <> 'close' then
    raise exception 'unknown resume mode %', p_mode;
  end if;

  update public.ve_sender_sending_pauses p
     set resumed_at = now(), resumed_by = p_user, resume_result = left(p_result, 300), resume_claimed_until = null
   where p.id = p_pause_id and p.resumed_at is null;
  get diagnostics v_rows = row_count;
  return case when v_rows = 1 then 'done' else 'skip' end;
end;
$$;

revoke all on function public.ve_sender_pause_running(text) from public, anon, authenticated;
revoke all on function public.ve_sender_resume_claim(uuid) from public, anon, authenticated;
revoke all on function public.ve_sender_resume_finish(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function public.ve_sender_pause_running(text) to service_role;
grant execute on function public.ve_sender_resume_claim(uuid) to service_role;
grant execute on function public.ve_sender_resume_finish(uuid, text, uuid, text) to service_role;
