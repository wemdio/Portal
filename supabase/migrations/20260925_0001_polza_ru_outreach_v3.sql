-- «Наш автоаутрич» v3 (25.09.2026, docs/superpowers/specs/2026-09-25-polza-ru-outreach-v3-design.md):
-- очень спорные строки, причина выбора оффера, коммерческие тендеры, кэш
-- отчётности ФНС, кандидаты из 2ГИС и новые точки сетей Яндекс Карт.

-- ── Очень спорные и роутинг ─────────────────────────────────────────────────
alter table public.polza_ru_outreach_companies
  drop constraint if exists polza_ru_outreach_companies_row_status_check;
alter table public.polza_ru_outreach_companies
  add constraint polza_ru_outreach_companies_row_status_check
  check (row_status in ('processing', 'ready', 'rejected', 'manual_review', 'failed', 'doubtful'));

alter table public.polza_ru_outreach_companies
  add column if not exists doubt_flags text[] not null default '{}',
  add column if not exists doubt_detail text,
  add column if not exists route_reason text,
  add column if not exists route_runner_up text;

-- ── Коммерческие тендеры — новый вид загрузки ───────────────────────────────
alter table public.polza_ru_signal_uploads drop constraint if exists polza_ru_signal_uploads_kind_check;
alter table public.polza_ru_signal_uploads
  add constraint polza_ru_signal_uploads_kind_check check (kind in ('exhibitors', 'contracts', 'growth', 'tenders'));
alter table public.polza_ru_signal_rows drop constraint if exists polza_ru_signal_rows_kind_check;
alter table public.polza_ru_signal_rows
  add constraint polza_ru_signal_rows_kind_check check (kind in ('exhibitors', 'contracts', 'growth', 'tenders'));

-- ── Кэш бухотчётности ФНС (bo.nalog.gov.ru), 30 дней ───────────────────────
-- Пустая выручка тоже кэшируется: у компании нет отчётности — не спрашиваем снова.
create table if not exists public.polza_ru_fns_revenue (
  inn text primary key,
  bfo_org_id bigint,
  report_year integer,
  revenue bigint,
  revenue_prev bigint,
  fetched_at timestamptz not null default now()
);
alter table public.polza_ru_fns_revenue enable row level security;
grant all on public.polza_ru_fns_revenue to service_role;

-- ── Кандидаты из 2ГИС: проверенные сигнальным конвейером компании ──────────
create or replace function public.polza_ru_gis_candidates(p_since timestamptz, p_limit integer)
returns table (
  twogis_id text,
  company_name text,
  domain text,
  site text,
  sales_team boolean,
  multi_office boolean,
  evidence jsonb,
  checked_at timestamptz
)
language sql
stable
set statement_timeout = '30s'
as $$
  select s.twogis_id::text, c.company_name::text, c.domain::text, s.site::text,
         (coalesce(s.signal_sales_dept, false) or coalesce(s.signal_target_vacancy, false)),
         coalesce(s.signal_multi_office, false),
         s.evidence::jsonb,
         s.checked_at
  from public.gis_signal_company_signals s
  join public.gis_signal_seen_companies c on c.twogis_id = s.twogis_id
  where s.checked_at >= p_since
    and (s.signal_multi_office or s.signal_sales_dept or s.signal_target_vacancy)
    and coalesce(nullif(c.domain::text, ''), nullif(s.site::text, '')) is not null
  order by s.checked_at desc
  limit least(greatest(p_limit, 1), 5000);
$$;
revoke all on function public.polza_ru_gis_candidates(timestamptz, integer) from public;
grant execute on function public.polza_ru_gis_candidates(timestamptz, integer) to service_role;

-- ── Новые точки сетей в Яндекс Картах ───────────────────────────────────────
-- Точка сети, впервые увиденная в окне свежести, при том что у сети есть
-- точки старше окна. Индекса по first_seen_at нет — при таймауте источник
-- вернёт ошибку, запуск продолжится без него.
create or replace function public.polza_ru_ymaps_new_branches(p_since timestamptz, p_limit integer)
returns table (
  network_id text,
  network_name text,
  name text,
  website text,
  address text,
  city text,
  first_seen_at timestamptz,
  card_url text
)
language sql
stable
set statement_timeout = '30s'
as $$
  select distinct on (f.network_id)
         f.network_id, f.network_name, f.name, f.website,
         f.address, f.city, f.first_seen_at, f.card_url
  from public.yandex_maps_company_catalog f
  where f.network_id <> ''
    and f.first_seen_at >= p_since
    and f.closed_suspected_at is null
    and coalesce(f.website, '') <> ''
    and exists (
      select 1 from public.yandex_maps_company_catalog o
      where o.network_id = f.network_id and o.network_id <> '' and o.first_seen_at < p_since
    )
  order by f.network_id, f.first_seen_at desc
  limit least(greatest(p_limit, 1), 5000);
$$;
revoke all on function public.polza_ru_ymaps_new_branches(timestamptz, integer) from public;
grant execute on function public.polza_ru_ymaps_new_branches(timestamptz, integer) to service_role;
