-- Fast preview slice for base_constructor_jobs.data.
--
-- The result `data` column is a JSONB array-of-rows that can reach tens of MB
-- (observed up to 46 MB / 16k rows). The UI only renders the first ~20 rows as
-- a preview, yet the old /data endpoint shipped the WHOLE blob DB -> app -> the
-- client browser, which then parsed it just to show 20 rows — multi-second
-- freeze + a download button stuck disabled the whole time.
--
-- This function returns only the first p_limit elements, so a preview transfers
-- ~tens of KB instead of the full blob. Ownership is still enforced by the API
-- route (it checks user_id before calling this); we additionally lock EXECUTE to
-- the service role so a client JWT cannot call it directly via PostgREST and
-- read other users' rows.

create or replace function public.base_constructor_job_data_slice(p_id uuid, p_limit int default 21)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(elem order by ord), '[]'::jsonb)
  from (
    select value as elem, ordinality as ord
    from base_constructor_jobs j
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(j.data) = 'array' then j.data else '[]'::jsonb end
    ) with ordinality
    where j.id = p_id
    order by ordinality
    limit greatest(p_limit, 0)
  ) s;
$$;

revoke all on function public.base_constructor_job_data_slice(uuid, int) from public;
revoke all on function public.base_constructor_job_data_slice(uuid, int) from anon;
revoke all on function public.base_constructor_job_data_slice(uuid, int) from authenticated;
grant execute on function public.base_constructor_job_data_slice(uuid, int) to service_role;
