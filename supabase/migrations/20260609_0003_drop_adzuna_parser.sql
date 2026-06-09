-- Remove the Adzuna parser entirely: the source is a 14-day commercial trial,
-- not viable for ongoing use. Drops the results table (and its policies/FK);
-- parser_jobs rows of type 'adzuna_companies' (if any) are deleted with it via
-- the ON DELETE CASCADE on the child, plus an explicit cleanup of orphan jobs.

drop table if exists public.adzuna_companies cascade;

delete from public.parser_jobs where parser_type = 'adzuna_companies';
