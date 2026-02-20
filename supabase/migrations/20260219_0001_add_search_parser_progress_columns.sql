alter table public.search_parser_jobs add column if not exists progress_stage text;
alter table public.search_parser_jobs add column if not exists progress_percent integer;
