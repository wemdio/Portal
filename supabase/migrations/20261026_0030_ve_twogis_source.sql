-- VE2: снимок 2ГИС как источник сбора — настройки, состояние чтения и журнал
-- строк (план docs/reports/2026-10-26-2gis-ve2-plan.md, шаг R2; решения
-- владельца 26.10.2026).
--
-- Сама по себе миграция ничего не включает: mode = 'off', client_use = 'off',
-- журнал пуст. Код R1 эти таблицы не читает. С шага R3 настройки читает код
-- VE2 (новое превью, поставка, выгрузка, guard выдачи и запуск в портале,
-- модуль 2ГИС воркера) и health-check; журнал и состояние пишет только модуль
-- 2ГИС воркера. Повторное применение настроек не меняет.

-- Внешние ключи журнала берут на ve_bases и ve_projects блокировку, запрещающую
-- запись. Таблица новая и пустая, это миг, но за чужой длинной транзакцией
-- миграция ждала бы и держала очередь записей баз: ждём не дольше 5 с.
set local lock_timeout = '5s';

-- ─── Настройки (одна строка на рынок) ──────────────────────────────────────
-- mode: off — близнецы 2ГИС не ставятся новым базам, у уже поставленных
--   задача 2ГИС закрывается; on — флаг 2ГИС получают новые RU-превью без
--   профилей в проектах, которым разрешена выдача.
-- reads_enabled: аварийная пауза чтения базы 2ГИС без деплоя — базы ждут, не
--   останавливаются; дольше суток — ставим mode = 'off'.
-- client_use: кому можно выдавать строки 2ГИС: off — никому (аварийное
--   закрытие, через сутки близнецы закрываются); internal — только
--   internal_projects; all — всем проектам, кроме excluded_projects.
-- quiet_*_utc: тихое окно (ночной прогон OutreachOS), в нём 2ГИС не читается;
--   start > end — окно через полночь.
-- max_candidates: потолок кандидатов близнеца на базу; null — общий лимит базы.
-- snapshot_id / features_version / built_at: снимок 2ГИС и версия таблицы
--   сайтов, на которых проверена сборка (шаг Ш5); пишутся только под «да».
-- *_changed_at: когда меняли mode, reads_enabled, client_use — от них R3 считает
--   «дольше суток». Ставит триггер, если пишущий их не задал (правка из psql).
create table if not exists public.ve_twogis_source_settings (
  market                text primary key check (market = 'ru'),
  mode                  text not null default 'off' check (mode in ('off', 'on')),
  reads_enabled         boolean not null default true,
  client_use            text not null default 'off' check (client_use in ('off', 'internal', 'all')),
  internal_projects     uuid[] not null default '{}',
  excluded_projects     uuid[] not null default '{}',
  quiet_start_utc       time not null default '02:00',
  quiet_end_utc         time not null default '11:00',
  max_candidates        integer check (max_candidates is null or max_candidates > 0),
  snapshot_id           bigint,
  features_version      integer check (features_version is null or features_version > 0),
  built_at              timestamptz,
  mode_changed_at       timestamptz,
  reads_changed_at      timestamptz,
  client_use_changed_at timestamptz,
  note                  text,
  updated_by            uuid,
  updated_at            timestamptz not null default now(),
  constraint ve_twogis_source_settings_quiet_check check (quiet_start_utc <> quiet_end_utc)
);

-- Повторное применение не должно молча включить 2ГИС: только do nothing.
insert into public.ve_twogis_source_settings (market) values ('ru')
on conflict (market) do nothing;

alter table public.ve_twogis_source_settings enable row level security;
revoke all on public.ve_twogis_source_settings from public, anon, authenticated;
grant all on public.ve_twogis_source_settings to service_role;

comment on table public.ve_twogis_source_settings is
  'VE2 2GIS source switch (RU): mode off/on, reads_enabled emergency pause, client_use off/internal/all with project lists, quiet window, verified snapshot, change times. Default: everything off.';

-- Настройки меняют вручную под «да» (панели нет): «когда» ставит триггер, «кто»
-- без явного updated_by — неизвестно. Иначе сутки считались бы от старой отметки.
create or replace function public.ve_twogis_source_settings_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.mode is distinct from old.mode and new.mode_changed_at is not distinct from old.mode_changed_at then
    new.mode_changed_at := now();
  end if;
  if new.reads_enabled is distinct from old.reads_enabled and new.reads_changed_at is not distinct from old.reads_changed_at then
    new.reads_changed_at := now();
  end if;
  if new.client_use is distinct from old.client_use and new.client_use_changed_at is not distinct from old.client_use_changed_at then
    new.client_use_changed_at := now();
  end if;
  if new.updated_by is not distinct from old.updated_by then
    new.updated_by := null;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ve_twogis_source_settings_touch on public.ve_twogis_source_settings;
create trigger ve_twogis_source_settings_touch
  before update on public.ve_twogis_source_settings
  for each row execute function public.ve_twogis_source_settings_touch();

revoke all on function public.ve_twogis_source_settings_touch() from public, anon, authenticated;

-- ─── Состояние чтения (для health-check) ───────────────────────────────────
-- Модуль 2ГИС пишет строку сразу при смене состояния, повторы того же
-- состояния — не чаще раза в минуту. Первая ошибка серии ставит error_since;
-- норма сбрасывает consecutive_errors = 0, paused_until = null,
-- error_since = null, а last_error_kind и last_error_at остаются историей.
-- Эпизод алерта health-check — error_since или paused_until. Текст ошибки сюда
-- не пишется, только её вид.
create table if not exists public.ve_twogis_source_status (
  market             text primary key check (market = 'ru'),
  paused_until       timestamptz,
  consecutive_errors integer not null default 0 check (consecutive_errors >= 0),
  error_since        timestamptz,
  last_error_kind    text check (last_error_kind is null
    or last_error_kind in ('connect', 'role_limit', 'timeout', 'snapshot', 'other')),
  last_error_at      timestamptz,
  updated_at         timestamptz not null default now(),
  constraint ve_twogis_source_status_series_check check ((consecutive_errors = 0) = (error_since is null))
);

insert into public.ve_twogis_source_status (market) values ('ru')
on conflict (market) do nothing;

alter table public.ve_twogis_source_status enable row level security;
revoke all on public.ve_twogis_source_status from public, anon, authenticated;
grant all on public.ve_twogis_source_status to service_role;

comment on table public.ve_twogis_source_status is
  'VE2 2GIS reader health (RU): pause, error series start and count, last error kind for health-check alerts. No error text.';

-- Свежесть для health-check не зависит от того, задал ли пишущий updated_at.
create or replace function public.ve_twogis_source_status_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists ve_twogis_source_status_touch on public.ve_twogis_source_status;
create trigger ve_twogis_source_status_touch
  before update on public.ve_twogis_source_status
  for each row execute function public.ve_twogis_source_status_touch();

revoke all on function public.ve_twogis_source_status_touch() from public, anon, authenticated;

-- ─── Журнал строк 2ГИС ─────────────────────────────────────────────────────
-- Один домен сайта — одна строка на линию гипотезы проекта: близнецы баз одной
-- гипотезы не берут одну компанию дважды. claimed — взят в работу базой,
-- rejected — отсеян (reason), ready — стал готовой строкой. Сначала claim здесь,
-- потом запись collect_info; повтор страницы перечитывает свои claim по base_id.
-- Когда база выходит из сбора, её claimed без итога удаляются. Строки не из 2ГИС
-- по домену не сверяются: признак 2ГИС едет в самой строке. hypothesis_id
-- бывает пустым у старых баз: nulls not distinct держит и такую линию одной.
-- Домен и хост — в нижнем регистре (punycode), иначе уникальность обходится.
-- updated_at пишет модуль 2ГИС.
create table if not exists public.ve_twogis_rows (
  id                 bigint generated always as identity primary key,
  project_id         uuid not null references public.ve_projects(id) on delete cascade,
  hypothesis_id      uuid,
  base_id            uuid not null references public.ve_bases(id) on delete cascade,
  registrable_domain text not null check (btrim(registrable_domain) <> '' and registrable_domain = lower(registrable_domain)),
  host               text not null check (btrim(host) <> '' and host = lower(host)),
  card_id            text not null check (btrim(card_id) <> ''),
  snapshot_id        bigint not null,
  outcome            text not null default 'claimed' check (outcome in ('claimed', 'rejected', 'ready')),
  reason             text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint ve_twogis_rows_line_domain_key unique nulls not distinct (project_id, hypothesis_id, registrable_domain)
);

-- Освобождение claim базы при выходе из сбора и повтор страницы.
create index if not exists ve_twogis_rows_base_id_idx on public.ve_twogis_rows (base_id);

alter table public.ve_twogis_rows enable row level security;
revoke all on public.ve_twogis_rows from public, anon, authenticated;
grant all on public.ve_twogis_rows to service_role;
-- Права по умолчанию могут выдать клиентским ролям последовательность identity
-- (как в 20261015_0032): таблица только служебная.
revoke all on sequence public.ve_twogis_rows_id_seq from public, anon, authenticated;

comment on table public.ve_twogis_rows is
  'VE2 2GIS row journal: one registrable domain per project hypothesis line (claimed/rejected/ready). Written only by the VE2 worker 2GIS module.';
