-- «Наш автоаутрич»: контракты (44-ФЗ) и тендеры (223-ФЗ) из ГосПлан API
-- (lib/polzaRuOutreach/sources/gosplanSync.ts). Воркер автоаутрича раз в день
-- кладёт вчерашние контракты загрузкой на день и закон — как ручной файл.

-- ── Метка автозагрузки ──────────────────────────────────────────────────────
-- 'gosplan:fz44:2026-10-06' — день и закон; у ручных загрузок пусто.
-- Уникальность не даёт повторному прогону того же дня задвоить строки.
alter table public.polza_ru_signal_uploads add column if not exists auto_source text;
create unique index if not exists polza_ru_signal_uploads_auto_source_key
  on public.polza_ru_signal_uploads (auto_source)
  where auto_source is not null;

comment on column public.polza_ru_signal_uploads.auto_source is
  'Автозагрузка: источник, закон и день (gosplan:fz44:YYYY-MM-DD). Пусто — файл загрузил оператор.';

-- ── Курсор синка по закону ─────────────────────────────────────────────────
create table if not exists public.polza_ru_gosplan_sync (
  law text primary key check (law in ('fz44', 'fz223')),
  -- Последний день (МСК), загруженный целиком.
  synced_through date,
  last_run_at timestamptz,
  last_error text,
  -- {day, contracts, wins, named, rows, requests} последнего загруженного дня.
  last_stats jsonb,
  updated_at timestamptz not null default now()
);

-- Пишет и читает только воркер — сервисным ключом.
alter table public.polza_ru_gosplan_sync enable row level security;
grant all on public.polza_ru_gosplan_sync to service_role;
