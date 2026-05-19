-- Lightweight listing function: returns job metadata + user count without the heavy result_users JSONB.
create or replace function public.tg_parser_jobs_list(row_limit int default 50)
returns table (
  id uuid,
  user_id uuid,
  created_at timestamptz,
  status text,
  config jsonb,
  account_id uuid,
  stop_reason text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  user_count int
)
language sql stable security invoker
as $$
  select
    j.id,
    j.user_id,
    j.created_at,
    j.status,
    j.config,
    j.account_id,
    j.stop_reason,
    j.error_message,
    j.started_at,
    j.completed_at,
    coalesce(jsonb_array_length(j.result_users), 0)::int as user_count
  from public.tg_parser_jobs j
  order by j.created_at desc
  limit row_limit;
$$;
