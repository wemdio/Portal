alter table public.li_campaigns
  add column if not exists ai_model text default null;
