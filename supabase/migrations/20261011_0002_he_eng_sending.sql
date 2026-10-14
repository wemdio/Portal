-- ENG («Движок вертикалей», self-serve кабинет): письма уходят без сотрудника.
--
-- РЕШЕНИЕ ВЛАДЕЛЬЦА 10–11.10.2026. «Launch» в английском кабинете начинает
-- отправку (кампании не остаются на паузе); клиент сам ставит кампании вертикали
-- на паузу и возобновляет их и видит настоящий статус и счётчики. Пока нет
-- оплаты, отправку НОВОГО аккаунта один раз включает сотрудник (защита от
-- злоупотреблений, а не проверка писем); требование снимается переменной
-- HE_US_SENDING_REQUIRES_ACTIVATION=0 (читает код,
-- app/src/lib/hypothesisEngine/engSendingAccess.ts). Выключение сотрудником
-- действует при любом значении переменной.
--
-- ЧТО ЗДЕСЬ.
--
-- 1. he_eng_sending_access — выключатель отправки аккаунта ENG-клиента.
--    Строка на пользователя (profiles.id):
--      enabled       — отправка включена сотрудником;
--      requested_at  — когда клиент ПЕРВЫЙ раз упёрся в выключатель (запуск или
--                      «Start sending» отказаны) — экран сотрудника показывает,
--                      кто и с какого момента ждёт;
--      enabled_at    — когда включили последний раз;
--      revoked_at    — когда выключили последний раз (клиент видит «sending is
--                      turned off», а не «is being enabled»);
--      email_sent_at — когда клиенту ушло письмо «отправка включена» (экран
--                      сотрудника: дошло ли письмо).
--    СОСТОЯНИЯ (код): enabled=true — включена; enabled=false с revoked_at —
--    выключена сотрудником (отказ всегда, и при снятом требовании); нет строки
--    или enabled=false без revoked_at — «не включена» (запуск отказан, команде
--    алерт). Таблицы нет / не читается — отказ (fail-closed). При снятом
--    требовании строка читается так же, но «не включена», нет таблицы и сбой
--    чтения отправку не держат — держит только выключение.
--    НЕ client_tariffs.is_active: тот флаг читают RU-гейты тарифа, и его
--    включение открыло бы ENG-аккаунту платные RU-инструменты.
--
-- 2. he_eng_launch_sending — что клиент хочет от кампаний ЗАПУСКА шаблона
--    (вертикали): client_state 'sending' (Launch, «Start sending», «Resume») или
--    'paused' («Pause»); changed_at — последнее действие клиента (кабинет
--    печатает дату паузы). Нет строки — клиент отправку этого запуска не
--    запрашивал (запуск до S2, запуск сотрудника, запуск, который роут не стал
--    стартовать). Читают: кабинет (состояние и кнопки), старт (поставленная
--    клиентом пауза не снимается запуском), доводка паузы при чтении статуса и
--    проверка ночного долива createHeRefillSendGate (autoPipeline.ts: не
--    платить за сбор и не грузить адреса в кампании, которые клиент поставил на
--    паузу — в тике до покупки сборки и в доливе до провайдера).
--
-- 3. he_eng_campaign_status — кэш статуса и счётчиков кампании у рассыльщика,
--    общий для всех процессов portal (дашборд поллится раз в 15 с, процессов
--    несколько — живое чтение на каждый полл умножилось бы на
--    WEB_CONCURRENCY):
--      status / status_read_at  — статус кампании (GET /campaigns/{id}) и когда
--                                 он прочитан успешно;
--      sent / replies / counts_read_at — emails_sent_count и reply_count_unique
--                                 (GET /campaigns/analytics?id=) и когда;
--      counts_tried_at          — когда счётчики последний раз ПРОБОВАЛИ
--                                 прочитать (удачно или нет): чтение счётчиков
--                                 не чаще раза в 20 мин и при сбое
--                                 аналитики;
--      counts_status            — статус кампании при последнем удачном
--                                 чтении счётчиков: статус сменился (кто бы
--                                 его ни записал) — счётчики пора перечитать;
--      read_error               — последнее чтение не удалось: 'not_found'
--                                 (кампании у рассыльщика нет) | 'failed';
--                                 null — последнее чтение удачное;
--      refresh_until            — аренда чтения (одно живое чтение кампании на
--                                 все процессы; код берёт её на каждую
--                                 кампанию прямо перед её чтением) и пауза
--                                 после неудачи;
--      start_error              — почему последний старт кампании не удался
--                                 (код, без текста рассыльщика); null — удался
--                                 или не запрашивался. Живое чтение снимает его,
--                                 когда прочитанное больше не соответствует
--                                 причине (engCampaignStatus.ts,
--                                 refreshHeEngCampaignStatuses);
--      instantly_account_id     — воркспейс, в котором рассыльщик кампанию
--                                 ВЕРНУЛ при удачном чтении, старте или паузе;
--                                 null — ни разу. Пауза идёт в этот воркспейс,
--                                 и только там «404» значит «кампании нет»;
--                                 без него пауза идёт в воркспейс пресета
--                                 записи о запуске, и «404» — неудача паузы
--                                 (engCampaignSending.ts).
--
-- 4. he_eng_campaign_status_claim(project, campaign_ids, fresh_seconds,
--    lease_seconds) — завести недостающие строки кэша проекта и ВЗЯТЬ аренду
--    живого чтения у тех, чей статус старше fresh_seconds и у кого нет живой
--    аренды. Возвращает id взятых. Две параллельные заявки одной кампании не
--    получают её обе: update берёт блокировку строки, вторая перепроверяет
--    условие после коммита первой.
--
-- КОД ДО МИГРАЦИИ. Выключатель не читается — запуск и старт отказаны 503
-- («проблема на нашей стороне»), если требование не снято переменной; нет
-- he_eng_launch_sending — старт отказан 503, а пауза у рассыльщика делается
-- (остановить отправку можно всегда), только желание клиента не записано; нет
-- кэша — статус «не прочитан», живых чтений нет вовсе.
--
-- ПРАВА. Только service_role (роуты Next); anon / authenticated / public
-- отозваны поимённо (линт app/tests/migrations/grants.test.ts). RLS включён без
-- политик. Функция — security invoker, set search_path = ''.
--
-- ПОРЯДОК ВЫКАТА: миграция ДО кода. Идемпотентна: if not exists / create or
-- replace, повторяемые revoke/grant/comment. В транзакции.
--
-- РАННЯЯ РЕДАКЦИЯ. Если где-то накатана более ранняя редакция этого файла
-- (без колонок he_eng_campaign_status.instantly_account_id, counts_tried_at,
-- counts_status), файл надо ПРОКАТИТЬ ЕЩЁ РАЗ: create table if not exists
-- таблицу не тронет, а add column if not exists ниже добавит недостающие. До
-- этого код читает и пишет кэш без них (42703 → деградация,
-- engCampaignStatus.ts LEGACY_ROW_COLUMNS): пауза идёт в воркспейс пресета, а
-- счётчики читаются по прежнему, более частому правилу.

-- ─── 1. Выключатель отправки аккаунта ────────────────────────────────────

create table if not exists public.he_eng_sending_access (
  user_id       uuid primary key references public.profiles(id) on delete cascade,
  enabled       boolean not null default false,
  requested_at  timestamptz,
  enabled_at    timestamptz,
  revoked_at    timestamptz,
  email_sent_at timestamptz,
  constraint he_eng_sending_access_enabled_shape check (not enabled or enabled_at is not null)
);

comment on table public.he_eng_sending_access is
  'ENG: выключатель отправки аккаунта (включает сотрудник один раз; HE_US_SENDING_REQUIRES_ACTIVATION=0 снимает требование). Нет строки — не включена.';

alter table public.he_eng_sending_access enable row level security;

revoke all privileges on table public.he_eng_sending_access from public, anon, authenticated;
grant all on table public.he_eng_sending_access to service_role, postgres;

-- ─── 2. Желание клиента по кампаниям запуска ─────────────────────────────

create table if not exists public.he_eng_launch_sending (
  template_id  uuid primary key references public.he_templates(id) on delete cascade,
  client_state text not null check (client_state in ('sending', 'paused')),
  changed_at   timestamptz not null default now()
);

comment on table public.he_eng_launch_sending is
  'ENG: чего клиент хочет от кампаний запуска шаблона — sending (Launch / Start sending / Resume) или paused (Pause). Читают кабинет, старт, доводка паузы и проверка ночного долива (createHeRefillSendGate, autoPipeline.ts).';

alter table public.he_eng_launch_sending enable row level security;

revoke all privileges on table public.he_eng_launch_sending from public, anon, authenticated;
grant all on table public.he_eng_launch_sending to service_role, postgres;

-- ─── 3. Кэш статуса и счётчиков кампании ─────────────────────────────────

create table if not exists public.he_eng_campaign_status (
  campaign_id    text primary key check (campaign_id <> ''),
  project_id     uuid not null references public.he_projects(id) on delete cascade,
  status         smallint,
  status_read_at timestamptz,
  sent           integer check (sent is null or sent >= 0),
  replies        integer check (replies is null or replies >= 0),
  counts_read_at timestamptz,
  counts_tried_at timestamptz,
  counts_status  smallint,
  read_error     text check (read_error is null or read_error in ('not_found', 'failed')),
  refresh_until  timestamptz,
  start_error    text,
  instantly_account_id text
);

-- Повторяемость: таблица могла быть создана прежней редакцией этого файла.
alter table public.he_eng_campaign_status
  add column if not exists instantly_account_id text;
alter table public.he_eng_campaign_status
  add column if not exists counts_tried_at timestamptz;
alter table public.he_eng_campaign_status
  add column if not exists counts_status smallint;

create index if not exists idx_he_eng_campaign_status_project
  on public.he_eng_campaign_status(project_id);

comment on table public.he_eng_campaign_status is
  'ENG: кэш статуса кампании у рассыльщика и её счётчиков (отправлено / ответы) — общий для процессов portal; refresh_until — аренда живого чтения.';

alter table public.he_eng_campaign_status enable row level security;

revoke all privileges on table public.he_eng_campaign_status from public, anon, authenticated;
grant all on table public.he_eng_campaign_status to service_role, postgres;

-- ─── 4. Аренда живого чтения ─────────────────────────────────────────────

create or replace function public.he_eng_campaign_status_claim(
  p_project_id uuid,
  p_campaign_ids text[],
  p_fresh_seconds integer,
  p_lease_seconds integer
)
returns text[]
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_claimed text[];
begin
  if p_project_id is null or coalesce(pg_catalog.cardinality(p_campaign_ids), 0) = 0 then
    return '{}'::text[];
  end if;
  if pg_catalog.cardinality(p_campaign_ids) > 200 then
    raise exception 'he_eng_campaign_status_claim: at most 200 campaigns per call';
  end if;

  insert into public.he_eng_campaign_status (campaign_id, project_id)
  select distinct c, p_project_id
    from pg_catalog.unnest(p_campaign_ids) as c
   where coalesce(c, '') <> ''
  on conflict (campaign_id) do nothing;

  with claimed as (
    update public.he_eng_campaign_status s
       set refresh_until = pg_catalog.now()
                           + pg_catalog.make_interval(secs => greatest(coalesce(p_lease_seconds, 60), 1))
     where s.campaign_id = any (p_campaign_ids)
       and s.project_id = p_project_id
       and (s.refresh_until is null or s.refresh_until <= pg_catalog.now())
       and (s.status_read_at is null
            or s.status_read_at <= pg_catalog.now()
                                   - pg_catalog.make_interval(secs => greatest(coalesce(p_fresh_seconds, 0), 0)))
    returning s.campaign_id
  )
  select coalesce(pg_catalog.array_agg(claimed.campaign_id order by claimed.campaign_id), '{}'::text[])
    into v_claimed
    from claimed;
  return v_claimed;
end;
$$;

comment on function public.he_eng_campaign_status_claim(uuid, text[], integer, integer) is
  'ENG: завести строки кэша кампаний проекта и взять аренду живого чтения у тех, чей статус старше p_fresh_seconds и без живой аренды. Возвращает id взятых.';

revoke all on function public.he_eng_campaign_status_claim(uuid, text[], integer, integer)
  from public, anon, authenticated;
grant execute on function public.he_eng_campaign_status_claim(uuid, text[], integer, integer)
  to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_eng_sending_access to readonly';
    execute 'grant select on public.he_eng_launch_sending to readonly';
    execute 'grant select on public.he_eng_campaign_status to readonly';
  end if;
end $$;
