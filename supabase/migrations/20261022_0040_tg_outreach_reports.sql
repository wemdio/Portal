-- Собранные отчёты TG-аутрича: каждый отчёт, который сотрудник собрал на
-- вкладке «Отчёт», сохраняется целиком (цифры на момент сборки), чтобы его
-- можно было открыть снова, не пересчитывая, и видно было, кто его собрал.
--
-- Кампания может быть удалена — отчёт уходит вместе с ней (cascade). Имя
-- автора копируется в строку: профиль сотрудника может исчезнуть раньше отчёта.
create table if not exists public.tg_outreach_reports (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.tg_outreach_campaigns(id) on delete cascade,
  period_from timestamptz not null,
  period_to timestamptz not null,
  report jsonb not null,
  created_by uuid,
  created_by_name text,
  created_at timestamptz not null default now()
);

-- Список отчётов кампании: свежие сверху.
create index if not exists idx_tg_outreach_reports_campaign
  on public.tg_outreach_reports (campaign_id, created_at desc);

alter table public.tg_outreach_reports enable row level security;

drop policy if exists tg_outreach_reports_select_all on public.tg_outreach_reports;
create policy tg_outreach_reports_select_all on public.tg_outreach_reports
  for select to authenticated using (true);

drop policy if exists tg_outreach_reports_insert_all on public.tg_outreach_reports;
create policy tg_outreach_reports_insert_all on public.tg_outreach_reports
  for insert to authenticated with check (true);

grant all on public.tg_outreach_reports to service_role;
grant select, insert on public.tg_outreach_reports to authenticated;

comment on table public.tg_outreach_reports is
  'Saved tg-outreach campaign reports (JSON snapshot at build time) with the author. Shown in the report tab history.';
