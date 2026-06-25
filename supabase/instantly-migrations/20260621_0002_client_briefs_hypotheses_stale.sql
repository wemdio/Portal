-- Track whether the stored lead-source recommendations are stale relative to the
-- current brief.
--
-- Bug: editing the brief never invalidated `lead_source_hypotheses`, so the
-- «рекомендации баз» kept showing suggestions built from the OLD brief (e.g. a
-- client changed the site reelscut → zvukograd but the recommendations still
-- reflected reelscut). The client-facing PUT also failed to clear the stored
-- recommendations on an empty («Очистить бриф») save, so wiped data lingered.
--
-- Fix: the brief PUT (client + admin) now sets this flag true on any non-empty
-- edit and nulls the recommendations on an empty save; (re)generation sets it
-- false. The client UI shows a "brief changed — regenerate" banner so stale
-- suggestions can't be mistaken for current ones.

alter table public.client_briefs
  add column if not exists lead_source_hypotheses_stale boolean not null default false;
