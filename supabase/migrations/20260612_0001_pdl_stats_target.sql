-- Raise planner statistics on the pdl_companies filter columns so the instant
-- approximate count (public.pdl_count_estimate, which reads EXPLAIN plan-rows
-- instead of a real COUNT over ~19.5M rows) is near-exact per country.
--
-- With the whole-world dataset (~19.5M companies across 249 countries) the
-- default statistics target of 100 under-counted single-country filters by
-- ~15% (e.g. UAE showed ≈106k vs 126,735 actual). Target 1000 puts every
-- country / common industry in the MCV list, bringing the estimate within ~1%.
alter table public.pdl_companies alter column country  set statistics 1000;
alter table public.pdl_companies alter column industry set statistics 1000;
alter table public.pdl_companies alter column size     set statistics 500;

analyze public.pdl_companies;
