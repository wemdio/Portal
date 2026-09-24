-- «Рассылка» на нескольких серверах и адресах (хендофф 21.09, п. 6.2/6.3/6.5;
-- дизайн docs/superpowers/specs/2026-09-24-sender-multi-ip-design.md).
--
-- Один адрес отправки — один воркер: его контейнер сидит в Docker-сети, чей
-- исходящий NAT привязан к адресу, поэтому весь трафик воркера выходит с него.
-- Ящик закреплён за адресом (sender_mailboxes.egress_ip) и обслуживается
-- только воркером этого адреса. Общие задачи (планировщик, монитор, синк
-- Google, раздача адресов) делает один ведущий — держатель аренды 'global'.

-- ── Реестр адресов ───────────────────────────────────────────────────────────
create table if not exists public.sender_egress_ips (
  ip text primary key check (ip ~ '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'),
  -- Подпись сервера для экрана; воркер пишет её из SENDER_HOST_LABEL.
  host text not null default '',
  -- Выдавать ли адресу новые ящики. Уже закреплённые ящики не трогает.
  accepts_new boolean not null default true,
  -- Пульс воркера адреса: независимый таймер раз в 30 с.
  last_seen_at timestamptz,
  -- Ошибка самопроверки «с какого адреса меня видно»; null — всё в порядке.
  last_error text,
  created_at timestamptz not null default now()
);

alter table public.sender_egress_ips enable row level security;
grant all on public.sender_egress_ips to service_role;

comment on table public.sender_egress_ips is
  'Outbound IPs of the sender fleet: one worker container per IP (Docker network SNAT). Workers upsert their row every 30 s (heartbeat + egress self-check verdict).';

-- ── Закрепление ящика ────────────────────────────────────────────────────────
alter table public.sender_mailboxes
  add column if not exists egress_ip text references public.sender_egress_ips(ip) on update cascade;

create index if not exists idx_sender_mailboxes_egress_ip
  on public.sender_mailboxes (egress_ip);
-- Раздача адресов берёт только ящики без адреса.
create index if not exists idx_sender_mailboxes_unassigned
  on public.sender_mailboxes (created_at)
  where egress_ip is null;

-- ── Аренда общих задач ───────────────────────────────────────────────────────
create table if not exists public.sender_worker_leases (
  name text primary key,
  holder text not null,
  expires_at timestamptz not null
);

alter table public.sender_worker_leases enable row level security;
grant all on public.sender_worker_leases to service_role;

comment on table public.sender_worker_leases is
  'Leases for fleet-wide sender jobs: exactly one worker (holder = "<ip>#<process id>") runs planner/monitor/Google sync/egress assignment while its lease is fresh.';

-- Взять или продлить аренду: свою или просроченную берём, чужую живую — нет.
create or replace function public.sender_acquire_lease(
  p_name text,
  p_holder text,
  p_ttl_seconds integer
)
returns boolean
language plpgsql
as $$
declare
  v_holder text;
begin
  insert into public.sender_worker_leases as l (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_seconds))
  on conflict (name) do update
     set holder = excluded.holder,
         expires_at = excluded.expires_at
   where l.holder = excluded.holder
      or l.expires_at < now()
  returning l.holder into v_holder;
  return v_holder is not null;
end;
$$;

create or replace function public.sender_release_lease(p_name text, p_holder text)
returns void
language sql
as $$
  delete from public.sender_worker_leases
   where name = p_name
     and holder = p_holder;
$$;

-- ── Claim только своего адреса ───────────────────────────────────────────────
-- Старые сигнатуры удаляем: воркер без адреса не должен забрать ни одного
-- письма — пауза лучше, чем письмо с чужого адреса.
drop function if exists public.claim_sender_messages(integer, integer);

create or replace function public.claim_sender_messages(
  p_limit integer,
  p_egress_ip text,
  p_stale_after_seconds integer default 600
)
returns setof public.sender_messages
language plpgsql
as $$
begin
  return query
  with picked as (
    select m.id
      from public.sender_messages m
      join public.sender_mailboxes mb on mb.id = m.mailbox_id
     where ((m.status = 'scheduled' and m.scheduled_at <= now())
            or (m.status = 'sending' and m.claimed_at < now() - make_interval(secs => p_stale_after_seconds)))
       and mb.status = 'verified'
       and mb.enabled
       -- Письмо уходит только с адреса своего ящика; чужие письма воркер не
       -- видит, поэтому и «подобрать зависшее» у соседа не может.
       and mb.egress_ip = p_egress_ip
     order by m.scheduled_at
     limit p_limit
     for update of m skip locked
  )
  update public.sender_messages m
     set status = 'sending',
         claimed_at = now()
    from picked
   where m.id = picked.id
  returning m.*;
end;
$$;

comment on function public.claim_sender_messages(integer, text, integer) is
  'Atomically claims due sender_messages rows of verified+enabled mailboxes pinned to p_egress_ip (FOR UPDATE SKIP LOCKED); also reclaims rows stuck in sending past p_stale_after_seconds — only for the same egress IP.';

drop function if exists public.claim_sender_manual_messages(integer, integer);

create or replace function public.claim_sender_manual_messages(
  p_limit integer,
  p_egress_ip text,
  p_stale_after_seconds integer default 600
)
returns setof public.sender_manual_messages
language plpgsql
as $$
begin
  return query
  with picked as (
    select mm.id
      from public.sender_manual_messages mm
      join public.sender_mailboxes mb on mb.id = mm.mailbox_id
     where ((mm.status = 'queued')
            or (mm.status = 'sending' and mm.updated_at < now() - make_interval(secs => p_stale_after_seconds)))
       and mb.egress_ip = p_egress_ip
     order by mm.created_at
     limit p_limit
     for update of mm skip locked
  )
  update public.sender_manual_messages m
     set status = 'sending',
         updated_at = now()
    from picked
   where m.id = picked.id
  returning m.*;
end;
$$;

-- ── Раздача адресов новым ящикам (зовёт ведущий каждый тик) ─────────────────
-- Адрес живой (пульс свежее p_fresh_seconds), без ошибки самопроверки и
-- принимает новые ящики. Сначала адрес, где уже живёт домен ящика, иначе
-- наименее загруженный.
create or replace function public.sender_assign_egress_ips(p_fresh_seconds integer default 300)
returns integer
language plpgsql
as $$
declare
  v_mailbox record;
  v_ip text;
  v_count integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('sender_assign_egress_ips'));
  for v_mailbox in
    select id, lower(split_part(email, '@', 2)) as domain
      from public.sender_mailboxes
     where egress_ip is null
     order by created_at, email
     limit 500
  loop
    v_ip := null;
    select e.ip into v_ip
      from public.sender_egress_ips e
     where e.accepts_new
       and e.last_error is null
       and e.last_seen_at > now() - make_interval(secs => p_fresh_seconds)
     order by
       exists (
         select 1
           from public.sender_mailboxes m
          where m.egress_ip = e.ip
            and lower(split_part(m.email, '@', 2)) = v_mailbox.domain
       ) desc,
       (select count(*) from public.sender_mailboxes m where m.egress_ip = e.ip),
       e.ip
     limit 1;
    exit when v_ip is null;
    -- updated_at не трогаем: монитор считает по нему «упавшие за час» ящики.
    update public.sender_mailboxes set egress_ip = v_ip where id = v_mailbox.id;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- ── Сводка для экрана и монитора ─────────────────────────────────────────────
-- Отправленное считается по текущему адресу ящика: перенесённый сегодня ящик
-- отдаёт свои письма новому адресу. Для сводки «ушло сегодня» этого хватает.
create or replace function public.sender_egress_overview(p_since timestamptz)
returns table (
  ip text,
  host text,
  accepts_new boolean,
  last_seen_at timestamptz,
  last_error text,
  created_at timestamptz,
  mailboxes bigint,
  enabled_mailboxes bigint,
  sent_since bigint
)
language sql
stable
as $$
  select e.ip,
         e.host,
         e.accepts_new,
         e.last_seen_at,
         e.last_error,
         e.created_at,
         (select count(*) from public.sender_mailboxes m where m.egress_ip = e.ip),
         (select count(*) from public.sender_mailboxes m where m.egress_ip = e.ip and m.enabled),
         (select count(*)
            from public.sender_messages s
            join public.sender_mailboxes m on m.id = s.mailbox_id
           where m.egress_ip = e.ip
             and s.status = 'sent'
             and s.sent_at >= p_since)
    from public.sender_egress_ips e
   order by e.host, e.ip
$$;

-- ── Адреса парка и разовая раскладка (решение владельца 24.09.2026) ─────────
-- 144.31.54.166 и 31.76.79.220 остаются пробам почт — рассылка с них уходит.
insert into public.sender_egress_ips (ip, host) values
  ('45.84.222.95', '144.31.54.166'),
  ('45.84.222.124', '144.31.54.166'),
  ('77.239.125.235', '77.239.125.235'),
  ('84.21.173.12', '77.239.125.235')
on conflict (ip) do nothing;

-- Домен целиком на один адрес. Сначала домены с работающими ящиками — по
-- кругу, чтобы живая отправка легла на все адреса поровну; затем остальные
-- домены по убыванию размера на наименее загруженный адрес.
do $$
declare
  v_ips text[] := array['45.84.222.95', '45.84.222.124', '77.239.125.235', '84.21.173.12'];
  v_domain record;
  v_ip text;
  v_i integer := 0;
begin
  for v_domain in
    select lower(split_part(email, '@', 2)) as domain
      from public.sender_mailboxes
     where egress_ip is null
       and enabled
       and status = 'verified'
     group by 1
     order by count(*) desc, 1
  loop
    v_ip := v_ips[(v_i % array_length(v_ips, 1)) + 1];
    v_i := v_i + 1;
    update public.sender_mailboxes
       set egress_ip = v_ip
     where egress_ip is null
       and lower(split_part(email, '@', 2)) = v_domain.domain;
  end loop;

  for v_domain in
    select lower(split_part(email, '@', 2)) as domain
      from public.sender_mailboxes
     where egress_ip is null
     group by 1
     order by count(*) desc, 1
  loop
    select t.ip into v_ip
      from unnest(v_ips) as t(ip)
     order by (select count(*) from public.sender_mailboxes m where m.egress_ip = t.ip), t.ip
     limit 1;
    update public.sender_mailboxes
       set egress_ip = v_ip
     where egress_ip is null
       and lower(split_part(email, '@', 2)) = v_domain.domain;
  end loop;
end;
$$;
