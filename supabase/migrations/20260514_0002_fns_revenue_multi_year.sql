-- ФНС revenue: переход на multi-year хранение.
--
-- Было: PRIMARY KEY (inn) — один ИНН ↔ одна строка. Импорт 2025 года
-- затирал бы 2024-данные. На проде сейчас 1.97M записей за 2024.
--
-- Стало: PRIMARY KEY (inn, report_year) — можно держать N лет на ИНН.
-- Существующие записи сохраняются (просто PK теперь композитный, все
-- они с report_year=2024).
--
-- Идемпотентно: проверяем имя текущего PK перед dropping. Если кто-то
-- уже накатил эту миграцию руками — ALTER TABLE второй раз не упадёт.

DO $$
DECLARE
  pk_name text;
  pk_cols text;
  table_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = 'fns_revenue'
  ) INTO table_exists;

  -- Таблицы нет (свежая dev-БД) — создаём сразу с нужным PK.
  IF NOT table_exists THEN
    CREATE TABLE public.fns_revenue (
      inn         text        NOT NULL,
      org_name    text,
      income      numeric,
      expense     numeric,
      report_year integer     NOT NULL DEFAULT 2024,
      CONSTRAINT fns_revenue_pkey PRIMARY KEY (inn, report_year)
    );
    RAISE NOTICE 'fns_revenue created with composite PK (inn, report_year)';
    RETURN;
  END IF;

  SELECT conname,
         pg_get_constraintdef(oid)
    INTO pk_name, pk_cols
    FROM pg_constraint
   WHERE conrelid = 'public.fns_revenue'::regclass
     AND contype = 'p';

  -- Если PK уже на (inn, report_year) — миграция уже применялась, выходим.
  IF pk_cols LIKE '%(inn, report_year)%' THEN
    RAISE NOTICE 'fns_revenue PK already (inn, report_year), skipping';
    RETURN;
  END IF;

  -- Дропаем старый PK на (inn) и создаём композитный.
  IF pk_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.fns_revenue DROP CONSTRAINT %I', pk_name);
  END IF;
  ALTER TABLE public.fns_revenue
    ADD CONSTRAINT fns_revenue_pkey PRIMARY KEY (inn, report_year);
END $$;

-- Индекс по одному ИНН для быстрого WHERE inn IN (...) когда юзер
-- запрашивает все годы по списку компаний.
CREATE INDEX IF NOT EXISTS idx_fns_revenue_inn ON public.fns_revenue (inn);

-- Индекс по году — для UI-фильтра «какие года вообще есть в БД»
-- (SELECT DISTINCT report_year ... быстрее).
CREATE INDEX IF NOT EXISTS idx_fns_revenue_year ON public.fns_revenue (report_year);

-- ACL для self-hosted: миграции идут от postgres, без явного GRANT service_role
-- не видит таблицу (см. client_support, May 2026).
GRANT ALL ON public.fns_revenue TO service_role;
GRANT ALL ON public.fns_revenue TO postgres;
GRANT SELECT ON public.fns_revenue TO authenticated;
