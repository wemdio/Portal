-- ENG («Движок вертикалей», self-serve кабинет): адрес из «Do not contact»
-- снимается и с УЖЕ ИДУЩИХ кампаний клиента.
--
-- РЕШЕНИЕ ВЛАДЕЛЬЦА 14.10.2026: «да» — когда клиент добавляет адрес в список,
-- этого человека убираем из его идущих кампаний. Список сам по себе
-- (client_blocked_contacts, БД рассыльщика) только отсекает НОВЫЕ загрузки.
-- Код: app/src/lib/hypothesisEngine/engDncRemoval.ts, работает только с
-- HE_ENG_DNC_REMOVE=1 в окружении portal и воркера hypothesis-engine (по
-- умолчанию выключено: ни одной записи сюда, ни одного вызова рассыльщика).
--
-- ЧТО ЗДЕСЬ.
--
-- 1. he_eng_dnc_intents — заявка «эти адреса клиент только что вставил».
--    Пишется роутом POST /api/client/blocklist (ENG-ветка) ДО вставки в
--    список, одной строкой на запрос (до 1000 адресов); created_at — момент
--    просьбы клиента по часам приложения (роут пишет его сам, им же меряются
--    settled_at строк, см. п. 3). Роут сразу же разворачивает заявку в строки
--    he_eng_dnc_removals и удаляет; не вышло (кампании клиента не прочитались,
--    процесс умер) — заявка остаётся, и её разворачивает воркер (next_at
--    ставится на 2 мин вперёд, чтобы не делать это одновременно с роутом).
--    Разворачиваются только адреса, которые В МОМЕНТ разворота стоят в списке
--    клиента. status: 'pending' — ждёт; 'after_launch' — разложена, но у
--    клиента в этот момент шёл запуск (строка he_eng_auto_launch 'running' с
--    живой арендой или launch_info.running_until в будущем): запуск прочитал
--    список до добавления и ещё может загрузить этих людей, поэтому заявка
--    остаётся, воркер раз в 2 мин смотрит, кончился ли запуск, и тогда
--    раскладывает её ЗАНОВО с since = момент разворота (проверены будут и
--    кампании, проверенные во время запуска, и новые); 'failed' — не
--    развернулась за 10 попыток или запуск не кончился за 6 ч от watch_from
--    (когда заявка впервые увидела идущий запуск; команде алерт). Развёрнутая
--    заявка удаляется.
--      skip_campaign_id — только у Block на Replies (заявка ровно на один
--    адрес): кампания, на которую человек ответил. Она уже перестала ему
--    писать (каждая кампания кабинета — stop on reply), поэтому её не
--    проверяют и запись лида в ней не удаляют (удаление ответившего лида
--    могло бы изменить счётчики ответов кампании — это не проверено).
--
-- 2. he_eng_dnc_removals — по строке на адрес × кампанию клиента:
--      workspace  — воркспейс рассыльщика, в котором кампания нашлась при
--                   удачном чтении (he_eng_campaign_status.instantly_account_id),
--                   иначе воркспейс пресета записи о запуске; воркер пишет сюда
--                   тот, в котором действовал;
--      status     — 'queued' ждёт; 'done' лид найден, удалён, и проверочный
--                   поиск его в кампании больше не видит; 'not_found' адреса в
--                   кампании нет (или кампании нет в воркспейсе её удачного
--                   чтения); 'cancelled' клиент убрал адрес из списка;
--                   'failed' не вышло за 10 попыток или кампании больше нет в
--                   записях клиента (команде алерт);
--      attempts   — сколько раз строку брал воркер (берёт — сразу +1);
--      next_at    — когда строку можно брать снова (взятая — аренда на 10 мин);
--      lead_ids   — id записей лида, которым воркер отправил удаление (у
--                   'done' — удалённые; у 'queued' — удаление ушло, а исход не
--                   подтвердился, следующая попытка его досмотрит);
--      settled_at — когда строка вышла из 'queued' (null ⇔ 'queued'), по часам
--                   приложения.
--
-- 3. he_eng_dnc_enqueue(user, emails[], campaigns jsonb, since, skip) — каждое
--    добавление адреса (вставка, Block, повтор) — это просьба проверить ВСЕ
--    кампании клиента заново (кроме skip, см. ниже):
--      - строки адрес × кампания, которых нет, вставляются;
--      - строки, вышедшие из очереди ДО просьбы (settled_at <= since: 'done',
--        'not_found', 'cancelled', 'failed'), возвращаются в очередь
--        (attempts 0, lead_ids null). Так человек, попавший в кампанию после
--        прошлой проверки (адрес убирали из списка, запуск успел загрузить
--        его до добавления), снова будет найден;
--      - строки 'queued' и строки, вышедшие из очереди ПОСЛЕ просьбы (их уже
--        проверили, пока адрес стоял в списке), не трогаются — повторный
--        разворот той же заявки ничего не делает;
--      - адреса, которые сейчас разложены, вычёркиваются из заявок 'failed'
--        этого клиента (пустая заявка удаляется): не развернувшаяся прежде
--        заявка больше не висит на странице как «не удалось». Это делается и
--        при пустом списке кампаний. Порядок безопасен при двух одновременных
--        вызовах: сначала update заявок, у которых остаётся хоть один адрес
--        (условие перепроверяется на версии строки, которую успел сократить
--        другой вызов, — пустым массив не станет), потом delete заявок, все
--        адреса которых разложены;
--      - p_skip_campaign (только с одним адресом; кампания, на которую человек
--        ответил, Block на Replies): строки адрес × эта кампания не
--        вставляются, а её строки 'queued' и 'failed' этого адреса становятся
--        'cancelled' (last_error 'replied'): кампания ему уже не пишет. Роут
--        передаёт её, только если она есть в записях о запуске клиента.
--    Возвращает число вставленных и возвращённых в очередь строк.
--
-- 4. he_eng_dnc_claim(limit, lease_seconds) — взять до limit строк, которым
--    пора, по кругу клиентов (сначала самая старая строка каждого клиента,
--    потом вторая…), attempts + 1, next_at = now() + аренда. Две заявки одну
--    строку не получают: update перепроверяет условие под блокировкой строки.
--
-- 5. he_eng_dnc_summary(user) — для страницы: сколько РАЗНЫХ адресов клиента
--    ждут (строки 'queued' и заявки 'pending' и 'after_launch'), и до 1000 пар «адрес,
--    кампания» строк 'failed' и адресов заявок 'failed' (кампания null) с
--    признаком, что их больше. Что из этого клиенту показать, решает роут: он
--    оставляет только адреса, которые всё ещё в списке, и кампании, которые
--    всё ещё в записях клиента и не завершены и не пропали у рассыльщика
--    (engDncRemoval.readHeEngDncSummary). Так «не удалось» гаснет само, когда
--    адрес убран из списка, добавлен заново (п. 3) или кампании больше нет.
--
-- ПРАВА. Только service_role (роут Next, воркер); public / anon /
-- authenticated отозваны поимённо (линт app/tests/migrations/grants.test.ts).
-- RLS включён без политик. Функции — security invoker, set search_path = ''.
--
-- ПОРЯДОК ВЫКАТА: миграция ДО включения HE_ENG_DNC_REMOVE. Код с выключенной
-- переменной таблиц не читает. Идемпотентна: if not exists / create or replace,
-- повторяемые revoke/grant/comment; черновые сигнатуры he_eng_dnc_enqueue (без
-- since и без skip; нигде не применялись) снимаются drop function if exists —
-- иначе вызов с именованными аргументами был бы неоднозначен. В транзакции.

-- ─── 1. Заявки ───────────────────────────────────────────────────────────

create table if not exists public.he_eng_dnc_intents (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  emails     text[] not null check (cardinality(emails) between 1 and 1000),
  status     text not null default 'pending' check (status in ('pending', 'after_launch', 'failed')),
  attempts   integer not null default 0 check (attempts >= 0),
  next_at    timestamptz not null default now(),
  last_error text,
  skip_campaign_id text check (skip_campaign_id is null or skip_campaign_id <> ''),
  watch_from timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint he_eng_dnc_intents_skip_one check (skip_campaign_id is null or cardinality(emails) = 1)
);

create index if not exists idx_he_eng_dnc_intents_due
  on public.he_eng_dnc_intents (next_at)
  where status in ('pending', 'after_launch');
create index if not exists idx_he_eng_dnc_intents_user
  on public.he_eng_dnc_intents (user_id);

comment on table public.he_eng_dnc_intents is
  'ENG «Do not contact»: адреса, вставленные клиентом, ещё не развёрнутые в строки he_eng_dnc_removals (engDncRemoval.ts). pending — ждёт, after_launch — разложена во время запуска клиента и будет разложена заново, когда он кончится, failed — не развернулась (алерт). skip_campaign_id — кампания, на которую человек ответил (Block на Replies): её не проверяют.';

alter table public.he_eng_dnc_intents enable row level security;

revoke all privileges on table public.he_eng_dnc_intents from public, anon, authenticated;
grant all on table public.he_eng_dnc_intents to service_role, postgres;

-- ─── 2. Очередь снятия ───────────────────────────────────────────────────

create table if not exists public.he_eng_dnc_removals (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  email       text not null check (email <> '' and email = lower(btrim(email))),
  campaign_id text not null check (campaign_id <> ''),
  workspace   text,
  status      text not null default 'queued'
              check (status in ('queued', 'done', 'not_found', 'cancelled', 'failed')),
  attempts    integer not null default 0 check (attempts >= 0),
  next_at     timestamptz not null default now(),
  last_error  text,
  lead_ids    text[],
  settled_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint he_eng_dnc_removals_unique unique (user_id, email, campaign_id),
  constraint he_eng_dnc_removals_settled_shape check ((status = 'queued') = (settled_at is null))
);

create index if not exists idx_he_eng_dnc_removals_due
  on public.he_eng_dnc_removals (user_id, next_at)
  where status = 'queued';

comment on table public.he_eng_dnc_removals is
  'ENG «Do not contact»: снять адрес с идущей кампании клиента — строка на адрес × кампанию из записей о запуске клиента (engDncRemoval.ts, воркер hypothesis-engine).';

alter table public.he_eng_dnc_removals enable row level security;

revoke all privileges on table public.he_eng_dnc_removals from public, anon, authenticated;
grant all on table public.he_eng_dnc_removals to service_role, postgres;

-- ─── 3. Постановка в очередь ─────────────────────────────────────────────

drop function if exists public.he_eng_dnc_enqueue(uuid, text[], jsonb);
drop function if exists public.he_eng_dnc_enqueue(uuid, text[], jsonb, timestamptz);

create or replace function public.he_eng_dnc_enqueue(
  p_user_id uuid,
  p_emails text[],
  p_campaigns jsonb,
  p_since timestamptz,
  p_skip_campaign text default null
)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_emails text[];
  v_skip text := nullif(pg_catalog.btrim(p_skip_campaign), '');
  v_count integer;
begin
  if p_user_id is null or coalesce(pg_catalog.cardinality(p_emails), 0) = 0 then
    return 0;
  end if;
  if p_since is null then
    raise exception 'he_eng_dnc_enqueue: p_since is required';
  end if;
  if p_campaigns is null or pg_catalog.jsonb_typeof(p_campaigns) <> 'array' then
    raise exception 'he_eng_dnc_enqueue: p_campaigns must be a json array';
  end if;
  if pg_catalog.cardinality(p_emails)::bigint * pg_catalog.jsonb_array_length(p_campaigns) > 20000 then
    raise exception 'he_eng_dnc_enqueue: at most 20000 rows per call';
  end if;

  select coalesce(pg_catalog.array_agg(distinct pg_catalog.lower(pg_catalog.btrim(x))), '{}'::text[])
    into v_emails
    from pg_catalog.unnest(p_emails) as x
   where coalesce(pg_catalog.btrim(x), '') <> '';
  if pg_catalog.cardinality(v_emails) = 0 then
    return 0;
  end if;
  if v_skip is not null and pg_catalog.cardinality(v_emails) <> 1 then
    raise exception 'he_eng_dnc_enqueue: p_skip_campaign needs exactly one address';
  end if;

  -- Заявки 'failed': разложенные сейчас адреса больше не «не удалось».
  -- Сначала update заявок, у которых остаётся хоть один адрес, потом delete
  -- заявок, все адреса которых разложены. Обратный порядок под конкуренцией
  -- давал пустой массив (нарушение check, отказ всего вызова): delete видел
  -- заявку [a,b] целой, а update, дождавшись блокировки строки, перепроверял
  -- условие на версии [b], которую сократил одновременный вызов с адресом a, и
  -- вычёркивал последний адрес. Теперь update на такой версии не срабатывает
  -- (второе exists), а delete — отдельный оператор со свежим снимком — видит
  -- уже сокращённую заявку и удаляет её.
  update public.he_eng_dnc_intents i
     set emails = array(
           select y
             from pg_catalog.unnest(i.emails) as y
            where not (coalesce(pg_catalog.lower(pg_catalog.btrim(y)), '') = any (v_emails))
         ),
         updated_at = pg_catalog.now()
   where i.user_id = p_user_id
     and i.status = 'failed'
     and exists (
       select 1
         from pg_catalog.unnest(i.emails) as y
        where coalesce(pg_catalog.lower(pg_catalog.btrim(y)), '') = any (v_emails)
     )
     and exists (
       select 1
         from pg_catalog.unnest(i.emails) as y
        where not (coalesce(pg_catalog.lower(pg_catalog.btrim(y)), '') = any (v_emails))
     );
  delete from public.he_eng_dnc_intents i
   where i.user_id = p_user_id
     and i.status = 'failed'
     and not exists (
       select 1
         from pg_catalog.unnest(i.emails) as y
        where not (coalesce(pg_catalog.lower(pg_catalog.btrim(y)), '') = any (v_emails))
     );

  -- Кампания, на которую человек ответил (Block на Replies): она ему уже не
  -- пишет — её строки этого адреса, ждущие или неудавшиеся, закрываются.
  if v_skip is not null then
    update public.he_eng_dnc_removals r
       set status     = 'cancelled',
           settled_at = p_since,
           last_error = 'replied',
           updated_at = pg_catalog.now()
     where r.user_id = p_user_id
       and r.email = any (v_emails)
       and r.campaign_id = v_skip
       and r.status in ('queued', 'failed');
  end if;

  if pg_catalog.jsonb_array_length(p_campaigns) = 0 then
    return 0;
  end if;

  with src as (
    select distinct on (e.email, c.campaign_id) e.email, c.campaign_id, c.workspace
      from pg_catalog.unnest(v_emails) as e(email)
      cross join (
        select v ->> 'campaign_id' as campaign_id, nullif(v ->> 'workspace', '') as workspace
          from pg_catalog.jsonb_array_elements(p_campaigns) as v
      ) c
     where coalesce(c.campaign_id, '') <> ''
       and c.campaign_id is distinct from v_skip
     order by e.email, c.campaign_id, c.workspace nulls last
  ), up as (
    insert into public.he_eng_dnc_removals as r (user_id, email, campaign_id, workspace)
    select p_user_id, src.email, src.campaign_id, src.workspace
      from src
    on conflict (user_id, email, campaign_id) do update
       set status     = 'queued',
           attempts   = 0,
           next_at    = pg_catalog.now(),
           last_error = null,
           lead_ids   = null,
           settled_at = null,
           updated_at = pg_catalog.now(),
           workspace  = coalesce(excluded.workspace, r.workspace)
     where r.status <> 'queued'
       and r.settled_at <= p_since
    returning 1
  )
  select pg_catalog.count(*)::integer into v_count from up;
  return v_count;
end;
$$;

comment on function public.he_eng_dnc_enqueue(uuid, text[], jsonb, timestamptz, text) is
  'ENG «Do not contact»: строки адрес × кампания в he_eng_dnc_removals; строки, вышедшие из очереди не позже p_since (момент просьбы клиента), — снова в очередь; queued и проверенные после p_since не трогаются; разложенные адреса вычёркиваются из заявок failed; p_skip_campaign (один адрес, кампания ответа) не раскладывается, её queued/failed строки адреса — cancelled. Возвращает число вставленных и возвращённых.';

revoke all on function public.he_eng_dnc_enqueue(uuid, text[], jsonb, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.he_eng_dnc_enqueue(uuid, text[], jsonb, timestamptz, text)
  to service_role, postgres;

-- ─── 4. Взять строки в работу ────────────────────────────────────────────

create or replace function public.he_eng_dnc_claim(
  p_limit integer,
  p_lease_seconds integer
)
returns setof public.he_eng_dnc_removals
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ids uuid[];
begin
  if coalesce(p_limit, 0) <= 0 then
    return;
  end if;

  select coalesce(pg_catalog.array_agg(ranked.id), '{}'::uuid[])
    into v_ids
    from (
      select d.id
        from (
          select r.id, r.next_at, r.created_at,
                 pg_catalog.row_number() over (
                   partition by r.user_id order by r.next_at, r.created_at, r.id
                 ) as rn
            from public.he_eng_dnc_removals r
           where r.status = 'queued'
             and r.next_at <= pg_catalog.now()
        ) d
       order by d.rn, d.next_at, d.created_at, d.id
       limit least(p_limit, 50)
    ) ranked;

  return query
    with claimed as (
      update public.he_eng_dnc_removals r
         set attempts   = r.attempts + 1,
             next_at    = pg_catalog.now()
                          + pg_catalog.make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60)),
             updated_at = pg_catalog.now()
       where r.id = any (v_ids)
         and r.status = 'queued'
         and r.next_at <= pg_catalog.now()
      returning r.*
    )
    select * from claimed;
end;
$$;

comment on function public.he_eng_dnc_claim(integer, integer) is
  'ENG «Do not contact»: взять до p_limit строк очереди, которым пора, по кругу клиентов; attempts + 1 и аренда next_at.';

revoke all on function public.he_eng_dnc_claim(integer, integer)
  from public, anon, authenticated;
grant execute on function public.he_eng_dnc_claim(integer, integer)
  to service_role, postgres;

-- ─── 5. Сводка для страницы ──────────────────────────────────────────────

create or replace function public.he_eng_dnc_summary(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with pending as (
    select r.email
      from public.he_eng_dnc_removals r
     where r.user_id = p_user_id and r.status = 'queued'
    union
    select pg_catalog.lower(pg_catalog.btrim(x))
      from public.he_eng_dnc_intents i
      cross join pg_catalog.unnest(i.emails) as x
     where i.user_id = p_user_id and i.status in ('pending', 'after_launch')
  ), failed as (
    select r.email, r.campaign_id
      from public.he_eng_dnc_removals r
     where r.user_id = p_user_id and r.status = 'failed'
    union
    select pg_catalog.lower(pg_catalog.btrim(x)), null::text
      from public.he_eng_dnc_intents i
      cross join pg_catalog.unnest(i.emails) as x
     where i.user_id = p_user_id and i.status = 'failed'
  ), capped as (
    select f.email, f.campaign_id
      from failed f
     order by f.email, f.campaign_id nulls first
     limit 1001
  ), shown as (
    select c.email, c.campaign_id
      from capped c
     order by c.email, c.campaign_id nulls first
     limit 1000
  )
  select pg_catalog.jsonb_build_object(
    'pending', (select pg_catalog.count(*) from pending),
    'failed', coalesce(
      (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('email', s.email, 'campaign_id', s.campaign_id))
         from shown s),
      '[]'::jsonb
    ),
    'failed_more', (select pg_catalog.count(*) from capped) > 1000
  );
$$;

comment on function public.he_eng_dnc_summary(uuid) is
  'ENG «Do not contact»: сколько разных адресов клиента ждут проверки кампаний (pending: строки queued, заявки pending и after_launch) и до 1000 пар адрес/кампания со статусом failed (кампания null — неразвёрнутая заявка), failed_more — их больше. Что показать клиенту, решает engDncRemoval.readHeEngDncSummary.';

revoke all on function public.he_eng_dnc_summary(uuid)
  from public, anon, authenticated;
grant execute on function public.he_eng_dnc_summary(uuid)
  to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_eng_dnc_intents to readonly';
    execute 'grant select on public.he_eng_dnc_removals to readonly';
  end if;
end $$;
