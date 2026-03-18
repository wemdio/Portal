-- Safe read-only SQL execution for the Telegram AI agent.
-- Validates query is SELECT-only, blocks mutations, limits rows and time.

create or replace function public.agent_query_readonly(query_text text)
returns jsonb
language plpgsql
security definer
set statement_timeout = '10s'
set search_path = public
as $$
declare
  result jsonb;
  clean  text;
begin
  clean := regexp_replace(lower(trim(query_text)), '--.*$', '', 'gm');
  clean := regexp_replace(clean, '/\*.*?\*/', '', 'gs');
  clean := trim(clean);

  if not (clean ~ '^(select|with)\s') then
    raise exception 'Only SELECT queries are allowed';
  end if;

  if clean ~ '\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|execute|call|do|set|reset|listen|notify|prepare|deallocate|discard|cluster|vacuum|analyze|reindex|lock|load|refresh)\b' then
    raise exception 'Query contains forbidden keywords';
  end if;

  if clean ~ '\b(auth|pg_catalog|information_schema)\.' then
    raise exception 'Access to system schemas not allowed';
  end if;

  if clean ~ '\b(pg_read_file|pg_read_binary_file|lo_import|lo_export|pg_ls_dir|pg_stat_file|current_setting)\b' then
    raise exception 'Forbidden function call';
  end if;

  execute format(
    'select coalesce(jsonb_agg(row_to_json(sub)), ''[]''::jsonb) from (select * from (%s) as _q limit 200) sub',
    query_text
  ) into result;

  return result;
end;
$$;

comment on function public.agent_query_readonly(text) is
  'Execute a read-only SQL query with safety checks. Used by the Telegram AI agent.';
