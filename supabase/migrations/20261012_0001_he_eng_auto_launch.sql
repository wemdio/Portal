-- ENG («Движок вертикалей», self-serve кабинет): ОДНА кнопка «Launch» доводит
-- проект до отправки (S3, решение владельца 10.10.2026: «запуски супер простые,
-- в пару кнопок»).
--
-- Клиент нажимает «Launch» на шаге 3 — кабинет записывает НАМЕРЕНИЕ запустить
-- проект и ставит недостающие платные стадии тем же путём, что «Start outreach»
-- (autopilotReconcile, trigger 'client'). Дальше автопилот воркера доводит
-- каждую выбранную вертикаль до готового шаблона, и тик автозапуска воркера
-- движка (app/src/lib/hypothesisEngine/engAutoLaunch.ts) запускает его ТЕМ ЖЕ
-- вызовом, что кнопка «Launch now» (engClientLaunch.runHeEngTemplateLaunch: все
-- гейты кнопки, старт отправки).
--
-- ЧТО ЗДЕСЬ.
--
-- 1. he_eng_launch_intent — намерение клиента по проекту (строка на проект):
--      user_id      — кто нажал «Launch» (владелец проекта);
--      wanted       — автозапуск включён; «Cancel all jobs» пишет false;
--      schedule     — окно отправки новых кампаний (пояс, часы, дни — четыре
--                     поля кабинета, проверяются кодом при каждом чтении);
--      requested_at — последнее нажатие «Launch»;
--      cancelled_at — последняя отмена (кабинет печатает «выключено с <даты>»);
--      settled_at   — намерение ИСПОЛНЕНО: у каждой выбранной вертикали законченный
--                     запуск без отложенного старта (engAutoLaunch.heEngLaunchSettled).
--                     Тик читает только открытые намерения (wanted и settled_at
--                     is null) проходами с вращающимся курсором; новое «Launch»
--                     пишет null.
--
-- 2. he_eng_auto_launch — состояние автозапуска шаблона (строка на шаблон;
--    шаблон удалён — строка уходит каскадом):
--      state        — 'waiting' (ждёт next_at) | 'running' (взят, lease_until) |
--                     'done' (запуск и старт решены — дальше блок отправки) |
--                     'held' (ждёт внешнего: почта, выключатель, ящики, письма)
--                     | 'failed' (сдался — только новое «Launch» клиента);
--      code         — причина (закрытый словарь кода, HE_ENG_AUTO_LAUNCH_CODES);
--                     на взятой строке — пометки попытки: 'start_pending'
--                     (решено стартовать кампании), 'abandoned' (прошлая
--                     попытка брошена посреди);
--      attempts     — сколько раз строку брали; запись решения, пометки и
--                     продление аренды идут только при том же attempts (чужое
--                     взятие не затирается);
--      retries      — сколько раз ПОДРЯД кончилось тем же кодом (сбой на нашей
--                     стороне, незаконченный запуск, брошенная попытка) — по
--                     нему откат и предел;
--      paid_failures — запуски, упавшие ПОСЛЕ платной части (классификатор
--                     сегментов) или брошенные посреди: после трёх строка
--                     'failed', автозапуск больше не платит;
--      start_retries — повторы одного старта кампаний законченного запуска
--                     (и брошенные попытки старта);
--      next_at      — когда строку можно брать снова (часы БД);
--      lease_until  — до какого момента строку держит взявший (взявший — тик
--                     или «Launch now» — продлевает её, пока запуск идёт).
--
-- 3. he_eng_auto_launch_claim(template, project, lease_seconds, manual) —
--    ВЗЯТЬ строку шаблона атомарно, по часам БД: вставить новую (state
--    'running') или перевести существующую в 'running', если её можно брать.
--    Тик (manual=false) берёт только «пора»: 'waiting'/'held' с next_at <= now()
--    или 'running' с истёкшей арендой. Кнопка «Launch now» (manual=true) берёт
--    любую, кроме 'running' с живой арендой, — так кнопка и тик не запускают
--    один шаблон одновременно (двойные кампании). Возвращает взятую строку;
--    пусто — взять нельзя. Две параллельные заявки одну строку оба не получают:
--    on conflict do update берёт блокировку строки, вторая перепроверяет
--    условие после коммита первой. Взятие меняет только state, attempts,
--    lease_until и updated_at: code, счётчики и next_at остаются — по ним тик
--    узнаёт строку, брошенную прошлой попыткой, и её решение «стартуем».
--
-- КОД ДО МИГРАЦИИ (деградация). Нет таблиц / функции (42P01, PGRST205, 42883,
-- PGRST202): «Launch» проекта по-прежнему ставит стадии (reconcile) и отвечает
-- auto_launch 'unavailable'; тик не делает ничего; кнопка «Launch now» идёт без
-- замка, как до S3. Отправка при этом за всеми гейтами S2 (fail-closed).
--
-- ПРАВА. Только service_role (роуты Next и воркер движка); anon / authenticated
-- / public отозваны поимённо (линт app/tests/migrations/grants.test.ts). RLS
-- включён без политик. Функция — security invoker, set search_path = '', все
-- имена квалифицированы.
--
-- ПОРЯДОК ВЫКАТА: миграция ДО кода (код без неё деградирует, см. выше).
-- Идемпотентна: if not exists / create or replace, повторяемые revoke / grant /
-- comment. Раннер миграций применяет файл одной транзакцией.

-- ─── 1. Намерение клиента ────────────────────────────────────────────────

create table if not exists public.he_eng_launch_intent (
  project_id   uuid primary key references public.he_projects(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  wanted       boolean not null default true,
  schedule     jsonb not null,
  requested_at timestamptz not null default now(),
  cancelled_at timestamptz,
  settled_at   timestamptz,
  updated_at   timestamptz not null default now(),
  constraint he_eng_launch_intent_schedule_shape check (jsonb_typeof(schedule) = 'object')
);

-- Таблица могла быть создана прежней редакцией этого файла (без settled_at).
alter table public.he_eng_launch_intent add column if not exists settled_at timestamptz;

-- Проход тика: открытые намерения по порядку project_id.
create index if not exists idx_he_eng_launch_intent_open
  on public.he_eng_launch_intent(project_id)
  where wanted and settled_at is null;

comment on table public.he_eng_launch_intent is
  'ENG: «Launch» проекта — клиент хочет, чтобы готовые вертикали запускались и начинали отправку сами (engAutoLaunch). wanted=false — отменено «Cancel all jobs».';

alter table public.he_eng_launch_intent enable row level security;

revoke all privileges on table public.he_eng_launch_intent from public, anon, authenticated;
grant all on table public.he_eng_launch_intent to service_role, postgres;

-- ─── 2. Автозапуск шаблона ───────────────────────────────────────────────

create table if not exists public.he_eng_auto_launch (
  template_id   uuid primary key references public.he_templates(id) on delete cascade,
  project_id    uuid not null references public.he_projects(id) on delete cascade,
  state         text not null default 'waiting'
                check (state in ('waiting', 'running', 'done', 'held', 'failed')),
  code          text check (code is null or code <> ''),
  attempts      integer not null default 0 check (attempts >= 0),
  retries       integer not null default 0 check (retries >= 0),
  paid_failures integer not null default 0 check (paid_failures >= 0),
  start_retries integer not null default 0 check (start_retries >= 0),
  next_at       timestamptz not null default now(),
  lease_until   timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists idx_he_eng_auto_launch_project
  on public.he_eng_auto_launch(project_id);

comment on table public.he_eng_auto_launch is
  'ENG: автозапуск шаблона вертикали после «Launch» проекта — состояние, причина, счётчики и аренда (engAutoLaunch.ts). Берётся только he_eng_auto_launch_claim.';

alter table public.he_eng_auto_launch enable row level security;

revoke all privileges on table public.he_eng_auto_launch from public, anon, authenticated;
grant all on table public.he_eng_auto_launch to service_role, postgres;

-- ─── 3. Взять строку ─────────────────────────────────────────────────────

create or replace function public.he_eng_auto_launch_claim(
  p_template_id uuid,
  p_project_id uuid,
  p_lease_seconds integer,
  p_manual boolean default false
)
returns setof public.he_eng_auto_launch
language sql
volatile
security invoker
set search_path = ''
as $$
  insert into public.he_eng_auto_launch as a
    (template_id, project_id, state, attempts, next_at, lease_until, created_at, updated_at)
  values (
    p_template_id,
    p_project_id,
    'running',
    1,
    pg_catalog.now(),
    pg_catalog.now() + pg_catalog.make_interval(secs => greatest(coalesce(p_lease_seconds, 600), 60)),
    pg_catalog.now(),
    pg_catalog.now()
  )
  on conflict (template_id) do update
     set state = 'running',
         attempts = a.attempts + 1,
         lease_until = excluded.lease_until,
         updated_at = pg_catalog.now()
   where a.project_id = excluded.project_id
     and (
       (coalesce(p_manual, false)
          and not (a.state = 'running' and a.lease_until is not null and a.lease_until > pg_catalog.now()))
       or (a.state in ('waiting', 'held') and a.next_at <= pg_catalog.now())
       or (a.state = 'running' and (a.lease_until is null or a.lease_until <= pg_catalog.now()))
     )
  returning a.*;
$$;

comment on function public.he_eng_auto_launch_claim(uuid, uuid, integer, boolean) is
  'ENG: взять строку автозапуска шаблона (state running, аренда p_lease_seconds) по часам БД. Тик — только due-строки; p_manual (кнопка «Launch now») — любую, кроме running с живой арендой. Пусто — взять нельзя.';

revoke all on function public.he_eng_auto_launch_claim(uuid, uuid, integer, boolean)
  from public, anon, authenticated;
grant execute on function public.he_eng_auto_launch_claim(uuid, uuid, integer, boolean)
  to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_catalog.pg_roles where rolname = 'readonly') then
    execute 'grant select on public.he_eng_launch_intent to readonly';
    execute 'grant select on public.he_eng_auto_launch to readonly';
  end if;
end $$;
