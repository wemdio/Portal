-- Автодобор базы автоаутричей RU/EN и два лимита ящика «Рассылки»
-- (docs/superpowers/specs/2026-10-06-outreach-autofill-design.md).

-- ── Лимиты ящика: «новых в день» и «всего в день» ──────────────────────────
-- Раньше daily_campaign_limit ограничивал все письма цепочки разом, и первые
-- письма выбирали его целиком: напоминания ждали, пока не кончатся новые.
-- Теперь он — только первые письма, а все шаги ограничивает daily_total_limit
-- (был в схеме, кодом не читался). Цепочка из 4 писем → «всего» = 4 × «новых».
alter table public.sender_mailboxes alter column daily_total_limit set default 20;
update public.sender_mailboxes set daily_total_limit = daily_campaign_limit * 4;

comment on column public.sender_mailboxes.daily_campaign_limit is
  'Новых в день: первые письма (шаг 1) с ящика за сутки UTC, по всем кампаниям.';
comment on column public.sender_mailboxes.daily_total_limit is
  'Всего в день: все письма цепочек с ящика за сутки UTC, по всем кампаниям.';

-- ── Настройки и состояние автодобора ───────────────────────────────────────
create table if not exists public.outreach_autofill (
  lang text primary key check (lang in ('ru', 'en')),
  enabled boolean not null default false,
  -- Конфиг запуска своего языка (как parser_jobs.config), без limit: его считает автодобор.
  config jsonb not null default '{}'::jsonb,
  -- Кто включил — автор автосборов (parser_jobs.user_id обязателен).
  owner_id uuid references auth.users (id) on delete set null,
  last_check_at timestamptz,
  -- {perDay, remaining, daysLeft, baseUntil, checkedAt} — строка состояния на экране.
  last_state jsonb,
  last_job_id uuid references public.parser_jobs (id) on delete set null,
  -- День (МСК) последнего автосбора: не больше одного в день.
  last_job_day date,
  -- Итог последнего автосбора разобран: залит и запущен или сообщён в чат.
  last_job_handled boolean not null default true,
  last_job_target int,
  -- Автосборов подряд, набравших меньше половины цели.
  short_streak int not null default 0,
  updated_at timestamptz not null default now()
);

insert into public.outreach_autofill (lang) values ('ru'), ('en') on conflict (lang) do nothing;

-- Читают и пишут только сервер (роут настроек под админом) и воркер — сервисным ключом.
alter table public.outreach_autofill enable row level security;
grant all on public.outreach_autofill to service_role;

-- ── Скорость и остаток базы папки ──────────────────────────────────────────
-- per_day — сумма «новых в день» рабочих ящиков папки; remaining — компании
-- (group_key, у ручных получателей — сам получатель) в идущих и стоящих на
-- паузе рассылках папки, которым ещё не ушло первое письмо. Черновики не
-- считаем: они не шлют.
create or replace function public.outreach_autofill_folder_state(p_folder_key text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with folder as (
    select id, mailbox_ids, send_weekdays, timezone
      from public.sender_folders
     where key = p_folder_key
  )
  select case when f.id is null then null else jsonb_build_object(
    'folder_id', f.id,
    'per_day', coalesce((
      select sum(m.daily_campaign_limit)
        from public.sender_mailboxes m
       where m.id = any (coalesce(f.mailbox_ids, '{}'))
         and m.status = 'verified'
         and m.enabled
    ), 0),
    'remaining', (
      select count(distinct coalesce(r.group_key, r.id::text))
        from public.sender_recipients r
        join public.sender_campaigns c on c.id = r.campaign_id
       where c.folder_id = f.id
         and c.status in ('running', 'paused')
         and r.status = 'active'
         and r.last_step_sent = 0
    ),
    'send_weekdays', to_jsonb(f.send_weekdays),
    'timezone', f.timezone
  ) end
  from (select 1) one
  left join folder f on true;
$$;

revoke all on function public.outreach_autofill_folder_state(text) from public;
grant execute on function public.outreach_autofill_folder_state(text) to service_role;
