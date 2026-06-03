-- TG Outreach: per-proxy health + автосвап прокси у аккаунта.
--
-- Контекст. С 03.06 после перехода на mobile-pool proxy.market воркер начал
-- регулярно ловить «connect timeout (30s)» при подключении и
-- «загрузка диалогов зависла 180с (мёртвый сокет)» при getDialogs. TCP-проба
-- прокси при этом проходит за 80-90мс — то есть до прокси трафик доходит, а
-- MTProto через прокси молчит. Это silent throttle Telegram через mobile-pool
-- IP, помеченный шумной активностью соседей по пулу. У нас сейчас:
--   • прокси привязан к аккаунту 1:1 (account.proxy_id), без ротации
--   • per-proxy cooldown отсутствует (есть только per-account 5h)
--   • cycleDelay захардкожен в 30 секунд — после полного прохода 29 акк
--     идёт всего 30с до следующего захода, что слишком быстро для «горячих» IP
--   • в каждой кампании 101 прокси в tg_outreach_proxies, но реально
--     задействовано ~30 (1:1 с аккаунтами) — ~70% пула простаивает,
--     резерв для автосвапа огромный
--
-- Что делаем:
--   1) Добавляем health-counters на каждый прокси. При 3 подряд timeout/
--      зависании ставим cooldown 30 мин. campaignLoop при выборе прокси
--      смотрит cooldown_until и не использует прокси под отлёжкой.
--   2) Когда у аккаунта прокси уходит в cooldown — автоматически свапаем на
--      свободный прокси из ТОЙ ЖЕ кампании (тот же провайдер / страна / ASN,
--      риск для Telegram минимален). После свапа аккаунт уходит на свой
--      cooldown 30 мин: пусть сессия отлежится на новом IP.
--   3) Если у одного аккаунта 3 РАЗНЫХ прокси подряд дали сбой — это
--      сигнал «проблема в аккаунте, не в прокси» (shadow-ban / auth).
--      Помечаем аккаунт degraded, авто-cooldown 24ч, оператор разбирается.
--   4) Лимит «не больше 2 свапов на аккаунт в сутки» — защита от того, что
--      аккаунт бесконечно прыгает по прокси и привлекает антифрод.
--   5) Cycle delay перестаёт быть hardcode, переезжает в TelegramSettings
--      (JSONB campaigns.telegram_settings) с дефолтом [300, 600] (5-10 мин).

-- ---------------------------------------------------------------------------
-- 1) tg_outreach_proxies — health
-- ---------------------------------------------------------------------------

alter table public.tg_outreach_proxies
  add column if not exists consecutive_errors int not null default 0,
  add column if not exists last_error_at timestamptz,
  -- Категория последней ошибки. UI и фильтры используют для понимания, что за
  -- сигнал — мы видим shutdown/timeout от прокси или silent throttle от
  -- Telegram через прокси.
  add column if not exists last_error_reason text,
  -- Cooldown ставится автоматически после N подряд ошибок ИЛИ вручную
  -- оператором («Подавить прокси»). Воркер не использует прокси, пока
  -- cooldown_until > now().
  add column if not exists cooldown_until timestamptz,
  add column if not exists cooldown_reason text,
  -- Lifetime-статистика. Прокси с total_errors/total_uses > 0.3 — кандидаты
  -- на удаление из пула, видны в UI «Здоровье прокси».
  add column if not exists total_uses bigint not null default 0,
  add column if not exists total_errors bigint not null default 0,
  -- Когда последний раз воркер успешно отработал круг через этот прокси.
  -- Используется для tie-break при выборе «нового» прокси: предпочитаем те,
  -- которые давно не использовались.
  add column if not exists last_used_at timestamptz;

create index if not exists tg_outreach_proxies_health_idx
  on public.tg_outreach_proxies (campaign_id, cooldown_until, last_error_at);

comment on column public.tg_outreach_proxies.consecutive_errors is
  'Сколько подряд раз воркер ловил ошибку (connect timeout / зависание / TIMEOUT) через этот прокси. Сброс — при первом успешном круге.';
comment on column public.tg_outreach_proxies.cooldown_until is
  'До этого момента воркер игнорирует прокси при выборе. NULL = доступен. Ставится автоматом при >=3 consecutive_errors или вручную оператором.';
comment on column public.tg_outreach_proxies.cooldown_reason is
  'Короткий код причины cooldown: auto_consecutive_errors / manual_suppress / etc.';

-- ---------------------------------------------------------------------------
-- 2) tg_outreach_accounts — swap audit + degraded flag
-- ---------------------------------------------------------------------------

alter table public.tg_outreach_accounts
  -- Когда последний раз воркер свапнул прокси у этого аккаунта. Используется
  -- для rate-limit «не больше N свапов в сутки» (защита от антифрода
  -- Telegram: слишком частая смена IP подозрительна).
  add column if not exists last_proxy_swap_at timestamptz,
  add column if not exists proxy_swaps_today int not null default 0,
  -- Если у аккаунта 3 РАЗНЫХ прокси подряд провалились — проблема
  -- скорее всего в аккаунте (shadow-ban / auth issue), не в прокси. Воркер
  -- помечает degraded=true и не пытается дальше.
  add column if not exists degraded boolean not null default false,
  add column if not exists degraded_at timestamptz,
  add column if not exists degraded_reason text,
  -- Сколько прокси подряд провалились у этого аккаунта (с момента последнего
  -- успешного круга). Сбрасывается при первом успешном круге.
  add column if not exists consecutive_proxy_failures int not null default 0;

create index if not exists tg_outreach_accounts_degraded_idx
  on public.tg_outreach_accounts (degraded, cooldown_until)
  where degraded = true;

comment on column public.tg_outreach_accounts.last_proxy_swap_at is
  'Когда последний раз воркер автоматически или оператор вручную поменял proxy_id на этом аккаунте.';
comment on column public.tg_outreach_accounts.degraded is
  'true = у аккаунта 3+ прокси подряд не помогли, скорее всего проблема в самой Telegram-сессии, а не в прокси. Воркер не трогает degraded-аккаунты до ручного снятия флага.';
comment on column public.tg_outreach_accounts.consecutive_proxy_failures is
  'Сколько прокси подряд провалились (не подключились или getDialogs завис) у этого аккаунта. Сбрасывается на 0 при первом успешном круге.';

-- ---------------------------------------------------------------------------
-- 3) Логи свапа прокси (для аудита)
-- ---------------------------------------------------------------------------

create table if not exists public.tg_outreach_proxy_swaps (
  id              bigint generated always as identity primary key,
  account_id      uuid not null references public.tg_outreach_accounts(id) on delete cascade,
  campaign_id     uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  from_proxy_id   uuid references public.tg_outreach_proxies(id) on delete set null,
  to_proxy_id     uuid references public.tg_outreach_proxies(id) on delete set null,
  reason          text not null,
  triggered_by    text not null default 'worker' check (triggered_by in ('worker','operator')),
  -- UUID оператора если triggered_by='operator', иначе NULL.
  operator_id     uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now()
);

create index if not exists tg_outreach_proxy_swaps_account_idx
  on public.tg_outreach_proxy_swaps (account_id, created_at desc);
create index if not exists tg_outreach_proxy_swaps_campaign_idx
  on public.tg_outreach_proxy_swaps (campaign_id, created_at desc);

alter table public.tg_outreach_proxy_swaps enable row level security;

create policy tg_outreach_proxy_swaps_select_all on public.tg_outreach_proxy_swaps
  for select to authenticated using (true);
create policy tg_outreach_proxy_swaps_insert_own on public.tg_outreach_proxy_swaps
  for insert to authenticated
  with check (
    exists (
      select 1 from public.tg_outreach_campaigns c
      where c.id = campaign_id and c.user_id = auth.uid()
    )
  );

comment on table public.tg_outreach_proxy_swaps is
  'История смены прокси на аккаунтах. Заполняется воркером (автоматический свап при cooldown) и API (ручной свап). Нужно для разбора инцидентов — почему аккаунт ушёл в AUTH_KEY_DUPLICATED через час после свапа и т.п.';

-- ---------------------------------------------------------------------------
-- 4) RPC для атомарного дневного счётчика proxy_swaps_today
-- ---------------------------------------------------------------------------

create or replace function public.tg_outreach_swap_proxy(
  p_account_id      uuid,
  p_from_proxy_id   uuid,
  p_to_proxy_id     uuid,
  p_reason          text,
  p_max_per_day     int default 2
)
returns table(
  swapped        boolean,
  swap_id        bigint,
  swaps_today    int,
  refusal_reason text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign_id uuid;
  v_last_swap   timestamptz;
  v_today_count int;
  v_swap_id     bigint;
begin
  select campaign_id, last_proxy_swap_at, proxy_swaps_today
    into v_campaign_id, v_last_swap, v_today_count
    from tg_outreach_accounts
   where id = p_account_id
   for update;

  if v_campaign_id is null then
    return query select false, null::bigint, 0, 'account_not_found';
    return;
  end if;

  -- Сброс счётчика на новый день. Сравниваем по дате (по utc) — упрощает,
  -- timezone аккаунта не важен здесь, важна равномерность 24h окна.
  if v_last_swap is null or date(v_last_swap at time zone 'utc') < date(now() at time zone 'utc') then
    v_today_count := 0;
  end if;

  if v_today_count >= p_max_per_day then
    return query select false, null::bigint, v_today_count, 'daily_limit_reached';
    return;
  end if;

  -- Атомарно: меняем proxy_id, инкрементим счётчик, пишем audit-row.
  update tg_outreach_accounts
     set proxy_id = p_to_proxy_id,
         last_proxy_swap_at = now(),
         proxy_swaps_today = v_today_count + 1
   where id = p_account_id;

  insert into tg_outreach_proxy_swaps
    (account_id, campaign_id, from_proxy_id, to_proxy_id, reason, triggered_by)
  values
    (p_account_id, v_campaign_id, p_from_proxy_id, p_to_proxy_id, p_reason, 'worker')
  returning id into v_swap_id;

  return query select true, v_swap_id, v_today_count + 1, null::text;
end;
$$;

grant execute on function public.tg_outreach_swap_proxy(uuid, uuid, uuid, text, int) to authenticated, service_role;

comment on function public.tg_outreach_swap_proxy is
  'Атомарный свап прокси у аккаунта с дневным лимитом и audit-row в tg_outreach_proxy_swaps. Используется воркером для автосвапа при cooldown прокси; оператор делает это через отдельный API-эндпоинт (без RPC).';
