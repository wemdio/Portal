-- RPC возвращает полный список уникальных значений activity_type
-- из public.companies_directory.
--
-- Зачем нужно: раньше API /api/client/companies-search/activity-types
-- делал select activity_type ... .limit(50000) и дедуплицировал на JS.
-- Это ломалось двумя способами:
--   1) PostgREST по умолчанию режет ответ db-max-rows (часто = 1000),
--      поэтому до клиента долетал лишь крошечный сэмпл.
--   2) Без ORDER BY каждый запрос возвращал разный набор строк,
--      и пользователь видел разный набор видов деятельности при
--      каждом открытии модалки.
--
-- DISTINCT по индексированной колонке (idx_companies_directory_activity)
-- использует Index Only Scan / Skip Scan и работает быстро даже на
-- 2млн+ строк — фактический набор уникальных значений измеряется десятками.
--
-- SECURITY DEFINER не нужен: функция читает ту же таблицу с теми же
-- правами, что и обычный SELECT — RLS уже разрешает чтение
-- authenticated и service_role.

create or replace function public.companies_directory_activity_types()
returns table (activity_type text)
language sql
stable
as $$
  select distinct activity_type
  from public.companies_directory
  where activity_type is not null
    and btrim(activity_type) <> ''
  order by activity_type;
$$;

grant execute on function public.companies_directory_activity_types() to service_role;
grant execute on function public.companies_directory_activity_types() to authenticated;
