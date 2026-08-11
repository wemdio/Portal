-- Парсер TG: прогресс во время работы.
--
-- До 10.08.2026 задача писала в журнал три строки на старте и одну в конце, а
-- между ними молчала — при том что обход трёх чатов идёт от минуты до сорока.
-- Всё это время оператор не мог отличить работу от зависания, хотя зависания у
-- нас регулярные. Счётчик найденных заполнялся только в самом конце.

alter table public.tg_parser_jobs
  add column if not exists found_count int not null default 0,
  add column if not exists progress_note text,
  add column if not exists progress_at timestamptz;

comment on column public.tg_parser_jobs.found_count is
  'Сколько контактов собрано на данный момент. Обновляется по ходу работы, а не только в конце.';

comment on column public.tg_parser_jobs.progress_note is
  'Чем задача занята прямо сейчас: какой чат и какой этап обхода.';

-- Список задач отдаётся этой функцией, а не прямым select: она не тянет тяжёлый
-- result_users. Добавляем в неё поля прогресса, иначе интерфейс их не увидит.
--
-- Сначала drop: набор возвращаемых колонок меняется, а create or replace такого
-- не допускает (ERROR 42P13, «Row type defined by OUT parameters is different»).
drop function if exists public.tg_parser_jobs_list(int);

create or replace function public.tg_parser_jobs_list(row_limit int default 50)
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
  progress_at timestamptz
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
    j.progress_at
  from public.tg_parser_jobs j
  order by j.created_at desc
  limit row_limit;
$$;

-- Пересоздание сбрасывает выданные права. На боевой базе у функции были права
-- на выполнение у postgres, anon, authenticated и service_role — возвращаем их
-- явно, чтобы не зависеть от того, какой ролью прогоняются миграции.
grant execute on function public.tg_parser_jobs_list(int)
  to postgres, anon, authenticated, service_role;
