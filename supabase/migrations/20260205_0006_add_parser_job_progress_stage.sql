-- Parser job progress stage
alter table public.parser_jobs add column if not exists progress_stage text;
