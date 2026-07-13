-- Дополнительные колонки на amo_leads для связки Sales AI:
-- - contact_tg_username: TG-юзер контакта (из IM-поля контакта, либо regex из name сделки)
-- - company_website: сайт компании (из custom-поля «Сайт»), нормализованный
-- - company_name_fetched_at: когда воркер amo_enrich последний раз ходил на сайт
--   для этой сделки (чтобы не бомбить сайт каждую ночь).
--
-- Также расширяем check-constraint external_sync_runs.source для нового
-- источника 'amo_enrich' — отдельный SyncSource, который после основного
-- amo_leads-синка обходит сделки без company_name и вытаскивает название
-- с сайта (title / og:site_name).

alter table public.amo_leads
  add column if not exists contact_tg_username text,
  add column if not exists company_website text,
  add column if not exists company_name_fetched_at timestamptz;

create index if not exists idx_amo_leads_tg_username
  on public.amo_leads(lower(contact_tg_username))
  where contact_tg_username is not null;

create index if not exists idx_amo_leads_website
  on public.amo_leads(company_website)
  where company_website is not null;

-- external_sync_runs check-constraint — добавляем amo_enrich к списку источников
alter table public.external_sync_runs
  drop constraint if exists external_sync_runs_source_check;
alter table public.external_sync_runs
  add constraint external_sync_runs_source_check
  check (source in ('metrika','amo_leads','amo_events','bank_tochka','bank_tbank','attribution','amo_enrich'));

-- Codex/MCP portal-db (readonly) — идемпотентный ре-grant, потому что колонки новые.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.amo_leads to readonly';
  end if;
end $$;

comment on column public.amo_leads.contact_tg_username is
  'TG username основного контакта (без @). Заполняется из IM-поля контакта AMO, либо fallback — regex @[A-Za-z0-9_]+ из amo_leads.name.';
comment on column public.amo_leads.company_website is
  'Сайт компании (нормализованный: без https://, без www., без trailing slash). Источник — custom-поле «Сайт» на сделке.';
comment on column public.amo_leads.company_name_fetched_at is
  'Когда воркер amo_enrich последний раз ходил на company_website. NULL = ни разу. Не пере-фетчим если company_name уже заполнен ИЛИ fetched_at свежее 30 дней.';
