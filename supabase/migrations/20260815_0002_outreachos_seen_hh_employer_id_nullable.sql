-- OutreachOS: hh_employer_id в seen-журнале действительно становится NULLABLE.
--
-- Миграция 20260811_0001 сняла PRIMARY KEY и завела вместо него UNIQUE-индекс,
-- рассчитывая, что этого достаточно для NULL-строк 2GIS top-up'а. Это неверно:
-- Postgres выставляет NOT NULL на колонки первичного ключа отдельным свойством
-- колонки, и DROP CONSTRAINT ... pkey его НЕ снимает. На проде так и осталось
-- hh_employer_id NOT NULL при уже отсутствующем PK.
--
-- Путь записи GIS-строк стал живым только 13.08 (до этого топ-ап работал в
-- measure_only, где seen не пишется), поэтому расхождение всплыло не сразу:
-- прогоны 14 и 15.08 упали на `null value in column "hh_employer_id" ...
-- violates not-null constraint`, а 13.08 не дошёл до insert'а по другой причине
-- (URI too long — чинено отдельно). Итог: три дня подряд ни одного лида в
-- Instantly, потому что markSeen стоит строго перед заливкой.
--
-- Изменение метаданных: перезаписи таблицы нет, блокировка кратковременная.
ALTER TABLE public.outreachos_seen_employers
  ALTER COLUMN hh_employer_id DROP NOT NULL;

NOTIFY pgrst, 'reload schema';
