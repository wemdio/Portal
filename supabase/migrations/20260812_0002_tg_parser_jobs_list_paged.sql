-- Парсер TG: постраничный список задач.
--
-- Функция умела только `row_limit`, поэтому интерфейс тянул полсотни задач
-- разом и рисовал их одним полотном: за несколько дней это десятки карточек, а
-- добраться до задачи старше полусотни было нельзя вовсе.
--
-- Добавляем смещение и общее число задач. Число считаем окном `count(*) over ()`
-- в том же запросе: отдельный `select count(*)` — второй проход по таблице ради
-- одной цифры, а окно вычисляется до limit/offset и даёт честный итог.
--
-- Сначала drop: набор возвращаемых колонок меняется, `create or replace` такого
-- не допускает (ERROR 42P13). Старую сигнатуру с одним аргументом тоже
-- убираем — иначе вызов с одним `row_limit` стал бы неоднозначным между
-- перегрузками.
drop function if exists public.tg_parser_jobs_list(int);
drop function if exists public.tg_parser_jobs_list(int, int);

create or replace function public.tg_parser_jobs_list(
  row_limit int default 50,
  row_offset int default 0
)
returns table (
  id uuid,
  user_id uuid,
  created_at timestamptz,
  status text,
  config jsonb,
  account_id uuid,
  stop_reason text,
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  user_count int,
  found_count int,
  progress_note text,
  progress_at timestamptz,
  total_count bigint
)
language sql stable security invoker
as $$
  select
    j.id,
    j.user_id,
    j.created_at,
    j.status,
    j.config,
    j.account_id,
    j.stop_reason,
    j.error_message,
    j.started_at,
    j.completed_at,
    coalesce(jsonb_array_length(j.result_users), 0)::int as user_count,
    j.found_count,
    j.progress_note,
    j.progress_at,
    count(*) over () as total_count
  from public.tg_parser_jobs j
  order by j.created_at desc
  limit greatest(row_limit, 1)
  offset greatest(row_offset, 0);
$$;

-- Пересоздание сбрасывает выданные права — возвращаем их явно, чтобы не
-- зависеть от того, какой ролью прогоняются миграции (см. 20260810_0002).
grant execute on function public.tg_parser_jobs_list(int, int)
  to postgres, anon, authenticated, service_role;
