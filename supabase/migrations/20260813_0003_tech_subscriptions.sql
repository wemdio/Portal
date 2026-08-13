-- Календарь технички: план платежей за прокси, серверы, API и софт.
--
-- Экран «Расходы» показывает уже ушедшие деньги; ответа на вопрос «что и когда
-- спишется на следующей неделе» в портале не было — он жил в личных заметках.
-- Календарь почт решает ровно эту задачу для email-подписок, здесь то же самое
-- для студийной технички.
--
-- Таблица заперта намеренно: политик для `authenticated` нет, читать и писать
-- можно только через серверные ручки /api/tech-calendar/*, каждая начинается с
-- requireAdmin. Суммы по инфраструктуре — не то, что должен видеть клиент или
-- подрядчик, залезая в базу в обход интерфейса.

create table if not exists public.tech_subscriptions (
  id uuid primary key default gen_random_uuid(),

  service_name text not null,
  service_type text not null default 'other'
    check (service_type in ('proxy', 'server', 'api', 'software', 'other')),

  amount numeric(12, 2) not null default 0,
  -- Валюты ровно две. Свободная строка молча роняла бы строку из итога:
  -- суммы считаются по каждой валюте отдельно, и опечатка «USDT» дала бы
  -- сервис, которого нет ни в одном из двух итогов.
  currency text not null default 'RUB'
    check (currency in ('RUB', 'USD')),
  billing_cycle text not null default 'monthly'
    check (billing_cycle in ('monthly', 'quarterly', 'yearly')),
  next_billing_date date not null,

  -- Статуса `expired` нет намеренно: в email_subscriptions он остался от
  -- прежней логики и не выставляется ничем.
  status text not null default 'active'
    check (status in ('active', 'pending_review', 'keep', 'cancel')),

  decision_by uuid references public.profiles(id) on delete set null,
  decision_at timestamptz,
  decision_notes text,

  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_tech_subscriptions_billing_date
  on public.tech_subscriptions(next_billing_date);
create index if not exists idx_tech_subscriptions_status
  on public.tech_subscriptions(status);
create index if not exists idx_tech_subscriptions_type
  on public.tech_subscriptions(service_type);

alter table public.tech_subscriptions enable row level security;

grant all on public.tech_subscriptions to service_role;

create or replace function public.tech_subscriptions_touch_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists tech_subscriptions_updated_at on public.tech_subscriptions;
create trigger tech_subscriptions_updated_at
  before update on public.tech_subscriptions
  for each row execute function public.tech_subscriptions_touch_updated_at();

-- Лог напоминаний. Ключ включает дату списания: после продления дата уезжает,
-- и следующий цикл напоминает заново сам, а прогон раз в 10 минут при этом не
-- превращается в спам.
create table if not exists public.tech_renewal_notification_log (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.tech_subscriptions(id) on delete cascade,
  billing_date date not null,
  level text not null check (level in ('soon', 'due')),
  created_at timestamptz not null default now(),
  unique (subscription_id, billing_date, level)
);

alter table public.tech_renewal_notification_log enable row level security;

grant all on public.tech_renewal_notification_log to service_role;

-- Новый тип уведомления и новый вид сущности, на которую оно ссылается.
alter table public.notifications
  drop constraint if exists notifications_type_check;
alter table public.notifications
  add constraint notifications_type_check
  check (type in ('deadline', 'deadline_lead', 'deadline_ceo',
                  'lead_new', 'lead_escalation', 'lead_ceo',
                  'info', 'tech_renewal'));

alter table public.notifications
  drop constraint if exists notifications_entity_type_check;
alter table public.notifications
  add constraint notifications_entity_type_check
  check (entity_type is null or entity_type in ('project', 'task', 'lead_qualification', 'tech_subscription'));
