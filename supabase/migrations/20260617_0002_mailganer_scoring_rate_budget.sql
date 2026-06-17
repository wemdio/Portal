-- Жёсткий распределённый лимит запросов к Mailganer scoring-эндпоинту
-- (token-bucket в Postgres), общий для ВСЕХ воркеров.
--
-- Контекст. Клиент Mailganer (домен-SPF-скоринг на mailganer.com) попросил
-- держать НЕ БОЛЕЕ 20 000 запросов в сутки и РАВНОМЕРНО — их эндпоинт делает
-- DNS-парсинг и не рассчитан на высокий поток. Заливка большого файла ru.txt
-- (6.1M доменов) давала ~400k+/сутки. Лимит должен быть общим ПОВЕРХ всех
-- процессов, стучащихся в эндпоинт: bob-scorer (фоновый BoB-филлер + большой
-- файл), добор, ручной скоринг. In-process concurrency этого не решает —
-- лимит глобальный, нужен общий бюджет в БД (зеркало instantly_rate_budget,
-- миграция 20260607_0002).
--
-- 20000/сутки = 20000/86400 ≈ 0.2315 токена/сек; burst 20 → допускаем
-- небольшой всплеск, дальше ровно ~14/мин. Использование: ПЕРЕД запросом к
-- Mailganer вызвать select public.mailganer_acquire_score_token();
-- 0 = токен выдан (можно слать немедленно), >0 = столько секунд ждать.
-- См. app/src/lib/jobs/mailganerScoringRateLimit.ts (fail-open на ошибках
-- лимитера, skip-домена на исчерпании бюджета — жёсткий потолок).

create table if not exists public.mailganer_scoring_rate_budget (
  bucket      text primary key,            -- ключ бакета (один эндпоинт → 'mailganer')
  tokens      double precision not null,   -- текущие доступные токены
  max_tokens  double precision not null,   -- ёмкость бакета = допустимый burst
  refill_rate double precision not null,   -- скорость пополнения, токенов/сек
  updated_at  timestamptz not null default now()
);

comment on table public.mailganer_scoring_rate_budget is
  'Token-bucket для жёсткого лимита запросов к Mailganer scoring-эндпоинту (≤20k/сутки, равномерно). Одна строка (bucket=mailganer). Тюнится UPDATE-ом строки.';

-- Таблицу трогает только SECURITY DEFINER функция (от service_role). Прямого
-- доступа anon/authenticated не нужно.
grant all on public.mailganer_scoring_rate_budget to service_role;

-- Атомарно «взять токен». Возвращает 0 если токен выдан (можно слать запрос
-- немедленно), иначе число секунд, через которое накопится p_cost токенов
-- (вызывающий спит и повторяет). Ёмкость/скорость берутся ИЗ СТРОКИ; параметры
-- p_max/p_rate применяются ТОЛЬКО при ленивом создании строки (первый вызов).
-- Перетюнить существующий бакет:
--   update public.mailganer_scoring_rate_budget set max_tokens=…, refill_rate=… where bucket='mailganer';
create or replace function public.mailganer_acquire_score_token(
  p_bucket text default 'mailganer',
  p_cost   double precision default 1,
  p_max    double precision default 20,        -- burst (только при создании строки)
  p_rate   double precision default 0.231481   -- 20000/86400 токенов/сек (только при создании строки)
)
returns double precision                        -- 0 = выдан; >0 = секунд ждать
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
  -- Race-safe ленивое создание (PK + ON CONFLICT, а НЕ FOR UPDATE на ещё не
  -- существующей строке).
  insert into public.mailganer_scoring_rate_budget (bucket, tokens, max_tokens, refill_rate, updated_at)
  values (p_bucket, p_max, p_max, p_rate, v_now)
  on conflict (bucket) do nothing;

  -- Сериализуем конкурентных потребителей по строке.
  select tokens, max_tokens, refill_rate, updated_at
    into v_tokens, v_max, v_rate, v_updated
    from public.mailganer_scoring_rate_budget
   where bucket = p_bucket
   for update;

  -- Ленивое пополнение по часам БД.
  v_elapsed := greatest(0, extract(epoch from (v_now - v_updated)));
  v_tokens  := least(v_max, v_tokens + v_elapsed * v_rate);

  if v_tokens >= p_cost then
    update public.mailganer_scoring_rate_budget
       set tokens = v_tokens - p_cost, updated_at = v_now
     where bucket = p_bucket;
    return 0;
  end if;

  -- Не хватило: всё равно фиксируем пополнение (двигаем updated_at).
  update public.mailganer_scoring_rate_budget
     set tokens = v_tokens, updated_at = v_now
   where bucket = p_bucket;

  return (p_cost - v_tokens) / nullif(v_rate, 0);
end;
$$;

grant execute on function public.mailganer_acquire_score_token(text, double precision, double precision, double precision)
  to service_role;
