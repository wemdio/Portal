-- Общий распределённый rate-limiter для Instantly API (token-bucket в Postgres).
--
-- Контекст. У Instantly API жёсткий лимит на уровне WORKSPACE (~10-15 RPM
-- устойчиво на /emails; 20+ RPM → скользящий штраф). Лимит общий на workspace
-- ПОВЕРХ разных API-ключей: 22.05.2026 ad-hoc выгрузка pull.mjs (на ключе
-- INSTANTLY_EXPORT_API_KEY, 30+ RPM) задушила latency-sensitive квалификатор
-- worker-instantly-leads (на ключе INSTANTLY_API_KEY) — poll-цикл деградировал
-- с 30с до 20+ мин, пропущены квалификации лидов. См. wiki/log.md.
--
-- В один workspace независимо стучатся ~5 процессов (portal ×WEB_CONCURRENCY,
-- worker-outreach, worker-instantly-leads, instantly-sync-bot, pull.mjs), каждый
-- лимитит только себя in-process → их СУММА превышает потолок. In-process
-- лимитер этого не лечит — лимит глобальный. Postgres (а не Redis) выбран
-- потому, что все потребители уже подключены к нему, а нужная пропускная — лишь
-- ~10 запросов в минуту, где преимущество Redis нерелевантно.
--
-- Ключ бакета (account_id) — это ИДЕНТИФИКАТОР WORKSPACE, не строка API-ключа.
-- main-workspace (INSTANTLY_API_KEY / INSTANTLY_PORTAL_API_KEY / EXPORT_API_KEY)
-- → 'main'. Отдельные клиентские аккаунты из INSTANTLY_ACCOUNTS_JSON — это
-- реально другие workspace со своими лимитами → каждому своя строка.
--
-- Использование: каждый потребитель ПЕРЕД вызовом Instantly делает
--   select public.instantly_acquire_token('main');
-- 0 = токен выдан, идём; >0 = столько секунд ждать до следующей попытки.
-- Вызывающий код fail-open: любая ошибка лимитера → запрос всё равно проходит
-- (лимитер только сглаживает бёрсты, не блокирует жёстко). См.
-- app/src/lib/instantly/rateLimiter.ts.

create table if not exists public.instantly_rate_budget (
  account_id  text primary key,            -- идентификатор workspace ('main' по умолчанию)
  tokens      double precision not null,   -- текущие доступные токены
  max_tokens  double precision not null,   -- ёмкость бакета = допустимый burst
  refill_rate double precision not null,   -- скорость пополнения, токенов/сек
  updated_at  timestamptz not null default now()
);

comment on table public.instantly_rate_budget is
  'Token-bucket для распределённого rate-limiting Instantly API. Одна строка на workspace (account_id). Тюнится UPDATE-ом строки.';

-- Атомарно «взять токен» для данного workspace.
-- Возвращает 0 если токен выдан (можно делать запрос немедленно), иначе число
-- секунд, через которое накопится p_cost токенов (вызывающий спит и повторяет).
--
-- Ёмкость и скорость берутся ИЗ СТРОКИ (max_tokens / refill_rate), а параметры
-- p_max / p_rate используются ТОЛЬКО при ленивом создании строки (первый вызов
-- для account_id). Чтобы перетюнить существующий бакет:
--   update public.instantly_rate_budget set max_tokens=…, refill_rate=… where account_id='main';
create or replace function public.instantly_acquire_token(
  p_account text,
  p_cost    double precision default 1,
  p_max     double precision default 12,      -- burst (только при создании строки)
  p_rate    double precision default 0.2      -- токенов/сек ≈ 12/мин (только при создании строки)
)
returns double precision                       -- 0 = выдан; >0 = секунд ждать
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now     timestamptz := clock_timestamp();  -- НЕ now(): now() заморожен на старте транзакции,
                                                -- под FOR UPDATE дал бы под-refill держателю лока.
  v_tokens  double precision;
  v_max     double precision;
  v_rate    double precision;
  v_updated timestamptz;
  v_elapsed double precision;
begin
  -- Race-safe ленивое создание. Гарант сериализации первого вызова — PK +
  -- ON CONFLICT, а НЕ "SELECT ... FOR UPDATE" (нельзя залочить ещё не
  -- существующую строку → две первые конкурентные попытки иначе словили бы
  -- unique_violation). После этого строка точно есть.
  insert into public.instantly_rate_budget (account_id, tokens, max_tokens, refill_rate, updated_at)
  values (p_account, p_max, p_max, p_rate, v_now)
  on conflict (account_id) do nothing;

  -- Сериализуем конкурентных потребителей этого workspace по строке.
  select tokens, max_tokens, refill_rate, updated_at
    into v_tokens, v_max, v_rate, v_updated
    from public.instantly_rate_budget
   where account_id = p_account
   for update;

  -- Ленивое пополнение по часам БД (а не по часам процесса — это попутно
  -- устраняет зависимость от рассинхрона часов между серверами).
  v_elapsed := greatest(0, extract(epoch from (v_now - v_updated)));
  v_tokens  := least(v_max, v_tokens + v_elapsed * v_rate);

  if v_tokens >= p_cost then
    update public.instantly_rate_budget
       set tokens = v_tokens - p_cost,
           updated_at = v_now
     where account_id = p_account;
    return 0;
  end if;

  -- Не хватило: ВСЁ РАВНО фиксируем пополнение (двигаем updated_at), иначе при
  -- частых отказах refill-математика дрейфует.
  update public.instantly_rate_budget
     set tokens = v_tokens,
         updated_at = v_now
   where account_id = p_account;

  return (p_cost - v_tokens) / nullif(v_rate, 0);
end;
$$;

grant execute on function public.instantly_acquire_token(text, double precision, double precision, double precision)
  to service_role;
