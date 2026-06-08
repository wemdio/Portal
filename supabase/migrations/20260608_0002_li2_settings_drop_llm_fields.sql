-- LinkedIn Outreach 2.0: drop per-user LLM configuration columns.
--
-- v2 uses a single shared Requesty key (`OPENROUTER_LI_OUTREACH_API_KEY` env)
-- and a hard-coded `openai/gpt-4o-mini` model — the OpenOutreach `start` job
-- payload carries this directly (see campaigns/[id]/start/route.ts). Users
-- never need to set provider / model / key / base on a per-user basis any
-- more, so the columns + check constraint are dead weight.
--
-- Only touches `li2_settings` (v2). The legacy `li_outreach` v1 tables still
-- use `ai_model` and friends — leave them alone.
alter table public.li2_settings drop column if exists llm_provider;
alter table public.li2_settings drop column if exists llm_api_key;
alter table public.li2_settings drop column if exists ai_model;
alter table public.li2_settings drop column if exists llm_api_base;
