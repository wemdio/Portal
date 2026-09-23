-- Vertical Engine v2: read a project card «Дедлайн» the way the card hints it.
--
-- projects.deadline is free text, and the card editor suggests DD.MM.YY.
-- ve_try_iso_date (20260924_0010) accepted only YYYY-MM-DD, so a deadline
-- extended as «31.10.26» paused a running plan as 'no_deadline'. It now also
-- accepts DD.MM.YY and DD.MM.YYYY (two-digit year = 20YY). The same rule is
-- parseProjectDeadline in app/src/lib/verticalEngineV2/portalDeliveryTerm.ts;
-- both are checked against app/tests/helpers/projectDeadlineCases.json.

create or replace function public.ve_try_iso_date(p_value text)
returns date
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value text := btrim(p_value);
  v_parts text[];
begin
  if v_value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return v_value::date;
  end if;
  v_parts := regexp_match(v_value, '^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{2}|[0-9]{4})$');
  if v_parts is null then
    return null;
  end if;
  return make_date(
    v_parts[3]::integer + case when length(v_parts[3]) = 2 then 2000 else 0 end,
    v_parts[2]::integer,
    v_parts[1]::integer
  );
exception
  when invalid_datetime_format or datetime_field_overflow then
    return null;
end;
$$;

revoke all on function public.ve_try_iso_date(text)
  from public, anon, authenticated, service_role;

grant execute on function public.ve_try_iso_date(text) to postgres;
