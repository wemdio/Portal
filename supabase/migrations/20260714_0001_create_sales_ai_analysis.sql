-- Sales AI Analysis: ночной AI-разбор сделок AMO с 27 вопросами.
--
-- Пайплайн (см. app/worker/salesAiAnalysis.ts):
-- 1. Cron 3:00 MSK: sales_regulation.syncFromFile → sales_ai_analysis_jobs enqueue
-- 2. Воркер claims job → собирает контекст (amo_leads + переписка ТГ + транскрипты)
-- 3. Один LLM-вызов с 27 вопросами → JSON ответ, валидируется Zod-схемой
-- 4. Сохраняется в sales_ai_deal_analysis.analysis_json (JSONB) + evidence
--
-- РОП читает через Codex + MCP portal-db (роль readonly). UI не строим — все
-- ответы читаются SQL-запросами через шаблоны в AGENTS.md.
--
-- Дедуп: analysis_json не пересчитывается, если input_hash не изменился с
-- прошлого прогона (sha256 от deal.updated_at + last_msg.sent_at +
-- regulation.body_sha256). Сюда же трекается tokens_used и cost_usd.

-- ─── 1. sales_regulation ─────────────────────────────────────────────────
-- Версионированное хранилище регламента. Источник истины — файл
-- docs/sales-regulation.md, cron-воркер синхронизирует изменения.

create table if not exists public.sales_regulation (
  id           bigserial primary key,
  version      integer not null,
  body         text    not null,
  body_sha256  text    not null,
  is_active    boolean not null default false,
  source       text    not null default 'file' check (source in ('file','manual')),
  created_at   timestamptz not null default now()
);

create unique index if not exists idx_sales_regulation_active
  on public.sales_regulation(is_active) where is_active = true;
create index if not exists idx_sales_regulation_hash
  on public.sales_regulation(body_sha256);

comment on table public.sales_regulation is
  'Регламент продаж — версионируется. Источник — docs/sales-regulation.md в репе, синкается воркером Sales AI при каждом крон-прогоне.';

-- ─── 2. sales_ai_analysis_jobs ───────────────────────────────────────────
-- Очередь по паттерну sales_copilot_jobs.

create table if not exists public.sales_ai_analysis_jobs (
  id            uuid primary key default gen_random_uuid(),
  amo_lead_id   bigint not null references public.amo_leads(id) on delete cascade,
  trigger       text   not null check (trigger in ('cron','manual')),
  status        text   not null default 'pending'
    check (status in ('pending','running','done','failed','skipped')),
  skip_reason   text,
  error_message text,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

create index if not exists idx_sales_ai_jobs_pending
  on public.sales_ai_analysis_jobs(created_at) where status = 'pending';
create index if not exists idx_sales_ai_jobs_lead
  on public.sales_ai_analysis_jobs(amo_lead_id, created_at desc);

comment on table public.sales_ai_analysis_jobs is
  'Очередь заданий Sales AI. skip_reason: no_new_data | no_context (нечего анализировать).';

-- ─── 3. sales_ai_deal_analysis ───────────────────────────────────────────
-- Основная таблица разборов. 27 ответов лежат в analysis_json (JSONB) —
-- Codex распарсивает через analysis_json->'q1_funnel_stage'.
--
-- Извлечены в колонки: manager_score (int, для сортировки) и action_type
-- (для фильтра «требует внимания» на уровне SQL, без разбора JSON).

create table if not exists public.sales_ai_deal_analysis (
  id                uuid primary key default gen_random_uuid(),
  amo_lead_id       bigint not null references public.amo_leads(id) on delete cascade,
  regulation_id     bigint references public.sales_regulation(id),
  analyzed_at       timestamptz not null default now(),

  -- Дублируем из JSON для быстрых SQL-фильтров без разбора JSONB:
  action_type       text check (action_type in ('manager_action_needed','no_action_needed')),
  manager_score     integer check (manager_score between 1 and 10),
  risk_level        text check (risk_level in ('low','medium','high')),
  confidence        text check (confidence in ('low','medium','high')),

  -- Полный ответ LLM: 27 вопросов + метаданные, см. app/src/lib/salesAiAnalysis/schemas.ts
  analysis_json     jsonb not null,

  -- Кол-во сообщений/транскриптов, попавших в контекст (для отладки).
  context_messages_count integer,
  context_transcripts_count integer,

  -- Дедуп: не пересчитываем анализ, если input_hash совпал с прошлым.
  input_hash        text not null,

  -- Экономика вызова
  llm_model         text,
  tokens_used       integer,
  cost_usd          numeric(10,4)
);

create index if not exists idx_sales_ai_analysis_lead_date
  on public.sales_ai_deal_analysis(amo_lead_id, analyzed_at desc);
create index if not exists idx_sales_ai_analysis_action
  on public.sales_ai_deal_analysis(action_type)
  where action_type = 'manager_action_needed';
create index if not exists idx_sales_ai_analysis_risk
  on public.sales_ai_deal_analysis(risk_level, analyzed_at desc)
  where risk_level in ('medium','high');
create index if not exists idx_sales_ai_analysis_score
  on public.sales_ai_deal_analysis(manager_score, analyzed_at desc);
create index if not exists idx_sales_ai_analysis_hash
  on public.sales_ai_deal_analysis(amo_lead_id, input_hash);

comment on table public.sales_ai_deal_analysis is
  '27 ответов AI на разбор сделки. analysis_json->>q1..q27 — сами ответы. См. AGENTS.md → раздел Sales AI.';
comment on column public.sales_ai_deal_analysis.analysis_json is
  'JSON: {q1_funnel_stage, q2_next_step, ..., q27_grammar_quality, manager_score, action_type, risk_level, confidence, evidence: [{question, source, quote, why}]}';

-- ─── 4. sales_ai_evidence ───────────────────────────────────────────────
-- Плоская таблица цитат для быстрых запросов «покажи все evidence по q11».

create table if not exists public.sales_ai_evidence (
  id              uuid primary key default gen_random_uuid(),
  analysis_id     uuid not null references public.sales_ai_deal_analysis(id) on delete cascade,
  question_num    integer,               -- номер вопроса 1..27, если evidence привязано к конкретному
  source_type     text not null check (source_type in ('chat','call','amo')),
  source_id       text,
  quote           text not null,
  why_relevant    text
);

create index if not exists idx_sales_ai_evidence_analysis
  on public.sales_ai_evidence(analysis_id);
create index if not exists idx_sales_ai_evidence_question
  on public.sales_ai_evidence(question_num) where question_num is not null;

-- ─── RLS ────────────────────────────────────────────────────────────────

alter table public.sales_regulation           enable row level security;
alter table public.sales_ai_analysis_jobs     enable row level security;
alter table public.sales_ai_deal_analysis     enable row level security;
alter table public.sales_ai_evidence          enable row level security;

do $$
declare tbl text;
begin
  foreach tbl in array array[
    'sales_regulation','sales_ai_analysis_jobs','sales_ai_deal_analysis','sales_ai_evidence'
  ] loop
    execute format('drop policy if exists %I_select_auth on public.%I', tbl, tbl);
    execute format(
      'create policy %I_select_auth on public.%I for select using (auth.uid() is not null)',
      tbl, tbl
    );
  end loop;
end$$;

-- ─── Grants ─────────────────────────────────────────────────────────────

grant all on public.sales_regulation       to service_role, postgres;
grant all on public.sales_ai_analysis_jobs to service_role, postgres;
grant all on public.sales_ai_deal_analysis to service_role, postgres;
grant all on public.sales_ai_evidence      to service_role, postgres;

grant usage, select on sequence public.sales_regulation_id_seq to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.sales_regulation, public.sales_ai_analysis_jobs, public.sales_ai_deal_analysis, public.sales_ai_evidence to readonly';
  end if;
end $$;
