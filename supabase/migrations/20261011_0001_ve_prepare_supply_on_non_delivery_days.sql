-- Prepare the approved two-workday stock before the next sending day.
-- Sending weekdays still belong to delivery reservation/upload, not collection,
-- saved-result recovery or the supply audit. Keep every other eligibility guard.
-- Patch the installed body so prior deadline/ownership protections and ACLs
-- survive unchanged. Reject an unexpected definition; a replay is a no-op.
do $migration$
declare
  v_oid oid := 'public.ve_require_contact_supply_active(uuid,timestamptz)'::regprocedure;
  v_def text;
  v_before text := E'      and extract(dow from timezone(p.delivery_timezone,p_now))::smallint=any(p.delivery_schedule_days)\n';
  v_marker text := '-- VE2 stock preparation outside sending weekdays 20261011';
begin
  v_def := pg_catalog.pg_get_functiondef(v_oid);
  if position(v_marker in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def,v_before,''))) / length(v_before) <> 1 then
    raise exception 'Unexpected supply weekday eligibility definition';
  end if;
  if position('AS $function$' in v_def) = 0 then
    raise exception 'Unexpected supply eligibility function delimiter';
  end if;
  -- The former weekday predicate also rejected absent/infinite time and an
  -- empty calendar. Preserve those input guards without restricting today.
  v_def := replace(v_def,v_before,E'      and p_now is not null and pg_catalog.isfinite(p_now)\n      and cardinality(p.delivery_schedule_days)>0\n');
  v_def := replace(v_def,'AS $function$','AS $function$'||E'\n'||v_marker||E'\n');
  execute v_def;
end;
$migration$;
