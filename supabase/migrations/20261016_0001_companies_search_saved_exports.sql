-- Old ledger entries remain intact. Only new exports have downloadable files.
alter table public.client_companies_search_exports
  add column if not exists request_key text,
  add column if not exists filter_hash text,
  add column if not exists filters jsonb,
  add column if not exists storage_prefix text;

create unique index if not exists client_companies_exports_request_idx
  on public.client_companies_search_exports (user_id, request_key)
  where request_key is not null;

create index if not exists client_companies_exports_filters_idx
  on public.client_companies_search_exports (user_id, filter_hash, id desc)
  where storage_prefix is not null;

-- Files must already exist before this transaction. Charge and seen journal
-- commit together; concurrent retries return the winning export unchanged.
create or replace function public.commit_companies_search_export(
  p_user_id uuid,
  p_request_key text,
  p_filter_hash text,
  p_filters jsonb,
  p_storage_prefix text,
  p_company_ids bigint[],
  p_remaining integer,
  p_last_export_id bigint
)
returns setof public.client_companies_search_exports
language plpgsql
security definer
set search_path = public
as $$
declare
  saved public.client_companies_search_exports%rowtype;
  new_charges bigint;
  rows_count integer := cardinality(p_company_ids);
begin
  if p_user_id is null or p_request_key is null or length(p_request_key) > 100
    or p_filter_hash is null or p_filters is null or p_storage_prefix is null
    or p_remaining is null or p_remaining < 0 or p_last_export_id is null
    or rows_count is null or rows_count <= 0 then
    raise exception 'Invalid export parameters';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('companies-export:' || p_user_id::text, 0));
  select * into saved from public.client_companies_search_exports
    where user_id = p_user_id and request_key = p_request_key;
  if found then
    if saved.filter_hash is distinct from p_filter_hash then
      raise exception 'EXPORT_FILTER_MISMATCH';
    end if;
    return next saved;
    return;
  end if;

  -- The route snapshots the ledger id BEFORE reading total cross-tool usage.
  -- Subtract later company exports under the per-user lock. An overlap with
  -- that usage read can only reject conservatively, never spend twice.
  select coalesce(sum(row_count), 0) into new_charges
    from public.client_companies_search_exports
    where user_id = p_user_id and id > p_last_export_id;
  if rows_count > p_remaining - new_charges then
    raise exception 'EXPORT_QUOTA_CHANGED';
  end if;

  insert into public.client_companies_search_exports
    (user_id, row_count, request_key, filter_hash, filters, storage_prefix)
    values (p_user_id, rows_count, p_request_key, p_filter_hash, p_filters, p_storage_prefix)
    returning * into saved;
  insert into public.client_companies_search_seen (user_id, company_id, source)
    select p_user_id, id, 'export' from unnest(p_company_ids) as ids(id)
    on conflict (user_id, company_id) do nothing;
  return next saved;
end;
$$;

revoke all on function public.commit_companies_search_export(uuid, text, text, jsonb, text, bigint[], integer, bigint)
  from public, anon, authenticated;
grant execute on function public.commit_companies_search_export(uuid, text, text, jsonb, text, bigint[], integer, bigint)
  to service_role;
