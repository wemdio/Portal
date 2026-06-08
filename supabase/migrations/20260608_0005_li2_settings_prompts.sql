-- LinkedIn Outreach 2.0: per-user editable prompts for the OpenOutreach
-- runtime.
--
-- OpenOutreach loads three Jinja2 templates from disk
-- (linkedin/templates/prompts/*.j2):
--
--   * follow_up_agent  — system prompt for the in-conversation agent
--   * qualify_lead     — prompt for the AI ICP classifier
--   * search_keywords  — prompt for the LinkedIn search-query generator
--
-- We expose these to operators so they can tweak tone/strategy without
-- redeploying the worker. Empty string = "use the upstream default" (the
-- start route falls back to the verbatim copy in
-- app/src/lib/liOutreach/v2DefaultPrompts.ts). This avoids baking ~140 lines
-- of multiline Jinja2 into a migration and keeps the upstream→Portal copy
-- syncable in code, not SQL.
--
-- The Settings UI seeds the textareas with the same default copy on first
-- load, so users see the upstream prompt as a starting point even though
-- the DB column stays empty until they explicitly save.
alter table public.li2_settings
  add column if not exists prompt_follow_up_agent  text not null default '',
  add column if not exists prompt_qualify_lead     text not null default '',
  add column if not exists prompt_search_keywords  text not null default '';

comment on column public.li2_settings.prompt_follow_up_agent is
  'OpenOutreach follow_up_agent.j2 override. Пустая строка = использовать апстрим-дефолт из v2DefaultPrompts.ts.';
comment on column public.li2_settings.prompt_qualify_lead is
  'OpenOutreach qualify_lead.j2 override. Пустая строка = апстрим-дефолт.';
comment on column public.li2_settings.prompt_search_keywords is
  'OpenOutreach search_keywords.j2 override. Пустая строка = апстрим-дефолт.';
