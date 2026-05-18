-- Event-agency outreach tool: agency profile config + generated leads with personalized hooks.
-- Tool UI: app/src/app/tools/event-outreach
-- Pipeline: SQL pre-filter over companies_directory -> signal detection -> email -> LLM hook.

CREATE TABLE IF NOT EXISTS public.event_outreach_config (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.event_outreach_config IS
  'Event-outreach tool: agency profile (name, services, tone, hook examples, industry pain points). Key/value; complex values stored as JSON text.';

CREATE TABLE IF NOT EXISTS public.event_outreach_leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_date date NOT NULL DEFAULT current_date,
  company_name text NOT NULL,
  inn text,
  kpp text,
  ogrn text,
  address text,
  region_code text,
  okved_code text,
  activity_type text,
  industry text,
  employees_count integer,
  revenue bigint,
  website text,
  email text,
  email_source text NOT NULL DEFAULT 'none',
  company_age integer,
  is_anniversary boolean NOT NULL DEFAULT false,
  anniversary_year integer,
  hh_vacancies_count integer NOT NULL DEFAULT 0,
  seeking_event_manager boolean NOT NULL DEFAULT false,
  detected_signals text[] NOT NULL DEFAULT '{}',
  tier text NOT NULL DEFAULT 'cold',
  hook text,
  subject_line text,
  raw_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.event_outreach_leads IS
  'Event-outreach tool: companies from companies_directory enriched with signals + LLM-generated personalized hook/subject.';

CREATE INDEX IF NOT EXISTS event_outreach_leads_batch_idx ON public.event_outreach_leads (batch_date DESC);
CREATE INDEX IF NOT EXISTS event_outreach_leads_tier_idx ON public.event_outreach_leads (tier);
CREATE INDEX IF NOT EXISTS event_outreach_leads_inn_idx ON public.event_outreach_leads (inn);

-- GRANTs: the tool reaches the DB only via the service role (API routes use
-- supabaseAdmin); without an explicit grant the service role gets permission denied.
grant all on public.event_outreach_config to service_role, postgres;
grant all on public.event_outreach_leads to service_role, postgres;

-- RLS on with no policies: anon/authenticated clients have no direct access
-- (all access is server-side); the service role bypasses RLS.
alter table public.event_outreach_config enable row level security;
alter table public.event_outreach_leads enable row level security;
