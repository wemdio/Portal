-- Instant approximate match count for the company-catalog filter UI.
-- Uses the planner's row estimate (EXPLAIN, no execution) so it returns in
-- milliseconds regardless of how many rows match — fixes the "jumping" counter
-- that came from running exact COUNT(*) over 13M rows on every filter change.

create or replace function public.pdl_count_estimate(
  p_country  text[] default null,
  p_industry text[] default null,
  p_size     text[] default null,
  p_name     text   default null
) returns bigint
language plpgsql
volatile
set search_path = public
as $$
declare
  conds text := '';
  plan  json;
begin
  if p_country is not null and array_length(p_country, 1) > 0 then
    conds := conds || format(' and country = any (%L::text[])', p_country);
  end if;
  if p_industry is not null and array_length(p_industry, 1) > 0 then
    conds := conds || format(' and industry = any (%L::text[])', p_industry);
  end if;
  if p_size is not null and array_length(p_size, 1) > 0 then
    conds := conds || format(' and size = any (%L::text[])', p_size);
  end if;
  if p_name is not null and length(trim(p_name)) > 0 then
    conds := conds || format(' and name ilike %L', '%' || trim(p_name) || '%');
  end if;

  execute 'explain (format json) select 1 from public.pdl_companies where true' || conds into plan;
  return (plan -> 0 -> 'Plan' ->> 'Plan Rows')::bigint;
end;
$$;

grant execute on function public.pdl_count_estimate(text[], text[], text[], text) to authenticated;
