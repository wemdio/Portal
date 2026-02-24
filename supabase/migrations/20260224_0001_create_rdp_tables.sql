-- Remote Desktop: bookings & sessions
-- Bookings reserve the remote PC for a time window.
-- Sessions track actual active RDP connections.

create table if not exists public.rdp_bookings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone not null,
  status text not null default 'pending'
    check (status in ('pending','active','completed','cancelled','expired')),
  notes text,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint rdp_bookings_ends_after_starts check (ends_at > starts_at)
);

create table if not exists public.rdp_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  booking_id uuid references public.rdp_bookings(id) on delete set null,
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone,
  status text not null default 'active'
    check (status in ('active','ended')),
  created_at timestamp with time zone not null default now()
);

-- Indexes
create index if not exists idx_rdp_bookings_user_id on public.rdp_bookings(user_id);
create index if not exists idx_rdp_bookings_status on public.rdp_bookings(status);
create index if not exists idx_rdp_bookings_time_window on public.rdp_bookings(starts_at, ends_at);
create index if not exists idx_rdp_sessions_status on public.rdp_sessions(status);
create index if not exists idx_rdp_sessions_user_id on public.rdp_sessions(user_id);

-- Trigger for updated_at on bookings
create or replace function public.set_rdp_booking_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_rdp_bookings_updated_at on public.rdp_bookings;
create trigger trg_rdp_bookings_updated_at
  before update on public.rdp_bookings
  for each row execute function public.set_rdp_booking_updated_at();

-- RLS
alter table public.rdp_bookings enable row level security;
alter table public.rdp_sessions enable row level security;

-- Bookings: all authenticated users can read all bookings (to see schedule)
drop policy if exists rdp_bookings_select_all on public.rdp_bookings;
create policy rdp_bookings_select_all
  on public.rdp_bookings for select
  using (auth.uid() is not null);

-- Bookings: users can insert their own
drop policy if exists rdp_bookings_insert_own on public.rdp_bookings;
create policy rdp_bookings_insert_own
  on public.rdp_bookings for insert
  with check (auth.uid() = user_id);

-- Bookings: users can update their own (cancel)
drop policy if exists rdp_bookings_update_own on public.rdp_bookings;
create policy rdp_bookings_update_own
  on public.rdp_bookings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Bookings: users can delete their own
drop policy if exists rdp_bookings_delete_own on public.rdp_bookings;
create policy rdp_bookings_delete_own
  on public.rdp_bookings for delete
  using (auth.uid() = user_id);

-- Sessions: all authenticated users can read (to see who's connected)
drop policy if exists rdp_sessions_select_all on public.rdp_sessions;
create policy rdp_sessions_select_all
  on public.rdp_sessions for select
  using (auth.uid() is not null);

-- Sessions: users can insert their own
drop policy if exists rdp_sessions_insert_own on public.rdp_sessions;
create policy rdp_sessions_insert_own
  on public.rdp_sessions for insert
  with check (auth.uid() = user_id);

-- Sessions: users can update their own (end session)
drop policy if exists rdp_sessions_update_own on public.rdp_sessions;
create policy rdp_sessions_update_own
  on public.rdp_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Prevent overlapping bookings (excluding cancelled/expired)
create or replace function public.check_rdp_booking_overlap()
returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from public.rdp_bookings
    where id != new.id
      and status not in ('cancelled', 'expired')
      and starts_at < new.ends_at
      and ends_at > new.starts_at
  ) then
    raise exception 'Время уже занято другой бронью';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_rdp_booking_overlap on public.rdp_bookings;
create trigger trg_rdp_booking_overlap
  before insert or update on public.rdp_bookings
  for each row execute function public.check_rdp_booking_overlap();
