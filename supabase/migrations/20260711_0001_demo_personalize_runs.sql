-- Демо-персонализация: посетитель демо вставляет свой сайт → AI заполняет бриф,
-- генерит гипотезы и цепочку писем. Таблица — одновременно:
--   1) кэш по домену (повторный прогон того же сайта отдаёт готовый результат),
--   2) глобальный дневной кап (count за 24ч — потолок расходов на LLM),
--   3) наблюдаемость (кто/что/когда прогонял) + сигнал о тёплом лиде.
create table if not exists public.demo_personalize_runs (
  id uuid primary key default gen_random_uuid(),
  -- нормализованный host (без www) — ключ кэша
  domain text not null,
  resolved_url text,
  ip text,
  -- Partial<ClientBriefFields> из автозаполнения по сайту
  brief jsonb,
  -- markdown «### Гипотеза N: …» (формат parseHypotheses)
  hypotheses_md text,
  -- [{subject, body, wait_days}] ×3
  letters jsonb,
  model text,
  created_at timestamptz not null default now()
);

-- Кэш-lookup: свежайший прогон по домену.
create index if not exists demo_personalize_runs_domain_created_idx
  on public.demo_personalize_runs (domain, created_at desc);
-- Дневной кап: count по created_at.
create index if not exists demo_personalize_runs_created_idx
  on public.demo_personalize_runs (created_at);

-- Runner миграций не наследует default privileges — grant обязателен (см.
-- tests/migrations/grants.test.ts). Доступ только service_role: пишет/читает
-- исключительно серверный роут через supabaseAdmin; anon/authenticated — нет.
grant all on public.demo_personalize_runs to service_role;
