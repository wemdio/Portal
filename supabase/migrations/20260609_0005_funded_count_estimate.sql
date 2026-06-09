-- Instant approximate match count for the funded-companies filter UI.
-- Uses the planner's row estimate (EXPLAIN, no execution) so it returns in
-- milliseconds regardless of how many rows match — same trick as pdl_count_estimate.

create or replace function public.funded_count_estimate(
  p_source       text[] default null,
  p_country      text[] default null,
  p_industry     text[] default null,
  p_stage        text[] default null,   -- last_funding_type values
  p_has_funding  boolean default null,  -- true => only rows with any funding signal
  p_min_funding  bigint  default null,  -- USD; matches coalesce(last_funding_usd,total_funding_usd)
  p_funded_since date    default null,  -- last_funding_date >= this
  p_name         text    default null
) returns bigint
language plpgsql
volatile
set search_path = public
as $$
declare
  conds text := '';
  plan  json;
begin
  if p_source is not null and array_length(p_source, 1) > 0 then
    conds := conds || format(' and source = any (%L::text[])', p_source);
  end if;
  if p_country is not null and array_length(p_country, 1) > 0 then
    conds := conds || format(' and country = any (%L::text[])', p_country);
  end if;
  if p_industry is not null and array_length(p_industry, 1) > 0 then
    conds := conds || format(' and industry = any (%L::text[])', p_industry);
  end if;
  if p_stage is not null and array_length(p_stage, 1) > 0 then
    conds := conds || format(' and last_funding_type = any (%L::text[])', p_stage);
  end if;
  if p_has_funding is true then
    conds := conds || ' and (last_funding_date is not null or last_funding_usd is not null or total_funding_usd is not null)';
  end if;
  if p_min_funding is not null then
    conds := conds || format(' and coalesce(last_funding_usd, total_funding_usd, 0) >= %s', p_min_funding::text);
  end if;
  if p_funded_since is not null then
    conds := conds || format(' and last_funding_date >= %L', p_funded_since);
  end if;
  if p_name is not null and length(trim(p_name)) > 0 then
    conds := conds || format(' and name ilike %L', '%' || trim(p_name) || '%');
  end if;

  execute 'explain (format json) select 1 from public.funded_companies where true' || conds into plan;
  return (plan -> 0 -> 'Plan' ->> 'Plan Rows')::bigint;
end;
$$;

grant execute on function public.funded_count_estimate(text[], text[], text[], text[], boolean, bigint, date, text) to authenticated;
