-- Server-side VE2 reporting only. No collection, contact or ENG mutations.
create table public.ve_daily_digests (
  id bigint generated always as identity primary key,
  channel text not null,
  report_date date not null,
  window_from timestamptz not null,
  snapshot_at timestamptz not null,
  snapshot jsonb not null,
  parts jsonb not null,
  next_part integer not null default 0 check (next_part >= 0),
  message_ids jsonb not null default '[]',
  status text not null default 'pending' check (status in ('pending','sending','uncertain','sent')),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel,report_date),
  check (jsonb_typeof(snapshot)='object' and jsonb_typeof(parts)='array' and jsonb_typeof(message_ids)='array'),
  check (next_part=jsonb_array_length(message_ids) and next_part<=jsonb_array_length(parts)),
  check (status<>'sent' or (sent_at is not null and next_part=jsonb_array_length(parts)))
);
alter table public.ve_daily_digests enable row level security;
revoke all on public.ve_daily_digests from public, anon, authenticated;
grant all on public.ve_daily_digests to service_role;
grant usage, select on sequence public.ve_daily_digests_id_seq to service_role;
comment on table public.ve_daily_digests is 'Private VE2 snapshots and Telegram receipts. Unknown send results require reconciliation before retry.';
