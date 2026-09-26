-- «Рассылка»: папки рассылок — «Автоаутрич RU» и «Автоаутрич EN»
-- (docs/superpowers/specs/2026-09-26-outreach-to-sender-design.md, §5).
--
-- Каждый запуск автоаутрича по кнопке становится отдельной рассылкой. Чтобы
-- оператор не выставлял ящики, часы и интервалы писем на каждую заново, эти
-- настройки живут в папке: новая рассылка копирует их себе в момент создания.
-- Дальше рассылка самостоятельна — правка папки уже созданные не меняет, как и
-- у ручной кампании, где настройки задаются в форме.

-- ── Папки ────────────────────────────────────────────────────────────────────
create table if not exists public.sender_folders (
  id uuid primary key default gen_random_uuid(),
  -- Код заливки находит папку по ключу (auto_ru / auto_en), а не по названию:
  -- название — для людей и может поменяться.
  key text not null unique,
  name text not null,
  -- Окно отправки — те же правила и значения по умолчанию, что у
  -- sender_campaigns (20260916_0001): папка отдаёт их рассылке как есть.
  -- Дни недели: 1 = понедельник … 7 = воскресенье (lib/sender/sendWindow.ts).
  timezone text not null default 'Europe/Moscow',
  send_hour_from int not null default 9 check (send_hour_from between 0 and 23),
  send_hour_to int not null default 18 check (send_hour_to between 1 and 24),
  send_weekdays int[] not null default '{1,2,3,4,5}',
  gap_seconds int not null default 180 check (gap_seconds >= 0),
  gap_jitter_seconds int not null default 120 check (gap_jitter_seconds >= 0),
  -- Задержки писем 2, 3, 4 от предыдущего письма, в часах: [24,24,24] —
  -- письма уходят в день 0, +1, +2, +3.
  step_delays_hours int[] not null default '{24,24,24}',
  -- Ящики папки — массивом, а не таблицей связей: папка только запоминает
  -- выбор для будущих рассылок, пул самой рассылки при создании копируется в
  -- sender_campaign_mailboxes. Внешнего ключа у элементов массива нет, поэтому
  -- удалённый ящик здесь остаётся — читающий код берёт только существующие.
  mailbox_ids uuid[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (send_hour_to > send_hour_from)
);

-- Сиды: окно отправки — рабочие часы получателя, в его поясе. В США принят
-- день 9–17, у нас 9–18. Ящики выбираются один раз в настройках папки.
-- on conflict не затирает то, что уже поменяли на экране.
insert into public.sender_folders (key, name, timezone, send_hour_from, send_hour_to, send_weekdays, step_delays_hours)
values
  ('auto_ru', 'Автоаутрич RU', 'Europe/Moscow', 9, 18, '{1,2,3,4,5}', '{24,24,24}'),
  ('auto_en', 'Автоаутрич EN', 'America/New_York', 9, 17, '{1,2,3,4,5}', '{24,24,24}')
on conflict (key) do nothing;

-- ── Рассылка: папка и откуда она пришла ──────────────────────────────────────
-- folder_id — в какой папке рассылка лежит на экране. on delete set null:
-- удалили папку — рассылки с письмами и ответами остаются, просто «без папки».
-- source_kind — кто создал рассылку: человек в форме или заливка аутрича.
-- source_job_id — запуск аутрича (parser_jobs), из которого залиты получатели.
-- Внешнего ключа нет намеренно: рассылка с ушедшими письмами — это история
-- переписки, и чистка задач парсера не должна её трогать или блокировать.
alter table public.sender_campaigns
  add column if not exists folder_id uuid references public.sender_folders(id) on delete set null,
  add column if not exists source_kind text not null default 'manual',
  add column if not exists source_job_id uuid;

-- Ограничение отдельной командой с именем, как у provider и auth_type ящиков:
-- новый источник добавляется заменой одного check.
alter table public.sender_campaigns
  drop constraint if exists sender_campaigns_source_kind_check;
alter table public.sender_campaigns
  add constraint sender_campaigns_source_kind_check
  check (source_kind in ('manual', 'polza_ru', 'polza_en'));

-- Список рассылок папки (экран и выбор «добавить в существующую») и удаление
-- папки (обнуление folder_id) без полного прохода по рассылкам.
create index if not exists idx_sender_campaigns_folder
  on public.sender_campaigns (folder_id);
-- Рассылки конкретного запуска аутрича: ссылка есть только у залитых.
create index if not exists idx_sender_campaigns_source_job
  on public.sender_campaigns (source_job_id)
  where source_job_id is not null;

-- ── Доступ ───────────────────────────────────────────────────────────────────
-- Как и остальные sender_*: только service_role, люди ходят через
-- /api/tools/sender/** с проверкой доступа.
alter table public.sender_folders enable row level security;

grant all on public.sender_folders to service_role;

comment on table public.sender_folders is
  'Sender campaign folders (auto_ru / auto_en for the RU and EN auto-outreach): default schedule, mailbox pool and step delays copied into each new campaign created from an outreach run.';
comment on column public.sender_folders.step_delays_hours is
  'Delays of letters 2, 3, 4… from the previous letter, in hours. [24,24,24] = day 0, +1, +2, +3.';
comment on column public.sender_folders.mailbox_ids is
  'Mailboxes preselected for new campaigns of the folder. No FK on array elements: readers must skip ids of deleted mailboxes.';
comment on column public.sender_campaigns.source_kind is
  'Who created the campaign: manual (campaign form) or an auto-outreach upload (polza_ru / polza_en).';
comment on column public.sender_campaigns.source_job_id is
  'parser_jobs.id of the outreach run the recipients were uploaded from. No FK on purpose: the campaign outlives job cleanup.';
