-- Журнал воркера лицензий ФНС (app/worker/fnsLicencesCron.ts): попытки
-- загрузить файл реестра МСП в companies_directory_licences и предупреждения
-- об устаревшем снимке.
--
-- По журналу воркер решает, пробовать ли файл снова. Отказ проверок снимка
-- (refused) окончателен для этого файла — его грузят руками. Сбой сети или
-- базы (failed) повторяется не раньше чем через сутки. Без журнала каждый
-- деплой (воркер пересоздаётся) заново качал бы 2,3 ГБ и слал бы тот же алерт.
--
-- Повторный запуск безопасен: if not exists.

create table if not exists public.companies_directory_licence_loads (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  status text not null default 'running' check (status in ('running', 'loaded', 'refused', 'failed', 'stale')),
  snapshot_date date,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  result jsonb,
  error text
);

create index if not exists companies_directory_licence_loads_file_idx
  on public.companies_directory_licence_loads (file_name, started_at desc);

alter table public.companies_directory_licence_loads enable row level security;

revoke all on table public.companies_directory_licence_loads from anon, authenticated;
grant all on public.companies_directory_licence_loads to service_role;
