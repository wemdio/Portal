-- Прогрев: запомненные собеседники, чтобы не резолвить их заново каждый раз.
--
-- До 09.08.2026 каждая переписка начиналась с поиска собеседника: резолв по
-- @username или импорт телефона в контакты, а после разговора контакт удалялся.
-- За четырёхдневный прогрев на 16 аккаунтов это ~218 циклов «добавил-удалил» по
-- одному и тому же замкнутому кругу номеров — почерк, по которому Telegram ловит
-- сбор контактов. На четвёртом дне аккаунты в него и упёрлись: контактные
-- запросы перестали отвечать (не ошибкой, а молчанием), и 32 из 37 переписок
-- сорвались на поиске собеседника.
--
-- Аккаунты внутри прогрева постоянные и за четыре дня не меняются, поэтому
-- достаточно найти каждого один раз и запомнить.
--
-- Почему в БД, а не в памяти воркера: воркер перезапускается по несколько раз в
-- сутки (деплои, сторожевой таймер), и кэш в памяти обнулялся бы вместе с ним —
-- то есть импорты вернулись бы почти в прежнем объёме.

create table if not exists public.tg_outreach_warmup_peers (
  id                uuid primary key default gen_random_uuid(),
  campaign_id       uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  -- Чьими глазами найден собеседник: access_hash выдаётся под конкретный
  -- аккаунт и другому аккаунту не подходит.
  viewer_account_id uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  target_account_id uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  tg_user_id        text not null,
  -- text, а не bigint: access_hash — 64-битное число, и JSON-слой портала
  -- потерял бы точность на числах больше 2^53.
  access_hash       text not null,
  created_at        timestamptz not null default now(),
  constraint tg_outreach_warmup_peers_distinct check (viewer_account_id <> target_account_id)
);

create unique index if not exists tg_outreach_warmup_peers_unique_idx
  on public.tg_outreach_warmup_peers (viewer_account_id, target_account_id);

create index if not exists tg_outreach_warmup_peers_campaign_idx
  on public.tg_outreach_warmup_peers (campaign_id);

comment on table public.tg_outreach_warmup_peers is
  'Найденные собеседники прогрева. Живут дольше одного прогона: пара аккаунтов та же, а лишний импорт контакта — лишний повод для антифрода Telegram.';

alter table public.tg_outreach_warmup_peers enable row level security;

create policy tg_outreach_warmup_peers_select_all on public.tg_outreach_warmup_peers
  for select to authenticated using (true);

grant all on public.tg_outreach_warmup_peers to service_role;
grant select on public.tg_outreach_warmup_peers to authenticated;
