-- ENG («Движок вертикалей», self-serve кабинет app.outreachos.xyz): гейт
-- платных шагов. Три вещи, и все только для ENG-контура — RU-регистрация,
-- RU-кабинет, RU staff-инструмент и verticalEngineV2 их не читают и не пишут.
--
-- 1. he_eng_email_verifications — подтверждение почты ENG-клиента.
--    Регистрация оставляет пользователя email_confirm: true (вход работает
--    сразу), а подтверждение адреса своей ссылкой живёт здесь
--    (app/src/lib/hypothesisEngine/engEmailVerification.ts). Платные шаги
--    кабинета ждут его (engPaidAccess.requireEngPaidAccess):
--      - строки нет — не подтверждена;
--      - verified_at задан — подтверждена ДЛЯ АДРЕСА email (сменили адрес
--        профиля — подтверждать новый);
--      - token_hash — SHA-256 одноразового nonce последней ссылки; новая
--        отправка его заменяет, переход по ссылке стирает;
--      - last_sent_at — когда письмо со ссылкой принял почтовый сервер
--        (кабинет пишет «мы отправили ссылку на …» только по нему).
--
--    СУЩЕСТВУЮЩИЕ АККАУНТЫ — решение этой миграции (бэкфилл ниже):
--      - ENG-клиент (profiles.role = 'client', market = 'eng'), у которого уже
--        есть хоть один проект he_projects, считается подтверждённым: он уже
--        работал в кабинете, и гейт не должен остановить его посреди работы;
--      - ENG-клиент БЕЗ проектов — должен подтвердить почту перед первым
--        платным шагом (кнопка «Send a new link» в кабинете): платить за него
--        мы ещё не начинали;
--      - аккаунт, созданный между накатом этой миграции и выкатом кода:
--          · без проекта — строки нет, подтверждает почту ссылкой, как любой
--            новый;
--          · с проектом, который он создал старым кодом в этом окне, —
--            получает строку повторным прогоном той же вставки сразу после
--            выката кода (шаг 4 заметок выката): вставка идемпотентна (on
--            conflict do nothing), а после выката гейт не даёт создать проект
--            без подтверждённой почты, так что повтор доходит только до окна.
--            Так же — аккаунт старше миграции, создавший первый проект в этом
--            окне.
--    Строку бэкфилла отличает verified_at = created_at (время наката); у
--    подтверждённой ссылкой verified_at позже created_at.
--
-- 2. he_eng_rate_events + he_eng_rate_hit — общий для всех процессов portal
--    счётчик частоты (app/src/lib/hypothesisEngine/engRateLimit.ts):
--    регистрации с ENG-хоста по IP и по адресу, повторная отправка ссылки и
--    неудачные запуски шаблона из кабинета (ведро задаёт код, колонка bucket
--    без CHECK).
--    Ключ — HMAC от IP/адреса/пользователя, сами значения сюда не пишутся.
--    Функция под advisory-замком ключа считает попадания в окне и пишет новое,
--    только если лимит не достигнут; заодно убирает старые записи ключа и до
--    200 записей старше двух суток (окна счётчиков не длиннее суток).
--
-- 3. he_client_provider_spend_sum — известный расход КЛИЕНТА по журналу
--    he_provider_usage: сумма he_provider_spend_sum (20261009_0001) по всем
--    его проектам he_projects (created_by = клиент, market = 'us'). Читает
--    потолок расхода клиента (engClientSpend.ts, HE_US_CLIENT_SPEND_CAP_USD /
--    HE_US_CLIENT_DAY_SPEND_CAP_USD, ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН — тогда функцию не
--    зовёт никто). Правила разбора строки — ровно те же: функция их не
--    повторяет, а зовёт he_provider_spend_sum на каждый проект (отбор по
--    request_id через idx_application_logs_request_id).
--
-- ПРАВА. Таблицы и функции — только service_role (роуты Next и воркер);
-- anon/authenticated отзываются поимённо (линт
-- app/tests/migrations/grants.test.ts). RLS включён без политик. Функции —
-- security invoker, set search_path = '', все имена квалифицированы.
--
-- ПОРЯДОК ВЫКАТА: миграция ДО кода. Код без неё не ломается: нет таблицы
-- подтверждений — проверка почты пропускается (как до правки) и письмо не
-- уходит; нет he_eng_rate_hit — счётчик в памяти процесса; нет
-- he_client_provider_spend_sum — потолок клиента «неизвестен», пускает.
--
-- Идемпотентна: if not exists / create or replace / on conflict do nothing,
-- отзыв и выдача прав повторяются без ошибок.

-- ─── 1. Подтверждение почты ──────────────────────────────────────────────

create table if not exists public.he_eng_email_verifications (
  user_id      uuid primary key references public.profiles(id) on delete cascade,
  -- Адрес, на который ушла последняя ссылка / который подтверждён (lowercase).
  email        text not null check (email <> ''),
  verified_at  timestamptz,
  token_hash   text,
  last_sent_at timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.he_eng_email_verifications is
  'ENG: подтверждение почты клиента своей ссылкой (вход работает и без него, ждут платные шаги кабинета). Нет строки — не подтверждена.';
comment on column public.he_eng_email_verifications.token_hash is
  'SHA-256 одноразового nonce последней отправленной ссылки; null — ссылки нет или она погашена.';

insert into public.he_eng_email_verifications (user_id, email, verified_at, created_at)
select p.id,
       lower(p.email),
       now(),
       now()
  from public.profiles p
 where p.role = 'client'
   and p.market = 'eng'
   and coalesce(p.email, '') <> ''
   and exists (select 1 from public.he_projects h where h.created_by = p.id)
on conflict (user_id) do nothing;

alter table public.he_eng_email_verifications enable row level security;

revoke all privileges on table public.he_eng_email_verifications from public, anon, authenticated;
grant all on table public.he_eng_email_verifications to service_role, postgres;

-- ─── 2. Счётчик частоты ──────────────────────────────────────────────────

create table if not exists public.he_eng_rate_events (
  id         bigint generated always as identity primary key,
  bucket     text not null check (bucket <> ''),
  key_hash   text not null check (key_hash <> ''),
  created_at timestamptz not null default now()
);

create index if not exists idx_he_eng_rate_events_bucket_key
  on public.he_eng_rate_events(bucket, key_hash, created_at);

comment on table public.he_eng_rate_events is
  'ENG: попадания счётчиков частоты (регистрация с ENG-хоста, повторная отправка ссылки подтверждения). key_hash — HMAC, не IP и не адрес. Пишет и чистит he_eng_rate_hit.';

alter table public.he_eng_rate_events enable row level security;

revoke all privileges on table public.he_eng_rate_events from public, anon, authenticated;
grant all on table public.he_eng_rate_events to service_role, postgres;

create or replace function public.he_eng_rate_hit(
  p_bucket text,
  p_key_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns table(allowed boolean, hits bigint, retry_after_seconds integer)
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_since  timestamptz;
  v_hits   bigint;
  v_oldest timestamptz;
begin
  if coalesce(p_bucket, '') = '' or coalesce(p_key_hash, '') = '' then
    raise exception 'he_eng_rate_hit: bucket and key are required';
  end if;
  if p_limit is null or p_limit < 1 then
    raise exception 'he_eng_rate_hit: limit must be >= 1';
  end if;
  -- Окно не длиннее суток: уборка ниже удаляет записи старше двух суток.
  if p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    raise exception 'he_eng_rate_hit: window must be 1..86400 seconds';
  end if;

  -- Один ключ — по очереди: иначе два параллельных запроса оба увидели бы
  -- свободное место и оба записались.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('he_eng_rate_hit'),
    pg_catalog.hashtext(p_bucket || ':' || p_key_hash)
  );

  v_since := pg_catalog.now() - pg_catalog.make_interval(secs => p_window_seconds);

  delete from public.he_eng_rate_events e
   where e.bucket = p_bucket
     and e.key_hash = p_key_hash
     and e.created_at < v_since;

  select pg_catalog.count(*), pg_catalog.min(e.created_at)
    into v_hits, v_oldest
    from public.he_eng_rate_events e
   where e.bucket = p_bucket
     and e.key_hash = p_key_hash;

  if v_hits >= p_limit then
    return query select
      false,
      v_hits,
      greatest(
        1,
        pg_catalog.ceil(
          extract(epoch from (v_oldest + pg_catalog.make_interval(secs => p_window_seconds) - pg_catalog.now()))
        )::integer
      );
    return;
  end if;

  insert into public.he_eng_rate_events (bucket, key_hash) values (p_bucket, p_key_hash);

  -- Ключи, которые больше не приходят, сами себя не уберут: понемногу
  -- подчищаем старое на каждом попадании (по id — старые записи впереди).
  delete from public.he_eng_rate_events e
   where e.id in (
     select o.id
       from public.he_eng_rate_events o
      where o.created_at < pg_catalog.now() - interval '2 days'
      order by o.id
      limit 200
   );

  return query select true, v_hits + 1, 0;
end;
$$;

comment on function public.he_eng_rate_hit(text, text, integer, integer) is
  'ENG: попадание счётчика частоты. allowed=false — лимит в окне достигнут (ничего не записано), retry_after_seconds — когда освободится место.';

revoke all on function public.he_eng_rate_hit(text, text, integer, integer)
  from public, anon, authenticated;
grant execute on function public.he_eng_rate_hit(text, text, integer, integer)
  to service_role, postgres;

-- ─── 3. Расход клиента ───────────────────────────────────────────────────

create or replace function public.he_client_provider_spend_sum(
  p_user_id uuid,
  p_from timestamptz default null,
  p_to timestamptz default null
)
returns table(
  priced_usd numeric,
  serper_credits numeric,
  requesty_unpriced bigint,
  serper_calls bigint,
  serper_credits_unknown bigint,
  lost_rows numeric,
  calls bigint,
  skipped_rows bigint,
  projects bigint
)
language sql
stable
set search_path = ''
as $$
  select
    coalesce(pg_catalog.sum(s.priced_usd), 0)::numeric,
    coalesce(pg_catalog.sum(s.serper_credits), 0)::numeric,
    coalesce(pg_catalog.sum(s.requesty_unpriced), 0)::bigint,
    coalesce(pg_catalog.sum(s.serper_calls), 0)::bigint,
    coalesce(pg_catalog.sum(s.serper_credits_unknown), 0)::bigint,
    coalesce(pg_catalog.sum(s.lost_rows), 0)::numeric,
    coalesce(pg_catalog.sum(s.calls), 0)::bigint,
    coalesce(pg_catalog.sum(s.skipped_rows), 0)::bigint,
    pg_catalog.count(p.id)::bigint
  from public.he_projects p
  cross join lateral public.he_provider_spend_sum(p.id::text, p_from, p_to) s
  where p.created_by = p_user_id
    and p.market = 'us';
$$;

comment on function public.he_client_provider_spend_sum(uuid, timestamptz, timestamptz) is
  'ENG: известный расход клиента — he_provider_spend_sum, сложенная по его проектам рынка us (created_by), за всё время или за окно [p_from, p_to). Нижняя граница, как у функции проекта.';

revoke all on function public.he_client_provider_spend_sum(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.he_client_provider_spend_sum(uuid, timestamptz, timestamptz)
  to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_eng_email_verifications, public.he_eng_rate_events to readonly';
  end if;
end $$;
