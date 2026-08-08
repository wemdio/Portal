-- Прогрев: необязательный этап активности в публичных чатах.
--
-- Переписка между своими безопасна по построению — свои пишут своим, в личке.
-- Публичный чат другой класс риска: ответ видят админы и антиспам-боты. Отсюда
-- устройство таблиц: участие аккаунта в чате отслеживается отдельно (чтобы
-- забаненному аккаунту больше ничего не планировать), а каждая активность
-- планируется заранее и выполняется по времени — как переписки.
--
-- Дизайн: docs/superpowers/specs/2026-08-07-tg-warmup-public-chats-design.md

-- Список чатов кампании. Живёт долго и не привязан к запуску прогрева: списки
-- собираются один раз, а прогревов на кампании может быть несколько.
create table if not exists public.tg_outreach_warmup_chats (
  id                 uuid primary key default gen_random_uuid(),
  campaign_id        uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  -- Что ввёл оператор: t.me/имя, @имя или полная ссылка.
  link               text not null,
  -- Разобранный из ссылки username. Ссылки-приглашения (t.me/+hash) не
  -- поддерживаем — см. «Вне объёма» в спеке.
  username           text,
  tg_chat_id         bigint,
  title              text,
  participants_count int,
  status             text not null default 'pending'
                     check (status in ('pending','resolved','unresolvable')),
  error_reason       text,
  is_active          boolean not null default true,
  checked_at         timestamptz,
  created_at         timestamptz not null default now()
);

-- Индекс по обычным колонкам, а не по выражению: upsert из API опирается на
-- него по имени колонок. Регистр нормализуется при разборе ссылки, до вставки.
create unique index if not exists tg_outreach_warmup_chats_unique_idx
  on public.tg_outreach_warmup_chats (campaign_id, link);

create index if not exists tg_outreach_warmup_chats_campaign_idx
  on public.tg_outreach_warmup_chats (campaign_id, created_at desc);

comment on table public.tg_outreach_warmup_chats is
  'Публичные чаты для прогрева. Список задаёт оператор; автоматического подбора по тематике нет.';

-- Кто в каком чате состоит. Отдельная таблица, а не поле в чате: раскладка
-- своя у каждого аккаунта (каждому 2-3 чата из списка), и запрет писать тоже
-- индивидуальный — один аккаунт забанили, остальные продолжают.
create table if not exists public.tg_outreach_warmup_chat_members (
  id           bigint generated always as identity primary key,
  run_id       uuid not null references public.tg_outreach_warmup_runs(id) on delete cascade,
  campaign_id  uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  account_id   uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  chat_id      uuid not null references public.tg_outreach_warmup_chats(id) on delete cascade,
  -- forbidden — писать запрещено или аккаунт забанен: активности этому
  -- аккаунту в этот чат больше не планируются, но участие сохраняем для
  -- истории и чтобы не пытаться вступить заново.
  status       text not null default 'pending'
               check (status in ('pending','joined','failed','forbidden')),
  planned_at   timestamptz,
  joined_at    timestamptz,
  error_reason text,
  created_at   timestamptz not null default now()
);

create unique index if not exists tg_outreach_warmup_chat_members_unique_idx
  on public.tg_outreach_warmup_chat_members (run_id, account_id, chat_id);

create index if not exists tg_outreach_warmup_chat_members_due_idx
  on public.tg_outreach_warmup_chat_members (run_id, status, planned_at);

-- Запланированное действие в чате. Устроено как tg_outreach_warmup_conversations:
-- «планируем на день, выполняем по времени», поэтому цикл прогрева получает
-- вторую очередь работ рядом с первой, а не отдельный процесс.
create table if not exists public.tg_outreach_warmup_activities (
  id                bigint generated always as identity primary key,
  run_id            uuid not null references public.tg_outreach_warmup_runs(id) on delete cascade,
  campaign_id       uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  day_no            int  not null,
  account_id        uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  chat_id           uuid not null references public.tg_outreach_warmup_chats(id) on delete cascade,
  kind              text not null check (kind in ('reply','reaction')),
  planned_at        timestamptz not null,
  status            text not null default 'pending'
                    check (status in ('pending','running','done','failed','skipped')),
  started_at        timestamptz,
  finished_at       timestamptz,
  target_message_id bigint,
  -- Отрывок сообщения, на которое отвечали. Без него журнал показывает ответ
  -- в пустоту: исходное сообщение из Telegram задним числом не достать.
  target_excerpt    text,
  content           text,
  error_reason      text,
  created_at        timestamptz not null default now()
);

create index if not exists tg_outreach_warmup_activities_due_idx
  on public.tg_outreach_warmup_activities (run_id, day_no, status, planned_at);

create index if not exists tg_outreach_warmup_activities_account_idx
  on public.tg_outreach_warmup_activities (campaign_id, account_id, planned_at desc);

comment on table public.tg_outreach_warmup_activities is
  'Ответы и реакции аккаунтов в публичных чатах. Реакций планируется заметно больше, чем ответов: реакция никого не раздражает, а каждый публичный ответ — шанс на жалобу.';

alter table public.tg_outreach_warmup_chats enable row level security;
alter table public.tg_outreach_warmup_chat_members enable row level security;
alter table public.tg_outreach_warmup_activities enable row level security;

create policy tg_outreach_warmup_chats_select_all on public.tg_outreach_warmup_chats
  for select to authenticated using (true);
create policy tg_outreach_warmup_chat_members_select_all on public.tg_outreach_warmup_chat_members
  for select to authenticated using (true);
create policy tg_outreach_warmup_activities_select_all on public.tg_outreach_warmup_activities
  for select to authenticated using (true);

-- Список чатов ведёт оператор из интерфейса, поэтому на нём нужны и write-права
-- для authenticated. Участие и активности пишет только воркер под service_role.
create policy tg_outreach_warmup_chats_insert on public.tg_outreach_warmup_chats
  for insert to authenticated with check (true);
create policy tg_outreach_warmup_chats_update on public.tg_outreach_warmup_chats
  for update to authenticated using (true) with check (true);
create policy tg_outreach_warmup_chats_delete on public.tg_outreach_warmup_chats
  for delete to authenticated using (true);

grant all on public.tg_outreach_warmup_chats to service_role;
grant all on public.tg_outreach_warmup_chat_members to service_role;
grant all on public.tg_outreach_warmup_activities to service_role;

grant select, insert, update, delete on public.tg_outreach_warmup_chats to authenticated;
grant select on public.tg_outreach_warmup_chat_members to authenticated;
grant select on public.tg_outreach_warmup_activities to authenticated;
