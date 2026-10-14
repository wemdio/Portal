# «Рассылка» на нескольких серверах и адресах — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Рассылка идёт с четырёх адресов на двух серверах. Каждый ящик закреплён за одним адресом, общие задачи выполняет один ведущий воркер, деплой идёт на список серверов.

**Architecture:** Один адрес — один контейнер воркера в Docker-сети с SNAT на этот адрес (`com.docker.network.host_ipv4`). Воркер знает свой адрес из `SENDER_EGRESS_IP`, проверяет его внешними сервисами и обслуживает только ящики с `sender_mailboxes.egress_ip = свой`. Общие задачи (раздача адресов, синк Google, планировщик, проверка доставки проб, монитор) выполняет держатель аренды `global` в `sender_worker_leases`. Compose на каждом сервере собирает `render-compose.sh` из `SENDER_EGRESS_IPS` в `.env`.

**Tech Stack:** Postgres (Supabase) plpgsql, Node 22 / TypeScript worker, supabase-js, Next.js app router, Docker Compose v5, Semaphore CI (bash).

**Spec:** `docs/superpowers/specs/2026-09-24-sender-multi-ip-design.md`

**Правила проекта, которые меняют стандартный процесс:**
- Новые `*.test.ts` не создаём, `it()` в существующие файлы не добавляем без согласования (CLAUDE.md, «Правило: тесты пишем скупо»). Вместо TDD проверяем так: типы (`npm run typecheck:strict`), существующий набор тестов, прогон SQL на временном Postgres, сборка compose на серверах.
- Dev-сервер не поднимаем (память «Не запускать проект локально»).
- Коммиты — в `feat/sender-multi-ip`, push только в эту ветку. Merge и deploy делает владелец.

---

## Файлы

| Файл | Что делает |
|---|---|
| `supabase/migrations/20260924_0020_sender_multi_ip.sql` (новый) | реестр адресов, `egress_ip`, аренда, claim с адресом, раздача адресов, сводка, разовая раскладка |
| `app/src/lib/sender/egress.ts` (новый) | личность воркера, самопроверка адреса, пульс в реестр, аренда (`LeaseKeeper`), начало суток по Москве |
| `app/worker/sender.ts` | тик: самопроверка → пульс → общие задачи у ведущего → задачи своих ящиков |
| `app/src/lib/sender/types.ts` | `MailboxRow.egress_ip` |
| `app/src/lib/sender/sendWorker.ts` | claim с `p_egress_ip`, возврат письма перенесённого ящика |
| `app/src/lib/sender/verifyWorker.ts` | проверка только своих ящиков |
| `app/src/lib/sender/repliesWorker.ts` | опрос только своих ящиков |
| `app/src/lib/sender/manualWorker.ts` | claim с `p_egress_ip`, возврат перенесённого |
| `app/src/lib/sender/probeWorker.ts` | `sendPendingProbes` (свои ящики) и `checkDeliveredProbes` (ведущий) вместо `processSendProbes` |
| `app/src/lib/sender/monitorWorker.ts` | алерты: адрес молчит, ошибка адреса, ящики без адреса |
| `app/src/app/api/tools/sender/egress/route.ts` (новый) | GET сводки адресов, PATCH `accepts_new` |
| `app/src/app/api/tools/sender/mailboxes/route.ts` | `egress_ip` в списке, фильтр `egressIp`, массовое действие `move` |
| `app/src/components/sender/api.ts` | DTO и вызовы адресов |
| `app/src/components/sender/EgressPanel.tsx` (новый) | блок «Адреса отправки» и меню «На адрес» |
| `app/src/components/sender/MailboxTags.tsx` | экспорт `useDismiss` |
| `app/src/components/sender/MailboxesTab.tsx` | колонка «Адрес», фильтр, перенос, блок адресов |
| `deploy/sender/worker.base.yml` (новый) | описание воркера (бывший `docker-compose.yml`) |
| `deploy/sender/render-compose.sh` (новый) | сборка compose сервера из `SENDER_EGRESS_IPS` |
| `deploy/sender/docker-compose.yml` | удалить: теперь собирается на сервере |
| `deploy/sender/.env.example` | новые переменные |
| `.semaphore/scheduled-deploy.yml` | деплой на список sender-хостов |
| `AGENTS.md` | карта: два sender-хоста, новые файлы деплоя |

---

### Task 1: Миграция

**Files:**
- Create: `supabase/migrations/20260924_0020_sender_multi_ip.sql`

- [ ] **Step 1: Написать миграцию**

```sql
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
```

Сигнатуры claim — `(p_limit, p_egress_ip, p_stale_after_seconds default 600)`: параметр с умолчанием обязан идти последним. Вызов из кода — именованными аргументами, поэтому порядок роли не играет.

- [ ] **Step 2: Прогнать правило грантов**

Run: `cd app && npx jest tests/migrations --silent`
Expected: PASS (у обеих новых таблиц есть `grant all ... to service_role`).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260924_0020_sender_multi_ip.sql
git commit -m "feat(sender): реестр адресов отправки, закрепление ящиков, аренда общих задач"
```

---

### Task 2: Проверить миграцию на временном Postgres (77.239.125.235)

**Files:** нет изменений в репозитории.

- [ ] **Step 1: Поднять временную базу**

```bash
ssh -i ~/.ssh/portal_sender_ed25519 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes root@77.239.125.235 \
  'docker run -d --name pg-scratch -e POSTGRES_PASSWORD=scratch postgres:16-alpine >/dev/null && for i in $(seq 1 30); do docker exec pg-scratch pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done; docker exec pg-scratch psql -U postgres -c "create role service_role; create role authenticated; create role anon;"'
```
Expected: `CREATE ROLE`.

- [ ] **Step 2: Накатить миграции сендера до новой**

```bash
for f in $(ls supabase/migrations/*sender*.sql | sort | grep -v 20260924_0020); do
  echo "== $f"; ssh ... root@77.239.125.235 'docker exec -i pg-scratch psql -v ON_ERROR_STOP=1 -q -1 -U postgres' < "$f" || break
done
```
Expected: все файлы без ошибок. Если какой-то файл ссылается на объекты вне sender (отдельные view или функции), создать заглушку и повторить.

- [ ] **Step 3: Засеять синтетику формы прода**

8 ящиков Maildoso (`verified`, включены, по одному на домен) и 210 ящиков Google (`pending`, выключены, 58 доменов по 1–4 ящика):

```sql
insert into public.sender_mailboxes (provider, email, username, smtp_host, status, enabled)
select 'maildoso', 'box' || g || '@md' || g || '.test', 'box' || g || '@md' || g || '.test', 'smtp.maildoso.test', 'verified', true
  from generate_series(1, 8) g;
insert into public.sender_mailboxes (provider, auth_type, email, username, smtp_host, status, enabled)
select 'google', 'google_sa', 'u' || n || '@gd' || d || '.test', 'u' || n || '@gd' || d || '.test', 'smtp.gmail.com', 'pending', false
  from generate_series(1, 58) d
  cross join lateral generate_series(1, case when d <= 36 then 4 else 3 end) n;
select count(*) from public.sender_mailboxes;
```
Expected: `218` (36 доменов по 4 + 22 по 3 = 210 Google, плюс 8 Maildoso).

- [ ] **Step 4: Накатить новую миграцию и проверить раскладку**

```sql
select egress_ip, count(*) total, count(*) filter (where enabled and status = 'verified') active,
       count(distinct split_part(email, '@', 2)) domains
  from public.sender_mailboxes group by 1 order by 1;
select count(*) as split_domains from (
  select split_part(email, '@', 2) from public.sender_mailboxes group by 1 having count(distinct egress_ip) > 1) x;
```
Expected: 4 строки без `null`, по 2 активных на адрес, итоги отличаются не больше чем на 4, `split_domains = 0`.

- [ ] **Step 5: Проверить аренду, claim, раздачу, сводку**

```sql
select public.sender_acquire_lease('global', 'a#1', 90);   -- t
select public.sender_acquire_lease('global', 'b#1', 90);   -- f
select public.sender_acquire_lease('global', 'a#1', 90);   -- t (продление)
select public.sender_release_lease('global', 'a#1');
select public.sender_acquire_lease('global', 'b#1', 90);   -- t
update public.sender_worker_leases set expires_at = now() - interval '1 second';
select public.sender_acquire_lease('global', 'a#1', 90);   -- t (просрочена)

-- claim: письмо ящика на адресе X видит только X
insert into public.sender_campaigns (name) values ('t') returning id;  -- :cid
-- recipient + message по ящику box1@md1.test (verified, enabled)
select count(*) from public.claim_sender_messages(10, '203.0.113.1');       -- 0
select count(*) from public.claim_sender_messages(10, '<адрес box1>');      -- 1
select public.claim_sender_messages(10);                                     -- ERROR: function does not exist

-- раздача: свежий пульс у всех, новый ящик домена gd1 → адрес gd1
update public.sender_egress_ips set last_seen_at = now();
insert into public.sender_mailboxes (provider, email, username, smtp_host) values ('custom', 'new@gd1.test', 'new@gd1.test', 'smtp.test');
select public.sender_assign_egress_ips();                                   -- 1
select egress_ip = (select egress_ip from public.sender_mailboxes where email like '%@gd1.test' and email <> 'new@gd1.test' limit 1)
  from public.sender_mailboxes where email = 'new@gd1.test';               -- t
-- протухший пульс — адрес не выдаётся
update public.sender_egress_ips set last_seen_at = now() - interval '1 hour';
insert into public.sender_mailboxes (provider, email, username, smtp_host) values ('custom', 'x@fresh.test', 'x@fresh.test', 'smtp.test');
select public.sender_assign_egress_ips();                                   -- 0
select * from public.sender_egress_overview(now() - interval '1 day');     -- 4 строки с числами
```
Колонки кампании, получателя и письма брать из `20260916_0001_sender_tool.sql`, обязательные поля заполнить значениями-заглушками.

- [ ] **Step 6: Убрать временную базу**

```bash
ssh ... root@77.239.125.235 'docker rm -f pg-scratch >/dev/null; docker image rm postgres:16-alpine >/dev/null; docker ps -a'
```
Expected: контейнеров нет.

---

### Task 3: Модуль адреса воркера

**Files:**
- Create: `app/src/lib/sender/egress.ts`

- [ ] **Step 1: Написать модуль**

```ts
import 'server-only';

import { randomUUID } from 'node:crypto';
import { supabaseAdmin } from '@/lib/supabaseAdmin';

/**
 * Адрес отправки воркера «Рассылки».
 *
 * Один воркер = один адрес: контейнер сидит в Docker-сети, чей исходящий NAT
 * привязан к адресу (deploy/sender/render-compose.sh), поэтому весь трафик —
 * SMTP, IMAP, токены Google — выходит с него без участия кода. Код отвечает за
 * три вещи: знать свой адрес (SENDER_EGRESS_IP), убедиться, что интернет видит
 * именно его, и сообщать о себе в реестр sender_egress_ips.
 *
 * Общие задачи парка выполняет держатель аренды — см. LeaseKeeper.
 */

type Log = (level: 'info' | 'warn' | 'error', msg: string, extra?: unknown) => void;

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Сервисы «с какого адреса меня видно»: ответ — голый IPv4 текстом. */
const ECHO_URLS = ['https://api.ipify.org', 'https://icanhazip.com', 'https://ifconfig.me/ip'];
const ECHO_TIMEOUT_MS = 8_000;

export const GLOBAL_LEASE = 'global';
export const LEASE_TTL_SECONDS = 90;
const LEASE_RENEW_MS = 20_000;
/** Запас до истечения аренды: часы воркера и БД расходятся, а продление может запоздать. */
const LEASE_SAFETY_MS = 15_000;

export function isIpv4(value: unknown): value is string {
  return typeof value === 'string' && IPV4_RE.test(value);
}

export interface EgressIdentity {
  ip: string;
  /** Подпись сервера для экрана «Адреса отправки». */
  host: string;
  /** Держатель аренды: адрес + id процесса — старый и новый контейнер одного адреса различаются. */
  holder: string;
}

export function egressIdentityFromEnv(env: NodeJS.ProcessEnv = process.env): EgressIdentity | null {
  const ip = (env.SENDER_EGRESS_IP ?? '').trim();
  if (!isIpv4(ip)) return null;
  return {
    ip,
    host: (env.SENDER_HOST_LABEL ?? '').trim(),
    holder: `${ip}#${randomUUID().slice(0, 8)}`,
  };
}

export type EgressVerdict = { ok: true } | { ok: false; error: string } | { ok: null };

/**
 * Вердикт по ответам echo-сервисов:
 * - кто-то назвал чужой адрес — ошибка, даже если остальные назвали наш;
 * - все ответившие назвали наш — подтверждено;
 * - никто внятно не ответил — вердикта нет.
 */
export function judgeEgress(expected: string, seen: (string | null)[]): EgressVerdict {
  const answers = seen.filter((s): s is string => isIpv4(s));
  if (!answers.length) return { ok: null };
  const foreign = answers.find((s) => s !== expected);
  if (foreign) return { ok: false, error: `Воркер выходит в интернет с ${foreign}, а должен с ${expected}` };
  return { ok: true };
}

async function askEcho(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ECHO_TIMEOUT_MS) });
    if (!res.ok) return null;
    return (await res.text()).trim();
  } catch {
    return null;
  }
}

export async function checkEgress(expected: string): Promise<EgressVerdict> {
  const seen = await Promise.all(ECHO_URLS.map(askEcho));
  return judgeEgress(expected, seen);
}

/** Пульс и вердикт самопроверки в реестр. Строки нет — заводим; accepts_new не трогаем. */
export async function reportEgress(identity: EgressIdentity, lastError: string | null): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const row: Record<string, unknown> = {
    ip: identity.ip,
    last_seen_at: new Date().toISOString(),
    last_error: lastError,
  };
  if (identity.host) row.host = identity.host;
  const { error } = await supabaseAdmin.from('sender_egress_ips').upsert(row, { onConflict: 'ip' });
  return !error;
}

async function acquireLease(name: string, holder: string, ttlSeconds: number): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const { data, error } = await supabaseAdmin.rpc('sender_acquire_lease', {
    p_name: name,
    p_holder: holder,
    p_ttl_seconds: ttlSeconds,
  });
  return !error && data === true;
}

async function releaseLease(name: string, holder: string): Promise<void> {
  if (!supabaseAdmin) return;
  await supabaseAdmin.rpc('sender_release_lease', { p_name: name, p_holder: holder });
}

/**
 * Держит аренду независимым таймером, как heartbeat: долгий тик (двадцать
 * писем подряд) аренду не теряет, а мёртвый event loop — теряет, и её через
 * TTL подхватывает другой воркер. Воркер с неподтверждённым адресом аренду
 * не берёт и отдаёт: иначе общие задачи встали бы у того, кто сам не работает.
 */
export class LeaseKeeper {
  private held = false;
  private heldUntil = 0;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly name: string,
    private readonly holder: string,
    private readonly log: Log,
    private readonly eligible: () => boolean,
  ) {}

  start(): void {
    void this.renew();
    this.timer = setInterval(() => void this.renew(), LEASE_RENEW_MS);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  isHeld(): boolean {
    return this.held && Date.now() < this.heldUntil;
  }

  private async renew(): Promise<void> {
    const was = this.held;
    if (!this.eligible()) {
      if (was) await releaseLease(this.name, this.holder).catch(() => {});
      this.held = false;
      if (was) this.log('warn', `Аренда «${this.name}» отдана: адрес воркера не подтверждён`);
      return;
    }
    const ok = await acquireLease(this.name, this.holder, LEASE_TTL_SECONDS).catch(() => false);
    this.held = ok;
    if (ok) this.heldUntil = Date.now() + LEASE_TTL_SECONDS * 1000 - LEASE_SAFETY_MS;
    if (ok !== was) {
      this.log('info', ok
        ? `Аренда «${this.name}» наша — выполняю общие задачи парка`
        : `Аренда «${this.name}» у другого воркера`);
    }
  }

  /** Штатная остановка: аренду отдаём сразу, а не ждём её истечения. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.held) await releaseLease(this.name, this.holder).catch(() => {});
    this.held = false;
  }
}

/** Начало текущих суток по Москве (UTC+3 без перехода на летнее время), ISO. */
export function startOfMoscowDayIso(now: Date = new Date()): string {
  const MSK_MS = 3 * 60 * 60 * 1000;
  const msk = new Date(now.getTime() + MSK_MS);
  msk.setUTCHours(0, 0, 0, 0);
  return new Date(msk.getTime() - MSK_MS).toISOString();
}
```

- [ ] **Step 2: Commit**

```bash
git add app/src/lib/sender/egress.ts
git commit -m "feat(sender): адрес воркера — самопроверка, пульс в реестр, аренда общих задач"
```

---

### Task 4: Задачи ящиков — только своего адреса

**Files:**
- Modify: `app/src/lib/sender/types.ts` (MailboxRow)
- Modify: `app/src/lib/sender/sendWorker.ts:101-132`
- Modify: `app/src/lib/sender/verifyWorker.ts:20-33`
- Modify: `app/src/lib/sender/repliesWorker.ts:213-225`
- Modify: `app/src/lib/sender/manualWorker.ts:41-67`
- Modify: `app/src/lib/sender/probeWorker.ts:278, 345-361`

- [ ] **Step 1: `types.ts` — поле адреса**

В `MailboxRow` после `google_account`:

```ts
  /** Адрес отправки, за которым закреплён ящик; null — ещё не выдан. */
  egress_ip: string | null;
```

- [ ] **Step 2: `sendWorker.ts`**

Сигнатура и claim:

```ts
export async function processSenderBatch(opts: { egressIp: string; batchSize?: number; log?: Log }): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});
  const batchSize = opts.batchSize ?? 20;

  const { data: claimed, error: claimError } = await db.rpc('claim_sender_messages', {
    p_limit: batchSize,
    p_egress_ip: opts.egressIp,
  });
  if (claimError) {
    log('warn', `Очередь писем не забралась: ${claimError.message}`);
    return false;
  }
```

Перед проверкой `if (!mailbox || mailbox.status !== 'verified')`:

```ts
    if (mailbox && mailbox.egress_ip !== opts.egressIp) {
      // Ящик перенесли на другой адрес между claim и отправкой: письмо уйдёт
      // с нового адреса его воркером, а не с нашего.
      await db.from('sender_messages').update({ status: 'scheduled' }).eq('id', message.id);
      continue;
    }
```

Шапку файла поправить: «Письмо берётся атомарно и только для ящиков адреса этого воркера…».

- [ ] **Step 3: `verifyWorker.ts`**

```ts
export async function verifyPendingMailboxes(opts: { egressIp: string; log?: Log }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data } = await db
    .from('sender_mailboxes')
    .select('*')
    .eq('status', 'pending')
    .eq('enabled', true)
    // Вход в ящик — только с его адреса: проверка с чужого адреса — это и
    // есть «вход из необычного места», от которого закрепление защищает.
    .eq('egress_ip', opts.egressIp)
    .order('created_at')
    .limit(BATCH);
```

- [ ] **Step 4: `repliesWorker.ts`**

```ts
export async function processSenderReplies(opts: { egressIp: string; log?: Log }): Promise<boolean> {
  if (!supabaseAdmin) return false;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data: mailboxRows } = await db
    .from('sender_mailboxes')
    .select('*')
    .eq('status', 'verified')
    .eq('enabled', true)
    .eq('egress_ip', opts.egressIp)
    .not('imap_host', 'is', null)
```

- [ ] **Step 5: `manualWorker.ts`**

```ts
export async function processManualMessages(opts: { egressIp: string; log?: Log; batchSize?: number }): Promise<number> {
  if (!supabaseAdmin) return 0;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data: claimed, error: claimError } = await db.rpc('claim_sender_manual_messages', {
    p_limit: opts.batchSize ?? 5,
    p_egress_ip: opts.egressIp,
  });
```

После загрузки ящика, перед проверкой статуса:

```ts
    if (mailbox && mailbox.egress_ip !== opts.egressIp) {
      // Ящик перенесли между claim и отправкой — ответ уйдёт с нового адреса.
      await db.from('sender_manual_messages').update({ status: 'queued', updated_at: nowIso }).eq('id', message.id);
      continue;
    }
```

- [ ] **Step 6: `probeWorker.ts`**

`checkDeliveredProbes` сделать экспортируемой (`export async function checkDeliveredProbes(log: Log)`), тип `Log` экспортировать не нужно: параметр совпадает с логгером воркера структурно. `processSendProbes` заменить на:

```ts
/**
 * Отправка заведённых проб — только с ящиков своего адреса: проба — такой же
 * вход в ящик, как рассылка. Проверку доставки (контрольный ящик, не наш)
 * делает ведущий: checkDeliveredProbes.
 */
export async function sendPendingProbes(opts: { egressIp: string; log?: Log }): Promise<void> {
  if (!supabaseAdmin) return;
  const db = supabaseAdmin;
  const log: Log = opts.log ?? (() => {});

  const { data: pending } = await db
    .from('sender_send_probes')
    .select('id, mailbox_id')
    .eq('status', 'pending')
    .order('created_at')
    .limit(50);
  const rows = (pending ?? []) as { id: string; mailbox_id: string }[];
  if (!rows.length) return;

  const { data: owned } = await db
    .from('sender_mailboxes')
    .select('id')
    .in('id', [...new Set(rows.map((r) => r.mailbox_id))])
    .eq('egress_ip', opts.egressIp);
  const mine = new Set((owned ?? []).map((row) => String(row.id)));

  for (const probe of rows.filter((r) => mine.has(r.mailbox_id)).slice(0, SEND_PER_TICK)) {
    await sendProbe(probe, log);
  }
}
```

- [ ] **Step 7: Commit**

```bash
git add app/src/lib/sender/types.ts app/src/lib/sender/sendWorker.ts app/src/lib/sender/verifyWorker.ts app/src/lib/sender/repliesWorker.ts app/src/lib/sender/manualWorker.ts app/src/lib/sender/probeWorker.ts
git commit -m "feat(sender): ящики обслуживает только воркер их адреса"
```

---

### Task 5: Воркер — самопроверка, пульс, ведущий

**Files:**
- Modify: `app/worker/sender.ts` (целиком)

- [ ] **Step 1: Переписать `sender.ts`**

```ts
/**
 * Sender worker — собственная отправка писем инструмента «Рассылка».
 *
 * Один воркер = один адрес отправки (SENDER_EGRESS_IP). Контейнер сидит в
 * Docker-сети, чей исходящий NAT привязан к этому адресу, поэтому весь его
 * трафик выходит с него. Воркер обслуживает только ящики своего адреса:
 * проверка входа, отправка, ответы, проверочные и ручные письма.
 *
 * Общие задачи парка — раздача адресов новым ящикам, синк каталога Google,
 * планировщик, проверка доставки проб, монитор — выполняет один ведущий:
 * держатель аренды 'global' в БД.
 *
 * Прод: сервис worker-<ip> в compose, собранном deploy/sender/render-compose.sh
 * на каждом sender-хосте. Всё общение с порталом — через БД.
 */
import { createWorkerLogger, requireSupabaseAdmin, setupGracefulShutdown, pollLoop, startWorkerHeartbeat } from './_shared';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { verifyPendingMailboxes } from '@/lib/sender/verifyWorker';
import { planSenderMessages } from '@/lib/sender/planner';
import { processSenderBatch } from '@/lib/sender/sendWorker';
import { processSenderReplies } from '@/lib/sender/repliesWorker';
import { checkDeliveredProbes, sendPendingProbes } from '@/lib/sender/probeWorker';
import { processManualMessages } from '@/lib/sender/manualWorker';
import { runSenderMonitor } from '@/lib/sender/monitorWorker';
import { syncGoogleWorkspaceMailboxes } from '@/lib/sender/googleSyncWorker';
import {
  checkEgress,
  egressIdentityFromEnv,
  GLOBAL_LEASE,
  LeaseKeeper,
  reportEgress,
  type EgressIdentity,
} from '@/lib/sender/egress';

const log = createWorkerLogger('sender');

/**
 * Heartbeat-файл: обновляется независимым setInterval-тиком, docker
 * healthcheck на sender-хосте читает mtime и с autoheal перезапускает
 * контейнер при event-loop hang (см. инциденты tgOutreach 35ч и yandexmaps
 * 27.07.2026 — процесс жив, письма не идут).
 */
const HEARTBEAT_PATH = '/tmp/sender-worker-heartbeat';

const REPLIES_INTERVAL_MS = Number(process.env.SENDER_REPLIES_INTERVAL_MS ?? 60_000);
let lastRepliesAt = 0;

// Каталог Workspace меняется редко — раз в час достаточно, чтобы новый ящик
// появился на экране в тот же рабочий час, а домен на сотню ящиков не дёргал
// Google каждую минуту.
const GOOGLE_SYNC_INTERVAL_MS = Number(process.env.SENDER_GOOGLE_SYNC_INTERVAL_MS ?? 3_600_000);
let lastGoogleSyncAt = 0;

// Монитор (5.7/5.8): метрики, TG-алерты и автопауза доменов. Реже отправки —
// метрики скользящие, чаще незачем, а TG не должен шуметь.
const MONITOR_INTERVAL_MS = Number(process.env.SENDER_MONITOR_INTERVAL_MS ?? 300_000);
let lastMonitorAt = 0;

/** Как часто перепроверять, с какого адреса нас видит интернет. */
const EGRESS_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Пульс в реестр адресов — независимым таймером, как heartbeat-файл. */
const EGRESS_REPORT_INTERVAL_MS = 30_000;

/** null — успешной проверки ещё не было; до неё ящики не трогаем. */
let egressOk: boolean | null = null;
let egressError: string | null = null;
let lastEgressCheckAt = 0;
let registryReady = false;

async function refreshEgressVerdict(identity: EgressIdentity): Promise<void> {
  if (egressOk !== null && Date.now() - lastEgressCheckAt < EGRESS_CHECK_INTERVAL_MS) return;
  lastEgressCheckAt = Date.now();
  const verdict = await checkEgress(identity.ip);
  if (verdict.ok === true) {
    if (egressOk !== true) log('info', `Адрес отправки подтверждён: ${identity.ip}`);
    egressOk = true;
    egressError = null;
  } else if (verdict.ok === false) {
    if (egressOk !== false) log('error', verdict.error);
    egressOk = false;
    egressError = verdict.error;
  } else if (egressOk === null) {
    // Сеть сама по себе не меняется: прежний вердикт живёт, пока сервисы молчат.
    log('warn', 'Сервисы определения адреса не ответили — ящики не трогаю до первой успешной проверки');
  }
}

async function report(identity: EgressIdentity): Promise<void> {
  registryReady = await reportEgress(identity, egressOk === false ? egressError : null);
}

async function guarded(name: string, job: () => Promise<unknown>): Promise<void> {
  try {
    await job();
  } catch (e) {
    log('warn', `${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Общие задачи парка — только у держателя аренды. */
async function runFleetJobs(): Promise<void> {
  const db = supabaseAdmin;
  if (!db) return;

  await guarded('Раздача адресов новым ящикам', async () => {
    const { data, error } = await db.rpc('sender_assign_egress_ips');
    if (error) throw new Error(error.message);
    if (Number(data) > 0) log('info', `Новым ящикам выданы адреса: ${data}`);
  });

  if (Date.now() - lastGoogleSyncAt >= GOOGLE_SYNC_INTERVAL_MS) {
    lastGoogleSyncAt = Date.now();
    // Отказ Google не должен ронять отправку: без каталога портал работает по
    // тем ящикам, что уже подключены.
    await guarded('Каталог Google не синхронизировался', () => syncGoogleWorkspaceMailboxes({ log }));
  }

  await guarded('Планировщик не отработал', () => planSenderMessages({ log }));
  await guarded('Доставка проб не проверилась', () => checkDeliveredProbes(log));

  if (Date.now() - lastMonitorAt >= MONITOR_INTERVAL_MS) {
    lastMonitorAt = Date.now();
    await guarded('Монитор не отработал', () => runSenderMonitor({ log }));
  }
}

function makeTick(identity: EgressIdentity, lease: LeaseKeeper) {
  const egressIp = identity.ip;
  return async function tick(): Promise<boolean> {
    await refreshEgressVerdict(identity);
    await report(identity);
    // Реестра нет — миграция ещё не применена (sender-хосты выкатываются раньше
    // миграций портала) или БД недоступна: без реестра ящики не трогаем.
    if (!registryReady) {
      log('warn', 'Реестр адресов недоступен — жду');
      return false;
    }

    if (lease.isHeld()) await runFleetJobs();
    if (egressOk !== true) return false;

    await verifyPendingMailboxes({ log, egressIp });
    const sent = await processSenderBatch({ log, egressIp });

    // Входящие опрашиваем реже отправки: IMAP-опрос всех ящиков дорогой, а
    // новые ответы не требуют реакции в ту же секунду.
    if (Date.now() - lastRepliesAt >= REPLIES_INTERVAL_MS) {
      lastRepliesAt = Date.now();
      await processSenderReplies({ log, egressIp });
    }

    // Проверочные отправки и ручные ответы операторов — с ящиков своего адреса.
    await guarded('Проверочные отправки не обработались', () => sendPendingProbes({ log, egressIp }));
    await guarded('Ручные ответы не обработались', () => processManualMessages({ log, egressIp }));

    return sent;
  };
}

async function main() {
  requireSupabaseAdmin(log);
  const identity = egressIdentityFromEnv();
  if (!identity) {
    // Без адреса воркер не знает, чьи ящики его: работать «со всеми» значит
    // входить в чужие ящики с чужого адреса. Падение видно в docker ps.
    log('error', 'SENDER_EGRESS_IP не задан или не IPv4 — воркер не знает своего адреса');
    process.exit(1);
  }

  const shouldStop = setupGracefulShutdown(log);
  startWorkerHeartbeat(HEARTBEAT_PATH);
  log('info', `Heartbeat ticker started → ${HEARTBEAT_PATH} (every 30s)`);

  const reporter = setInterval(() => void report(identity), EGRESS_REPORT_INTERVAL_MS);
  if (typeof reporter.unref === 'function') reporter.unref();

  const lease = new LeaseKeeper(GLOBAL_LEASE, identity.holder, log, () => egressOk === true);
  lease.start();

  log('info', `Sender worker started: адрес ${identity.ip}${identity.host ? `, сервер ${identity.host}` : ''}, держатель ${identity.holder}`);

  await pollLoop({
    log,
    pollIntervalMs: 15_000,
    shouldStop,
    realtimeTables: ['sender_messages'],
    pollOnce: makeTick(identity, lease),
  });

  clearInterval(reporter);
  await lease.stop();
}

void main();
```

- [ ] **Step 2: Commit**

```bash
git add app/worker/sender.ts
git commit -m "feat(sender): воркер работает от своего адреса, общие задачи — у ведущего"
```

---

### Task 6: Монитор — алерты по адресам

**Files:**
- Modify: `app/src/lib/sender/monitorWorker.ts`

- [ ] **Step 1: Метрики и правила**

В `MonitorMetrics` (поля необязательные — существующий тест строит метрики без них):

```ts
  /** Адреса отправки: сколько ящиков держат, сколько минут молчит воркер, ошибка адреса. */
  egress?: { ip: string; host: string; mailboxes: number; silentMinutes: number; lastError: string | null }[];
  /** Ящиков без адреса отправки дольше UNASSIGNED_ALERT_MINUTES. */
  unassignedMailboxes?: number;
```

Константы рядом с `DEFAULT_THRESHOLDS`:

```ts
/** Воркер адреса молчит дольше — его ящики не шлют и не читают ответы. */
export const EGRESS_SILENT_MINUTES = 10;
/** Ящик без адреса дольше — раздать его некому. */
const UNASSIGNED_ALERT_MINUTES = 15;
```

В `evaluateSenderHealth` после блока `mailboxes_failed`:

```ts
  for (const e of m.egress ?? []) {
    // Адрес без ящиков никого не держит: молчит он или нет — не важно.
    if (e.mailboxes === 0) continue;
    const where = e.host ? ` (сервер ${e.host})` : '';
    if (e.lastError) {
      alerts.push({
        key: `egress_error:${e.ip}`,
        title: `Рассылка: адрес ${e.ip} выходит не оттуда`,
        lines: [
          `${e.lastError}${where}.`,
          `Его ${e.mailboxes} ящиков не шлют и не читают ответы, пока сеть сервера не исправят.`,
        ],
      });
    } else if (e.silentMinutes >= EGRESS_SILENT_MINUTES) {
      alerts.push({
        key: `egress_silent:${e.ip}`,
        title: `Рассылка: адрес ${e.ip} молчит`,
        lines: [
          `Воркер адреса${where} не выходил на связь ${Math.round(e.silentMinutes)} мин.`,
          `Его ${e.mailboxes} ящиков не шлют и не читают ответы. Перенести: «Ящики» → выбрать → «На адрес».`,
        ],
      });
    }
  }

  if ((m.unassignedMailboxes ?? 0) > 0) {
    alerts.push({
      key: 'egress_unassigned',
      title: 'Рассылка: ящики без адреса отправки',
      lines: [
        `${m.unassignedMailboxes} ящиков ждут адрес дольше ${UNASSIGNED_ALERT_MINUTES} мин: нет работающего адреса, который принимает новые ящики.`,
      ],
    });
  }
```

- [ ] **Step 2: Сбор метрик**

В `collectMetrics` добавить в `Promise.all` два запроса и разобрать их:

```ts
  const [sentHour, due, oldestDue, failedBoxes, domainRows, egressRows, unassigned] = await Promise.all([
    /* …пять существующих запросов без изменений… */
    db.rpc('sender_egress_overview', { p_since: hourAgo }),
    db.from('sender_mailboxes').select('id', { count: 'exact', head: true })
      .is('egress_ip', null)
      .lt('created_at', new Date(Date.now() - UNASSIGNED_ALERT_MINUTES * 60_000).toISOString()),
  ]);

  if (egressRows.error) log('warn', `sender_egress_overview не посчитался: ${egressRows.error.message}`);
  // Пульс считаем от заведения адреса, если воркер ещё ни разу не выходил на
  // связь: свежезаведённый адрес не должен алертить в первую же минуту.
  const egress = ((egressRows.data ?? []) as {
    ip: string; host: string; mailboxes: number; last_seen_at: string | null; created_at: string; last_error: string | null;
  }[]).map((row) => ({
    ip: row.ip,
    host: row.host,
    mailboxes: Number(row.mailboxes),
    lastError: row.last_error,
    silentMinutes: (Date.now() - new Date(row.last_seen_at ?? row.created_at).getTime()) / 60_000,
  }));
```

и в возвращаемый объект — `egress, unassignedMailboxes: unassigned.count ?? 0`.

- [ ] **Step 3: Прогнать тест монитора**

Run: `cd app && npx jest tests/lib/senderMonitor.test.ts --silent`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/src/lib/sender/monitorWorker.ts
git commit -m "feat(sender): алерты — адрес молчит, выходит не оттуда, ящики без адреса"
```

---

### Task 7: API адресов и перенос ящиков

**Files:**
- Create: `app/src/app/api/tools/sender/egress/route.ts`
- Modify: `app/src/app/api/tools/sender/mailboxes/route.ts`

- [ ] **Step 1: Маршрут адресов**

```ts
import { NextRequest, NextResponse } from 'next/server';
import { authenticateRequest, jsonError } from '@/lib/sender/apiHelpers';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { isIpv4, startOfMoscowDayIso } from '@/lib/sender/egress';
import { withToolTrace } from '@/lib/toolTrace';

export const dynamic = 'force-dynamic';

/**
 * Пульс воркера идёт раз в 30 с независимым таймером; три минуты тишины —
 * воркер лежит или сервер недоступен.
 */
const SILENT_AFTER_MS = 3 * 60 * 1000;

interface OverviewRow {
  ip: string;
  host: string;
  accepts_new: boolean;
  last_seen_at: string | null;
  last_error: string | null;
  mailboxes: number;
  enabled_mailboxes: number;
  sent_since: number;
}

/** GET — адреса отправки: сервер, жив ли воркер, сколько ящиков и писем за сегодня. */
export async function GET(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.egress.list' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const { data, error } = await supabaseAdmin.rpc('sender_egress_overview', { p_since: startOfMoscowDayIso() });
    if (error) return jsonError(error.message, 500);

    const { count: unassigned } = await supabaseAdmin
      .from('sender_mailboxes')
      .select('id', { count: 'exact', head: true })
      .is('egress_ip', null);

    const now = Date.now();
    const ips = ((data ?? []) as OverviewRow[]).map((row) => {
      const seenAt = row.last_seen_at ? new Date(row.last_seen_at).getTime() : null;
      const state = row.last_error
        ? 'error'
        : seenAt !== null && now - seenAt < SILENT_AFTER_MS ? 'online' : 'silent';
      return {
        ip: row.ip,
        host: row.host,
        acceptsNew: row.accepts_new,
        state,
        lastSeenAt: row.last_seen_at,
        lastError: row.last_error,
        mailboxes: Number(row.mailboxes),
        enabledMailboxes: Number(row.enabled_mailboxes),
        sentToday: Number(row.sent_since),
      };
    });

    return NextResponse.json({ ips, unassigned: unassigned ?? 0 });
  });
}

/**
 * PATCH — выдавать ли адресу новые ящики. Уже закреплённые ящики переключатель
 * не трогает: их переносят явно, действием «На адрес».
 */
export async function PATCH(req: NextRequest) {
  return withToolTrace({ request: req, operation: 'tools.sender.egress.update' }, async () => {
    const auth = await authenticateRequest(req.headers.get('authorization'));
    if ('error' in auth) return auth.error;
    if (!supabaseAdmin) return jsonError('Сервис не настроен', 503);

    const body = (await req.json().catch(() => null)) as { ip?: unknown; acceptsNew?: unknown } | null;
    if (!isIpv4(body?.ip)) return jsonError('Неизвестный адрес', 400);
    if (typeof body?.acceptsNew !== 'boolean') return jsonError('Ожидается acceptsNew', 400);

    const { data, error } = await supabaseAdmin
      .from('sender_egress_ips')
      .update({ accepts_new: body.acceptsNew })
      .eq('ip', body.ip)
      .select('ip')
      .maybeSingle();
    if (error) return jsonError(error.message, 500);
    if (!data) return jsonError('Адрес не найден', 404);

    return NextResponse.json({ ok: true });
  });
}
```

- [ ] **Step 2: Список ящиков и массовый перенос (`mailboxes/route.ts`)**

- В `LIST_COLS` после `tag_id,` добавить `egress_ip,`.
- `import { isIpv4 } from '@/lib/sender/egress';`
- В GET после фильтра по тегам:

```ts
    // Фильтр по адресу отправки: 'none' — ящики, которым адрес ещё не выдан.
    const egressFilter = url.searchParams.get('egressIp') ?? '';
    if (egressFilter === 'none') query = query.is('egress_ip', null);
    else if (isIpv4(egressFilter)) query = query.eq('egress_ip', egressFilter);
```

- `BULK_ACTIONS` — добавить `'move'`; тип body — `{ ids?: unknown; action?: unknown; tagId?: unknown; egressIp?: unknown }`.
- Перед веткой `if (action === 'delete')`:

```ts
    // «На адрес»: ящик закреплён за адресом навсегда, перенос — осознанное
    // действие оператора (адрес умер или выгорел). updated_at не трогаем:
    // монитор считает по нему «упавшие за час» ящики.
    if (action === 'move') {
      if (!isIpv4(body.egressIp)) return jsonError('Неизвестный адрес', 400);
      const { data: target } = await supabaseAdmin
        .from('sender_egress_ips').select('ip').eq('ip', body.egressIp).maybeSingle();
      if (!target) return jsonError('Адрес не найден', 404);
      const { error, count } = await supabaseAdmin
        .from('sender_mailboxes')
        .update({ egress_ip: body.egressIp }, { count: 'exact' })
        .in('id', ids);
      if (error) return jsonError(error.message, 500);
      return NextResponse.json({ ok: true, affected: count ?? 0 });
    }
```

- [ ] **Step 3: Commit**

```bash
git add app/src/app/api/tools/sender/egress/route.ts app/src/app/api/tools/sender/mailboxes/route.ts
git commit -m "feat(sender): API адресов отправки и переноса ящиков"
```

---

### Task 8: Экран — блок адресов, колонка, фильтр, перенос

**Files:**
- Modify: `app/src/components/sender/api.ts`
- Modify: `app/src/components/sender/MailboxTags.tsx` (экспорт `useDismiss`)
- Create: `app/src/components/sender/EgressPanel.tsx`
- Modify: `app/src/components/sender/MailboxesTab.tsx`

- [ ] **Step 1: `api.ts`**

В `MailboxDto` после `google_account`:

```ts
  /** Адрес отправки, за которым закреплён ящик; null — выдаётся автоматически. */
  egress_ip: string | null;
```

В `fetchMailboxes` параметр `egressIp?: string` и `if (params.egressIp) query.set('egressIp', params.egressIp);`.

Новое:

```ts
/** Адрес отправки: с него выходит в интернет свой воркер. */
export interface EgressIpDto {
  ip: string;
  host: string;
  acceptsNew: boolean;
  /** online — воркер на связи; silent — давно не выходил; error — выходит в интернет не с того адреса. */
  state: 'online' | 'silent' | 'error';
  lastSeenAt: string | null;
  lastError: string | null;
  mailboxes: number;
  enabledMailboxes: number;
  sentToday: number;
}

export function fetchEgressIps() {
  return authFetchJson<{ ips: EgressIpDto[]; unassigned: number }>(`${BASE}/egress`);
}

export function setEgressAcceptsNew(ip: string, acceptsNew: boolean) {
  return authFetchJson<{ ok: true }>(`${BASE}/egress`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, acceptsNew }),
  });
}

/** Перенести выбранные ящики на другой адрес отправки. */
export function moveMailboxes(ids: string[], egressIp: string) {
  return authFetchJson<{ ok: true; affected: number }>(`${BASE}/mailboxes`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, action: 'move', egressIp }),
  });
}
```

- [ ] **Step 2: `MailboxTags.tsx`** — `function useDismiss` → `export function useDismiss`.

- [ ] **Step 3: `EgressPanel.tsx`**

```tsx
'use client';

import { useCallback, useState } from 'react';
import { ChevronDown, Server } from 'lucide-react';
import type { EgressIpDto } from './api';
import { useDismiss } from './MailboxTags';

/**
 * Адреса отправки: с каждого выходит в интернет свой воркер, и каждый ящик
 * закреплён за одним адресом. Блок показывает, жив ли адрес и сколько на нём
 * ящиков; меню «На адрес» переносит выбранные ящики.
 */

const STATE_LABELS: Record<EgressIpDto['state'], { text: string; className: string }> = {
  online: { text: 'Работает', className: 'bg-emerald-50 text-emerald-700' },
  silent: { text: 'Молчит', className: 'bg-amber-50 text-amber-700' },
  error: { text: 'Ошибка адреса', className: 'bg-red-50 text-red-700' },
};

function silentFor(lastSeenAt: string | null): string {
  if (!lastSeenAt) return 'ни разу не выходил на связь';
  const minutes = Math.round((Date.now() - new Date(lastSeenAt).getTime()) / 60_000);
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} ч` : `${Math.round(hours / 24)} дн`;
}

export function EgressPanel({
  ips,
  unassigned,
  filter,
  busyIp,
  onFilter,
  onToggleAcceptsNew,
}: {
  ips: EgressIpDto[];
  unassigned: number;
  filter: string | null;
  busyIp: string | null;
  onFilter: (ip: string | null) => void;
  onToggleAcceptsNew: (row: EgressIpDto) => void;
}) {
  if (!ips.length) return null;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white">
      <div className="flex items-center justify-between border-b border-zinc-200 px-5 py-3">
        <h2 className="text-base font-semibold text-zinc-900">Адреса отправки</h2>
        {filter ? (
          <button
            type="button"
            onClick={() => onFilter(null)}
            className="rounded-md px-2 py-1 text-xs text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700"
          >
            Показать ящики всех адресов
          </button>
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-zinc-500">
            <tr className="border-b border-zinc-200">
              <th className="px-5 py-2 font-medium">Адрес</th>
              <th className="px-3 py-2 font-medium">Сервер</th>
              <th className="px-3 py-2 font-medium">Состояние</th>
              <th className="px-3 py-2 font-medium">Ящиков</th>
              <th className="px-3 py-2 font-medium">Отправлено сегодня</th>
              <th className="px-5 py-2 font-medium">Новые ящики</th>
            </tr>
          </thead>
          <tbody>
            {ips.map((row) => {
              const state = STATE_LABELS[row.state];
              return (
                <tr
                  key={row.ip}
                  className={`border-b border-zinc-100 last:border-0 ${filter === row.ip ? 'bg-blue-50/40' : ''}`}
                >
                  <td className="px-5 py-2.5">
                    {/* Клик по адресу — его ящики в таблице ниже. */}
                    <button
                      type="button"
                      onClick={() => onFilter(filter === row.ip ? null : row.ip)}
                      title="Показать ящики этого адреса"
                      className="font-mono text-xs text-blue-600 underline-offset-2 hover:underline"
                    >
                      {row.ip}
                    </button>
                  </td>
                  <td className="px-3 py-2.5 font-mono text-xs text-zinc-500">{row.host || '—'}</td>
                  <td className="px-3 py-2.5">
                    <span
                      title={row.lastError ?? undefined}
                      className={`rounded-md px-2 py-0.5 text-xs font-medium ${state.className}`}
                    >
                      {state.text}
                    </span>
                    {row.state === 'silent' ? (
                      <span className="ml-2 text-xs text-zinc-400">{silentFor(row.lastSeenAt)}</span>
                    ) : null}
                    {row.state === 'error' && row.lastError ? (
                      <div className="mt-0.5 text-xs text-red-600">{row.lastError}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-700">
                    {row.mailboxes}
                    {row.mailboxes ? (
                      <span className="ml-1 text-xs text-zinc-400">(в рассылке {row.enabledMailboxes})</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5 text-zinc-700">{row.sentToday}</td>
                  <td className="px-5 py-2.5">
                    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-zinc-600">
                      <input
                        type="checkbox"
                        checked={row.acceptsNew}
                        disabled={busyIp === row.ip}
                        onChange={() => onToggleAcceptsNew(row)}
                        className="h-4 w-4 cursor-pointer rounded border-zinc-300"
                      />
                      Выдавать
                    </label>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {unassigned > 0 ? (
        <p className="border-t border-zinc-200 px-5 py-2.5 text-xs text-amber-700">
          Ждут адреса: {unassigned}. Адрес выдаётся сам в течение минуты, если есть работающий адрес с включённой
          выдачей новых ящиков.
        </p>
      ) : null}
    </div>
  );
}

/** Меню «На адрес» в панели выделения. */
export function EgressMoveMenu({
  ips,
  disabled,
  onPick,
}: {
  ips: EgressIpDto[];
  disabled: boolean;
  onPick: (ip: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);

  if (!ips.length) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs text-zinc-700 hover:bg-zinc-100 disabled:opacity-50"
      >
        <Server className="h-3.5 w-3.5" />
        На адрес
        <ChevronDown className="h-3 w-3 opacity-60" />
      </button>

      {open ? (
        <div className="absolute left-0 z-30 mt-1 w-72 rounded-xl border border-zinc-200 bg-white p-1.5 shadow-lg">
          {ips.map((row) => {
            const state = STATE_LABELS[row.state];
            return (
              <button
                key={row.ip}
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(row.ip);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-zinc-700 hover:bg-zinc-100"
              >
                <span className="font-mono text-xs">{row.ip}</span>
                <span className="flex-1 truncate text-xs text-zinc-400">{row.host}</span>
                <span className={`rounded-md px-1.5 py-0.5 text-[10px] font-medium ${state.className}`}>{state.text}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 4: `MailboxesTab.tsx`**

Импорты: из `./api` добавить `fetchEgressIps, moveMailboxes, setEgressAcceptsNew, type EgressIpDto`; `import { EgressMoveMenu, EgressPanel } from './EgressPanel';`.

Состояние после `noTagFilter`:

```ts
  const [egressIps, setEgressIps] = useState<EgressIpDto[]>([]);
  const [unassigned, setUnassigned] = useState(0);
  // Фильтр по адресу — клик по адресу в блоке «Адреса отправки».
  const [egressFilter, setEgressFilter] = useState<string | null>(null);
  const [egressBusy, setEgressBusy] = useState<string | null>(null);
```

`load`: в `fetchMailboxes({...})` добавить `egressIp: egressFilter ?? undefined,`; в зависимости `useCallback` — `egressFilter`.

После `loadTags`:

```ts
  const loadEgress = useCallback(async () => {
    try {
      const res = await fetchEgressIps();
      setEgressIps(res.ips);
      setUnassigned(res.unassigned);
    } catch {
      /* адреса не доехали — блок просто не покажется */
    }
  }, []);

  useEffect(() => {
    void loadEgress();
    // Пульс воркеров — раз в 30 с; чаще опрашивать незачем.
    const timer = window.setInterval(() => void loadEgress(), 30_000);
    return () => window.clearInterval(timer);
  }, [loadEgress]);
```

Обработчики после `resetTagFilter`:

```ts
  const filterByEgress = (ip: string | null) => {
    setEgressFilter(ip);
    resetToFirstPage();
  };

  const toggleAcceptsNew = async (row: EgressIpDto) => {
    setEgressBusy(row.ip);
    setError(null);
    try {
      await setEgressAcceptsNew(row.ip, !row.acceptsNew);
      await loadEgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось переключить адрес');
    } finally {
      setEgressBusy(null);
    }
  };

  /** «На адрес»: ящик закреплён за адресом, перенос — осознанное действие. */
  const moveToEgress = async (ip: string) => {
    const ids = [...selected];
    if (!ids.length) return;
    if (!window.confirm(
      `Перенести выбранные ящики (${ids.length}) на адрес ${ip}? Следующий вход в почту у них будет уже с нового адреса.`,
    )) return;
    setBulkBusy(true);
    setError(null);
    try {
      await moveMailboxes(ids, ip);
      setSelected(new Set());
      await Promise.all([load(page), loadEgress()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось перенести ящики');
    } finally {
      setBulkBusy(false);
    }
  };
```

JSX:
- между карточкой «Подключить ящики файлом» и полосой поиска:

```tsx
      <EgressPanel
        ips={egressIps}
        unassigned={unassigned}
        filter={egressFilter}
        busyIp={egressBusy}
        onFilter={filterByEgress}
        onToggleAcceptsNew={(row) => void toggleAcceptsNew(row)}
      />
```

- заголовок списка: `Ящики ({total})` → `Ящики ({total}){egressFilter ? ` · адрес ${egressFilter}` : ''}`;
- панель выделения после `TagAssignMenu`: `<EgressMoveMenu ips={egressIps} disabled={bulkBusy} onPick={(ip) => void moveToEgress(ip)} />`;
- пустой список: условие `appliedSearch || tagFilterKey || noTagFilter || egressFilter`;
- шапка таблицы после «Тег»: `<th className="px-3 py-2 font-medium">Адрес</th>`;
- ячейка после ячейки тега:

```tsx
                      <td className="px-3 py-2.5">
                        {mailbox.egress_ip ? (
                          <span className="font-mono text-xs text-zinc-600">{mailbox.egress_ip}</span>
                        ) : (
                          <span className="text-xs text-zinc-400" title="Адрес выдаётся автоматически в течение минуты">
                            ждёт адреса
                          </span>
                        )}
                      </td>
```

- [ ] **Step 5: Commit**

```bash
git add app/src/components/sender/api.ts app/src/components/sender/MailboxTags.tsx app/src/components/sender/EgressPanel.tsx app/src/components/sender/MailboxesTab.tsx
git commit -m "feat(sender): блок «Адреса отправки», колонка и перенос ящиков на адрес"
```

---

### Task 9: Compose по адресам сервера

**Files:**
- Create: `deploy/sender/worker.base.yml`
- Create: `deploy/sender/render-compose.sh`
- Delete: `deploy/sender/docker-compose.yml`
- Modify: `deploy/sender/.env.example`

- [ ] **Step 1: `worker.base.yml`** — содержимое сервиса `worker-sender` из нынешнего `docker-compose.yml` (image, env_file, environment, stop_grace_period, labels, healthcheck, deploy, restart) под именем `worker`, без `container_name`. Шапка:

```yaml
# Воркер «Рассылки» — общее описание для всех адресов отправки сервера.
#
# Сам по себе не запускается: render-compose.sh собирает docker-compose.yml, где
# на каждый адрес из SENDER_EGRESS_IPS (.env) — сервис `extends` этого описания
# со своим SENDER_EGRESS_IP и своя сеть с исходящим NAT на этот адрес.
#
# Почему отдельные серверы: массовые SMTP/IMAP-подключения не должны идти с IP
# портала (139.60.162.24), иначе хостер банит весь интернет сервера. Этот файл
# живёт ТОЛЬКО на sender-хостах и никогда не добавляется в docker-compose.prod.yml.
```

- [ ] **Step 2: `render-compose.sh`**

```sh
#!/bin/sh
# Собирает docker-compose.yml «Рассылки» для ЭТОГО сервера из SENDER_EGRESS_IPS
# в .env: на каждый адрес — воркер (extends worker.base.yml) и сеть, чей
# исходящий NAT привязан к адресу (com.docker.network.host_ipv4). Весь трафик
# воркера — SMTP, IMAP, Google — выходит с его адреса без участия кода.
#
# Адрес, которого нет на интерфейсах сервера, — ошибка: воркер такого адреса
# выходил бы в интернет не оттуда, где закреплены его ящики.
#
# Деплой зовёт это сам (Semaphore scheduled-deploy). Руками, в /opt/portal-sender:
#   sh render-compose.sh .env > docker-compose.yml
#   docker compose -p portal-sender --env-file .env pull
#   docker compose -p portal-sender --env-file .env up -d --remove-orphans
set -eu

ENV_FILE="${1:-.env}"
[ -f "$ENV_FILE" ] || { echo "render-compose: нет $ENV_FILE" >&2; exit 1; }

ips=$(grep -E '^SENDER_EGRESS_IPS=' "$ENV_FILE" | tail -n1 | cut -d= -f2- | tr -d "\"' \r" | tr ',' ' ')
[ -n "$ips" ] || { echo "render-compose: SENDER_EGRESS_IPS пуст в $ENV_FILE" >&2; exit 1; }

host_ips=$(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1)
seen=" "
for ip in $ips; do
  echo "$ip" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || { echo "render-compose: «$ip» — не IPv4" >&2; exit 1; }
  echo "$host_ips" | grep -qx "$ip" || { echo "render-compose: адреса $ip нет на интерфейсах сервера" >&2; exit 1; }
  case "$seen" in *" $ip "*) echo "render-compose: $ip указан дважды" >&2; exit 1 ;; esac
  seen="$seen$ip "
done

cat <<'EOF'
# СГЕНЕРИРОВАНО deploy/sender/render-compose.sh из SENDER_EGRESS_IPS (.env).
# Руками не править: следующий деплой перезапишет.
services:
  # Перезапускает воркер, чей healthcheck (heartbeat-файл) протух: процесс жив,
  # а event loop мёртв. Сети ему не нужно — только docker.sock.
  autoheal:
    image: willfarrell/autoheal:1.2.0
    environment:
      - AUTOHEAL_CONTAINER_LABEL=autoheal
      - AUTOHEAL_INTERVAL=30
      - AUTOHEAL_START_PERIOD=180
      - DOCKER_SOCK=/var/run/docker.sock
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
    network_mode: none
    deploy:
      resources:
        limits:
          memory: 64M
          cpus: '0.1'
          pids: 512
    restart: unless-stopped
EOF

for ip in $ips; do
  slug=$(echo "$ip" | tr . -)
  cat <<EOF
  worker-$slug:
    extends:
      file: worker.base.yml
      service: worker
    environment:
      - SENDER_EGRESS_IP=$ip
    networks:
      - egress-$slug
EOF
done

echo "networks:"
for ip in $ips; do
  slug=$(echo "$ip" | tr . -)
  cat <<EOF
  egress-$slug:
    driver: bridge
    driver_opts:
      com.docker.network.host_ipv4: "$ip"
EOF
done
```

- [ ] **Step 3: `.env.example`** — шапку исправить на «sender-хост (144.31.54.166, 77.239.125.235…)» и добавить:

```
# Адреса отправки ЭТОГО сервера через запятую: на каждый — свой воркер
# (render-compose.sh). Адрес должен быть поднят на интерфейсе сервера.
SENDER_EGRESS_IPS=
# Подпись сервера на экране «Адреса отправки» (обычно основной IP сервера)
SENDER_HOST_LABEL=

# Ящики Google Workspace без паролей (служебный аккаунт с делегированием)
# SENDER_GOOGLE_SA_EMAIL=
# SENDER_GOOGLE_SA_PRIVATE_KEY=
# Алерты монитора в Telegram
# SENDER_ALERTS_TELEGRAM_CHAT_ID=
# SENDER_ALERTS_TELEGRAM_BOT_TOKEN=
```

- [ ] **Step 4: Проверить сборку на серверах (без запуска на 144)**

На 77 и 144: скопировать `worker.base.yml` и `render-compose.sh` в `/tmp/sender-render-test/`, туда же `.env` из двух строк (`DOCKER_USERNAME=test`, `SENDER_EGRESS_IPS=<адреса сервера>`), выполнить:

```bash
cd /tmp/sender-render-test && sh render-compose.sh .env > docker-compose.yml && docker compose -p sender-render-test --env-file .env config >/dev/null && echo RENDER_OK
printf 'SENDER_EGRESS_IPS=203.0.113.9\n' > bad.env && sh render-compose.sh bad.env >/dev/null; echo "exit=$?"
```
Expected: `RENDER_OK`; для чужого адреса — `адреса 203.0.113.9 нет на интерфейсах сервера`, `exit=1`.

Только на 77 — сквозная проверка сетей: override с `image: alpine:3.20` и `command: wget -qO- -T 10 http://api.ipify.org` для обоих воркеров, `restart: "no"`, без healthcheck; `docker compose ... up` только воркер-сервисов, в логах каждого — его адрес. Потом `down`, удалить `/tmp/sender-render-test` и образ alpine.

- [ ] **Step 5: Commit**

```bash
git add deploy/sender/worker.base.yml deploy/sender/render-compose.sh deploy/sender/.env.example
git rm deploy/sender/docker-compose.yml
git commit -m "feat(deploy): compose «Рассылки» собирается на сервере — по воркеру на адрес"
```

---

### Task 10: CI — деплой на список sender-хостов

**Files:**
- Modify: `.semaphore/scheduled-deploy.yml:287-387, 709-718`

- [ ] **Step 1: Заменить блок sender-хоста**

Вместо одного `SENDER_HOST` — цикл по `SENDER_SSH_HOST` и `SENDER_SSH_HOST_2..9`. На каждый хост: свой бюджет 300 с, preflight, `mkdir`, scp `worker.base.yml` + `render-compose.sh`, render (`sh render-compose.sh .env > docker-compose.yml.new && mv …`), pull, проверка бюджета, `up -d --pull never --remove-orphans`, `docker ps --filter label=com.docker.compose.project=portal-sender`. Сбой хоста копится в `SENDER_DEPLOY_SKIPPED` строкой `<хост>: <причина>`, остальные хосты и портал выкладываются штатно. Функции `run_sender_bounded/run_ssh_sender/run_scp_sender` — без изменений. Для n>1:

```bash
eval "SENDER_HOST=\${SENDER_SSH_HOST_${n}}"
eval "SENDER_USER=\${SENDER_SSH_USER_${n}:-\${SENDER_SSH_USER:-\$USER}}"
eval "SENDER_PASS=\${SENDER_SSH_PASSWORD_${n}:-}"
eval "SENDER_PATH=\${SENDER_REMOTE_DIR_${n}:-/opt/portal-sender}"
```

- [ ] **Step 2: Текст алерта** (строка 717): «обновление воркеров «Рассылки» НЕ подтверждено — ${SENDER_DEPLOY_SKIPPED}. Руками — см. шапку deploy/sender/render-compose.sh.»

- [ ] **Step 3: Проверить синтаксис**

Run: `python -c "import yaml,sys; yaml.safe_load(open('.semaphore/scheduled-deploy.yml', encoding='utf-8'))" && echo YAML_OK` и `bash .semaphore/test-select-deploy-targets.sh`
Expected: `YAML_OK`, тесты выбора целей зелёные. Вынуть команды блока во временный файл и `bash -n` — без ошибок.

- [ ] **Step 4: Commit**

```bash
git add .semaphore/scheduled-deploy.yml
git commit -m "ci(deploy): воркеры «Рассылки» выкатываются на список sender-хостов по очереди"
```

---

### Task 11: Документация

**Files:**
- Modify: `AGENTS.md:21-22`
- Modify: `docs/superpowers/specs/2026-09-24-sender-multi-ip-design.md` (порядок аргументов claim)

- [ ] **Step 1: `AGENTS.md`** — строка про sender: два хоста (`144.31.54.166`, `77.239.125.235`), по воркеру на адрес отправки, compose собирается `deploy/sender/render-compose.sh` из `SENDER_EGRESS_IPS`, CI-цели `SENDER_SSH_HOST`, `SENDER_SSH_HOST_2`. Правило изоляции: «must run on a sender host (`144.31.54.166`, `77.239.125.235`) or another dedicated host the owner names»; адреса проб почт (`144.31.54.166`, `31.76.79.220`) под рассылку не отдавать.

- [ ] **Step 2: Спека** — сигнатуры claim `(p_limit, p_egress_ip, p_stale_after_seconds default 600)`.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md docs/superpowers/specs/2026-09-24-sender-multi-ip-design.md
git commit -m "docs(sender): карта sender-хостов и адресов отправки"
```

---

### Task 12: Проверка и push

- [ ] **Step 1: Типы** — `cd app && npm run typecheck:strict`. Expected: без ошибок.
- [ ] **Step 2: Линт изменённых файлов** — `cd app && npx eslint src/lib/sender src/app/api/tools/sender src/components/sender worker/sender.ts`. Expected: без ошибок.
- [ ] **Step 3: Тесты сендера и миграций** — `cd app && npx jest tests/lib/senderMonitor.test.ts tests/lib/senderHardening.test.ts tests/migrations --silent`. Expected: PASS.
- [ ] **Step 4: Полный набор** — `cd app && npx jest --silent`. Expected: PASS (как на `origin/test`).
- [ ] **Step 5: Push ветки** — `git push -u origin feat/sender-multi-ip`.

---

## Выкатка (после merge владельцем; каждое действие — с явного согласия)

1. Владелец: новый пароль root на 77.239.125.235; в Semaphore `portal_secrets`: `SENDER_SSH_HOST_2=77.239.125.235`, `SENDER_SSH_PASSWORD_2=<пароль>`.
2. В `/opt/portal-sender/.env`:
   - на 144: `SENDER_EGRESS_IPS=45.84.222.95,45.84.222.124`, `SENDER_HOST_LABEL=144.31.54.166`;
   - на 77: `SENDER_EGRESS_IPS=77.239.125.235,84.21.173.12`, `SENDER_HOST_LABEL=77.239.125.235`.
   Плюс `SENDER_GOOGLE_*` и `SENDER_ALERTS_TELEGRAM_*`, когда владелец их даст.
3. Merge и scheduled deploy делает владелец. Sender-хосты выкатываются раньше миграций. Новые воркеры ждут реестр и начинают работу после миграции, старый `portal-worker-sender` снимается `--remove-orphans`.
4. Проверка (только чтение):
   - на обоих хостах `docker ps`: по воркеру на адрес и autoheal;
   - `select * from sender_egress_overview(now() - interval '1 day')`: четыре адреса, `last_seen_at` свежий, `last_error` пустой;
   - `select * from sender_worker_leases`: один держатель;
   - на экране «Ящики» четыре адреса со статусом «Работает»;
   - проба отправки с ящика Maildoso проходит.
