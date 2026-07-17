-- AMO CRM lookup tables: users (managers) + pipeline statuses.
--
-- До этой миграции amo_leads.status_name, .responsible_name, .contact_phone,
-- .contact_email, .company_name были NULL у всех 5553 сделок. amo.py тянул
-- только базовые поля из /api/v4/leads, а pipelines/users/contacts/companies
-- требуют отдельных API-вызовов. С этой миграции добавляются два справочника,
-- которые обновляет тот же portal-external-sync (see sources/amo.py), а также
-- заполняются денормализованные поля в amo_leads (см. отдельный alter ниже).
--
-- Codex через MCP portal-db может джойнить эти таблицы по FK, чтобы получить
-- человеческие имена: SELECT l.name, u.name AS manager, s.status_name FROM
-- amo_leads l JOIN amo_users u ON u.id = l.responsible_user_id JOIN
-- amo_statuses s ON s.pipeline_id = l.pipeline_id AND s.status_id = l.status_id;

-- ─── amo_users ──────────────────────────────────────────────────────────

create table if not exists public.amo_users (
  id          bigint primary key,          -- AMO user id (совпадает с responsible_user_id)
  name        text,
  email       text,
  role        text,                         -- role name из AMO (админ, менеджер, ...)
  lang        text,
  is_active   boolean,
  synced_at   timestamptz not null default now()
);

create index if not exists idx_amo_users_email on public.amo_users(lower(email)) where email is not null;

comment on table public.amo_users is
  'AMO CRM пользователи (менеджеры). Обновляется ночным portal-external-sync. Джойн с amo_leads через responsible_user_id.';

-- ─── amo_statuses ───────────────────────────────────────────────────────
-- Один pipeline может содержать много статусов; ключ — (pipeline_id, status_id).

create table if not exists public.amo_statuses (
  pipeline_id   bigint not null,
  status_id     bigint not null,
  pipeline_name text,
  status_name   text,
  sort          integer,
  color         text,
  is_editable   boolean,
  synced_at     timestamptz not null default now(),
  primary key (pipeline_id, status_id)
);

create index if not exists idx_amo_statuses_pipeline on public.amo_statuses(pipeline_id);

comment on table public.amo_statuses is
  'AMO CRM этапы воронки. Джойн с amo_leads через (pipeline_id, status_id). Статусы 142/143 = won/lost.';

-- ─── RLS ────────────────────────────────────────────────────────────────

alter table public.amo_users    enable row level security;
alter table public.amo_statuses enable row level security;

drop policy if exists amo_users_select_auth on public.amo_users;
create policy amo_users_select_auth on public.amo_users
  for select using (auth.uid() is not null);

drop policy if exists amo_statuses_select_auth on public.amo_statuses;
create policy amo_statuses_select_auth on public.amo_statuses
  for select using (auth.uid() is not null);

-- ─── Grants ─────────────────────────────────────────────────────────────

grant all on public.amo_users    to service_role, postgres;
grant all on public.amo_statuses to service_role, postgres;

-- Codex/MCP portal-db (readonly). Роль создана отдельно, эти гранты идемпотентны.
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.amo_users, public.amo_statuses to readonly';
  end if;
end $$;
