-- Add lead-source hypotheses columns to client_briefs.
-- AI-generated hypotheses (markdown) derived from the client's saved brief,
-- analogous to public.projects.lead_source_hypotheses for /projects/.

alter table public.client_briefs
  add column if not exists lead_source_hypotheses text,
  add column if not exists lead_source_hypotheses_generated_at timestamptz,
  add column if not exists lead_source_hypotheses_error text;
