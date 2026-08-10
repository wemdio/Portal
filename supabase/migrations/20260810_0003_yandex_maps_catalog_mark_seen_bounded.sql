-- Once an organization has missed two exhaustive searches, the closure signal
-- is complete. Rewriting it on every later discovery pass adds no information
-- and creates avoidable heap/index churn on the multi-million-row catalog.
create or replace function public.yandex_maps_catalog_mark_seen(
  p_seen text[],
  p_country text,
  p_place text,
  p_rubric text,
  p_exhaustive boolean default false
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  suspected integer := 0;
begin
  if p_seen is not null and cardinality(p_seen) > 0 then
    update public.yandex_maps_company_catalog
       set last_seen_in_search_at = now(),
           missing_streak = 0,
           closed_suspected_at = null
     where yandex_id = any(p_seen);
  end if;

  if not coalesce(p_exhaustive, false) then
    return 0;
  end if;

  with candidates as (
    select c.yandex_id
      from public.yandex_maps_company_catalog c
     where c.country = p_country
       and (c.city = p_place or c.region = p_place)
       and public.yandex_maps_rubric_tokens(c.categories, c.subcategories)
           && array[btrim(lower(p_rubric))]
       and c.missing_streak < 2
       and not (c.yandex_id = any(coalesce(p_seen, array[]::text[])))
  )
  update public.yandex_maps_company_catalog c
     set missing_streak = c.missing_streak + 1,
         closed_suspected_at = case
           when c.missing_streak + 1 >= 2 then now()
           else c.closed_suspected_at
         end
    from candidates
   where c.yandex_id = candidates.yandex_id;

  get diagnostics suspected = row_count;
  return suspected;
end;
$$;

grant execute on function public.yandex_maps_catalog_mark_seen(text[], text, text, text, boolean)
  to service_role;
