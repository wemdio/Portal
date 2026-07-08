-- External data sync tables: AMO CRM, Yandex Metrika, banks (Точка + Т-Банк).
-- Populated nightly by portal-worker-external-sync. Attribution to projects
-- lives in separate attribution_* tables so raw data stays honest.
--
-- Read access: agrees with existing `readonly` role auto-grant via ALTER DEFAULT
-- PRIVILEGES (см. setup readonly-роли). Если роль создавалась до этой миграции,
-- в конце файла есть idempotent GRANT — раскомментировать при первом применении.

-- ─── AMO CRM ────────────────────────────────────────────────────────────

create table if not exists public.amo_leads (
  id             bigserial primary key,
  amo_id         bigint       not null unique,
  name           text,
  status_id      bigint,
  status_name    text,
  pipeline_id    bigint,
  pipeline_name  text,
  amount         numeric(12,2),
  responsible_user_id bigint,
  responsible_name text,
  ym_client_id   text,
  contact_phone  text,
  contact_email  text,
  company_name   text,
  created_at     timestamptz,
  updated_at     timestamptz,
  closed_at      timestamptz,
  raw            jsonb not null,
  synced_at      timestamptz not null default now()
);

create index if not exists idx_amo_leads_ym_client_id on public.amo_leads(ym_client_id) where ym_client_id is not null;
create index if not exists idx_amo_leads_contact_phone on public.amo_leads(contact_phone) where contact_phone is not null;
create index if not exists idx_amo_leads_contact_email on public.amo_leads(contact_email) where contact_email is not null;
create index if not exists idx_amo_leads_company_name on public.amo_leads(lower(company_name));
create index if not exists idx_amo_leads_status_id on public.amo_leads(status_id);
create index if not exists idx_amo_leads_updated_at on public.amo_leads(updated_at desc);

comment on table public.amo_leads is 'AMO CRM deals synced nightly. Use raw->>''...'' for fields not extracted to columns.';
comment on column public.amo_leads.ym_client_id is 'Yandex Metrika ClientID from AMO custom field (linkage to metrika_visits).';

create table if not exists public.amo_events (
  id             bigserial primary key,
  amo_deal_id    bigint not null,
  event_type     text   not null,
  changed_at     timestamptz not null,
  changed_by     bigint,
  from_value     text,
  to_value       text,
  payload        jsonb,
  synced_at      timestamptz not null default now(),
  unique (amo_deal_id, event_type, changed_at)
);

create index if not exists idx_amo_events_deal_id on public.amo_events(amo_deal_id);
create index if not exists idx_amo_events_changed_at on public.amo_events(changed_at desc);

comment on table public.amo_events is 'Deal history from AMO: status changes, tasks, notes. For "why is this deal stuck".';

-- ─── Yandex Metrika ─────────────────────────────────────────────────────

create table if not exists public.metrika_visits (
  id             bigserial primary key,
  ym_client_id   text not null,
  visit_at       timestamptz not null,
  visit_duration integer,
  page_views     integer,
  utm_source     text,
  utm_medium     text,
  utm_campaign   text,
  utm_content    text,
  utm_term       text,
  referrer       text,
  landing_page   text,
  goal_reaches   jsonb,
  raw            jsonb,
  synced_at      timestamptz not null default now()
);

create index if not exists idx_metrika_visits_ym_client_id on public.metrika_visits(ym_client_id);
create index if not exists idx_metrika_visits_visit_at on public.metrika_visits(visit_at desc);
create index if not exists idx_metrika_visits_utm_source on public.metrika_visits(utm_source, utm_campaign);

comment on table public.metrika_visits is 'Visit-level data from Yandex Metrika. Linkage to AMO: WHERE ym_client_id = amo_leads.ym_client_id.';

create table if not exists public.metrika_visits_daily (
  date            date   not null,
  traffic_source  text   not null,
  visits          integer not null,
  users           integer not null,
  bounce_rate     numeric(5,2),
  synced_at       timestamptz not null default now(),
  primary key (date, traffic_source)
);

comment on table public.metrika_visits_daily is 'Aggregated daily traffic by source (для быстрых трендов, без раскладки по клиентам).';

-- ─── Banks (Точка + Т-Банк в одной таблице) ─────────────────────────────

create table if not exists public.bank_transactions (
  id             bigserial primary key,
  bank           text not null check (bank in ('tochka','tbank')),
  account_id     text,
  transaction_id text not null,
  document_number text,
  occurred_at    timestamptz not null,
  amount         numeric(14,2) not null,
  currency       text not null default 'RUB',
  direction      text not null check (direction in ('credit','debit')),
  payer_name     text,
  payer_inn      text,
  payee_name     text,
  payee_inn      text,
  purpose        text,
  is_revenue     boolean,
  exclude_reason text,
  raw            jsonb not null,
  synced_at      timestamptz not null default now(),
  unique (bank, transaction_id)
);

create index if not exists idx_bank_tx_occurred_at on public.bank_transactions(occurred_at desc);
create index if not exists idx_bank_tx_payer_inn on public.bank_transactions(payer_inn) where payer_inn is not null;
create index if not exists idx_bank_tx_payer_name on public.bank_transactions(lower(payer_name));
create index if not exists idx_bank_tx_is_revenue on public.bank_transactions(is_revenue) where is_revenue is true;
create index if not exists idx_bank_tx_bank_direction on public.bank_transactions(bank, direction);

comment on table public.bank_transactions is 'Транзакции обеих банков. is_revenue=true — то что мы считаем выручкой (классификатор в extract_banks.py). exclude_reason — почему НЕ выручка.';
comment on column public.bank_transactions.is_revenue is 'true — клиентский платёж; false — не выручка (см. exclude_reason: возврат, овердрафт, перевод себе).';

-- ─── Attribution (связка внешних данных с проектами) ────────────────────

create table if not exists public.attribution_amo_project (
  id             bigserial primary key,
  amo_deal_id    bigint not null,
  project_id     uuid   not null references public.projects(id) on delete cascade,
  confidence     numeric(3,2) not null check (confidence between 0 and 1),
  method         text   not null,
  matched_at     timestamptz not null default now(),
  unique (amo_deal_id, project_id)
);

create index if not exists idx_attr_amo_project_deal on public.attribution_amo_project(amo_deal_id);
create index if not exists idx_attr_amo_project_project on public.attribution_amo_project(project_id);

comment on table public.attribution_amo_project is 'Как AMO-сделки связаны с проектами. method: by_ym_client_id | by_email | by_phone | by_company_name | manual.';

create table if not exists public.attribution_payment_project (
  id             bigserial primary key,
  bank_transaction_id bigint not null references public.bank_transactions(id) on delete cascade,
  project_id     uuid   not null references public.projects(id) on delete cascade,
  confidence     numeric(3,2) not null check (confidence between 0 and 1),
  method         text   not null,
  matched_at     timestamptz not null default now(),
  unique (bank_transaction_id, project_id)
);

create index if not exists idx_attr_pay_project_tx on public.attribution_payment_project(bank_transaction_id);
create index if not exists idx_attr_pay_project_project on public.attribution_payment_project(project_id);

comment on table public.attribution_payment_project is 'Как платежи в банке связаны с проектами. method: by_inn | by_company_name | by_invoice_amount_date | manual.';

create table if not exists public.attribution_visit_lead (
  id             bigserial primary key,
  ym_client_id   text   not null,
  amo_lead_id    bigint not null,
  confidence     numeric(3,2) not null check (confidence between 0 and 1),
  method         text   not null,
  matched_at     timestamptz not null default now(),
  unique (ym_client_id, amo_lead_id)
);

create index if not exists idx_attr_visit_lead_ym on public.attribution_visit_lead(ym_client_id);
create index if not exists idx_attr_visit_lead_amo on public.attribution_visit_lead(amo_lead_id);

comment on table public.attribution_visit_lead is 'Метрика → AMO. Если ym_client_id пришёл прямо в AMO — confidence=1.0, method=direct. Иначе эвристика по времени/UTM.';

-- ─── Sync observability ─────────────────────────────────────────────────

create table if not exists public.external_sync_runs (
  id             bigserial primary key,
  source         text not null check (source in ('amo_leads','amo_events','metrika','bank_tochka','bank_tbank','attribution')),
  started_at     timestamptz not null default now(),
  finished_at    timestamptz,
  status         text not null default 'running' check (status in ('running','success','partial','error')),
  records_upserted integer,
  error          text,
  meta           jsonb
);

create index if not exists idx_ext_sync_runs_source_started on public.external_sync_runs(source, started_at desc);

comment on table public.external_sync_runs is 'Лог ночных синков. Мониторить: SELECT * FROM external_sync_runs WHERE started_at > now() - interval ''2 days'' ORDER BY started_at DESC.';

-- ─── RLS (совместимо с текущим паттерном payment_requests) ──────────────

alter table public.amo_leads                 enable row level security;
alter table public.amo_events                enable row level security;
alter table public.metrika_visits            enable row level security;
alter table public.metrika_visits_daily      enable row level security;
alter table public.bank_transactions         enable row level security;
alter table public.attribution_amo_project   enable row level security;
alter table public.attribution_payment_project enable row level security;
alter table public.attribution_visit_lead    enable row level security;
alter table public.external_sync_runs        enable row level security;

do $$
declare tbl text;
begin
  foreach tbl in array array[
    'amo_leads','amo_events','metrika_visits','metrika_visits_daily',
    'bank_transactions','attribution_amo_project','attribution_payment_project',
    'attribution_visit_lead','external_sync_runs'
  ] loop
    execute format('drop policy if exists %I_select_auth on public.%I', tbl, tbl);
    execute format(
      'create policy %I_select_auth on public.%I for select using (auth.uid() is not null)',
      tbl, tbl
    );
  end loop;
end$$;

-- ─── Service_role grants (обязательно — иначе migration lint падает) ───
-- Sync worker пишет и читает через SUPABASE_DB_URL под service_role.

grant all on public.amo_leads                    to service_role, postgres;
grant all on public.amo_events                   to service_role, postgres;
grant all on public.metrika_visits               to service_role, postgres;
grant all on public.metrika_visits_daily         to service_role, postgres;
grant all on public.bank_transactions            to service_role, postgres;
grant all on public.attribution_amo_project      to service_role, postgres;
grant all on public.attribution_payment_project  to service_role, postgres;
grant all on public.attribution_visit_lead       to service_role, postgres;
grant all on public.external_sync_runs           to service_role, postgres;

grant usage, select on sequence public.amo_leads_id_seq                   to service_role, postgres;
grant usage, select on sequence public.amo_events_id_seq                  to service_role, postgres;
grant usage, select on sequence public.metrika_visits_id_seq              to service_role, postgres;
grant usage, select on sequence public.bank_transactions_id_seq           to service_role, postgres;
grant usage, select on sequence public.attribution_amo_project_id_seq     to service_role, postgres;
grant usage, select on sequence public.attribution_payment_project_id_seq to service_role, postgres;
grant usage, select on sequence public.attribution_visit_lead_id_seq      to service_role, postgres;
grant usage, select on sequence public.external_sync_runs_id_seq          to service_role, postgres;

-- ─── Grants для readonly-роли (Codex MCP) ───────────────────────────────
-- Если readonly уже существует (см. setup_dbreader.sh), раскомментируй:

-- grant select on public.amo_leads, public.amo_events,
--                 public.metrika_visits, public.metrika_visits_daily,
--                 public.bank_transactions,
--                 public.attribution_amo_project,
--                 public.attribution_payment_project,
--                 public.attribution_visit_lead,
--                 public.external_sync_runs
--   to readonly;
