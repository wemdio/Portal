-- TG Outreach: прогрев аккаунтов перепиской между собой.
--
-- Свежекупленный аккаунт нельзя сразу пускать на боевых лидов: у аккаунта без
-- истории любая активность выглядит подозрительно. Прогрев несколько дней гоняет
-- аккаунты кампании в переписке друг с другом, наращивая нагрузку.
--
-- Дизайн: docs/superpowers/specs/2026-08-03-tg-outreach-warmup-design.md

create table if not exists public.tg_outreach_warmup_runs (
  id            uuid primary key default gen_random_uuid(),
  campaign_id   uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  days          int  not null check (days between 1 and 14),
  status        text not null default 'pending'
                check (status in ('pending','running','finished','stopped','failed')),
  current_day   int  not null default 0,
  started_at    timestamptz,
  finished_at   timestamptz,
  -- Снимок констант кривой нагрузки на момент старта: если поменяем пороги,
  -- уже идущий прогрев должен доиграть по своим правилам.
  settings      jsonb not null default '{}'::jsonb,
  summary       jsonb,
  error_message text,
  created_at    timestamptz not null default now()
);

create index if not exists tg_outreach_warmup_runs_campaign_idx
  on public.tg_outreach_warmup_runs (campaign_id, created_at desc);

-- Один активный прогрев на кампанию. Прогрев и боевой цикл взаимоисключающие:
-- иначе один аккаунт одновременно и греется, и пишет клиенту.
create unique index if not exists tg_outreach_warmup_runs_one_active_idx
  on public.tg_outreach_warmup_runs (campaign_id)
  where status in ('pending','running');

create table if not exists public.tg_outreach_warmup_conversations (
  id                   bigint generated always as identity primary key,
  run_id               uuid not null references public.tg_outreach_warmup_runs(id) on delete cascade,
  campaign_id          uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  day_no               int  not null,
  -- Пара нормализована (account_a_id < account_b_id как текст), чтобы
  -- уникальный индекс ловил дубль независимо от порядка участников.
  account_a_id         uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  account_b_id         uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  initiator_account_id uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  planned_at           timestamptz not null,
  planned_messages     int not null,
  status               text not null default 'pending'
                       check (status in ('pending','running','done','failed','skipped')),
  started_at           timestamptz,
  finished_at          timestamptz,
  messages             jsonb not null default '[]'::jsonb,
  error_reason         text,
  created_at           timestamptz not null default now(),
  constraint tg_outreach_warmup_conv_distinct_accounts check (account_a_id <> account_b_id)
);

create unique index if not exists tg_outreach_warmup_conv_unique_pair_per_day_idx
  on public.tg_outreach_warmup_conversations (run_id, day_no, account_a_id, account_b_id);

create index if not exists tg_outreach_warmup_conv_due_idx
  on public.tg_outreach_warmup_conversations (run_id, status, planned_at);

create index if not exists tg_outreach_warmup_conv_account_a_idx
  on public.tg_outreach_warmup_conversations (campaign_id, account_a_id, planned_at desc);

create index if not exists tg_outreach_warmup_conv_account_b_idx
  on public.tg_outreach_warmup_conversations (campaign_id, account_b_id, planned_at desc);

comment on table public.tg_outreach_warmup_conversations is
  'Переписки прогрева между собственными аккаунтами кампании. Намеренно отдельно от tg_outreach_dialogs: иначе свои аккаунты попадут в список лидов, боевой GPT начнёт отвечать им как клиентам и сработает пересылка в рабочий чат.';

-- Личность самого аккаунта. Боевому циклу она не нужна (он всегда отвечает уже
-- известному собеседнику из getDialogs), а прогреву необходима: чтобы аккаунт А
-- написал аккаунту Б первым, надо знать, как Б адресовать.
alter table public.tg_outreach_accounts
  add column if not exists tg_user_id bigint,
  add column if not exists tg_username text,
  add column if not exists identity_checked_at timestamptz;

comment on column public.tg_outreach_accounts.tg_user_id is
  'Собственный Telegram user id аккаунта. Заполняется getMe() при старте прогрева; боевой цикл использует его, чтобы не принять свой же аккаунт за лида.';

-- Привязка события к аккаунту. Раньше делалась сопоставлением session_name в
-- тексте сообщения — ненадёжно. Существующий код колонку не заполняет.
alter table public.tg_outreach_logs
  add column if not exists account_id uuid references public.tg_outreach_accounts(id) on delete set null;

create index if not exists tg_outreach_logs_account_idx
  on public.tg_outreach_logs (campaign_id, account_id, created_at desc);

alter table public.tg_outreach_jobs drop constraint if exists tg_outreach_jobs_action_check;
alter table public.tg_outreach_jobs add constraint tg_outreach_jobs_action_check
  check (action in ('start','stop','restart','refetch_messages','warmup_start','warmup_stop'));

alter table public.tg_outreach_warmup_runs enable row level security;
alter table public.tg_outreach_warmup_conversations enable row level security;

create policy tg_outreach_warmup_runs_select_all on public.tg_outreach_warmup_runs
  for select to authenticated using (true);
create policy tg_outreach_warmup_conv_select_all on public.tg_outreach_warmup_conversations
  for select to authenticated using (true);

-- Воркер ходит под service_role; специалисты читают через RLS-политики выше.
grant all on public.tg_outreach_warmup_runs to service_role;
grant all on public.tg_outreach_warmup_conversations to service_role;
grant select on public.tg_outreach_warmup_runs to authenticated;
grant select on public.tg_outreach_warmup_conversations to authenticated;
