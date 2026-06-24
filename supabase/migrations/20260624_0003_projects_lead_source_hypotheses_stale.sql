-- Track whether a project's stored lead-source recommendations are stale relative
-- to the current brief — the project-side mirror of client_briefs.20260621_0002.
--
-- Bug: re-uploading a project brief PDF replaces brief_text but KEEPS the prior
-- lead_source_hypotheses verbatim (POST .../brief returns them with
-- hypotheses_pending=false), so old recommendations were presented as current for
-- the new brief. Fix: the brief upload marks them stale and (re)generation clears
-- the flag; the UI shows a «бриф изменён — пересоздайте» banner.

alter table public.projects
  add column if not exists lead_source_hypotheses_stale boolean not null default false;
