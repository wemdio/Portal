-- Parser job progress percent
alter table public.parser_jobs add column if not exists progress_percent integer;
