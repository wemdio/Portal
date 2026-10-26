-- Откуда лид на доске проекта: Instantly или «Рассылка» (запуски Движка
-- вертикалей через свой рассыльщик, 24.10.2026).
--
-- «Исходы» ящиков (instantly_project_leads_daily) берут отправки и ответы
-- только из Instantly. Лиды «Рассылки» без её писем и ответов завысили бы
-- конверсию, поэтому до этапа 8 (итоги по письмам «Рассылки») они туда не
-- входят — решение владельца 26.10.2026. На доске и у клиента они видны как
-- обычно.
--
-- Представление project_client_lead_board_rows (r.*) не пересоздаём: его
-- список колонок зафиксирован, новая колонка в нём не нужна.

-- Мигратор базы Instantly не ставит lock_timeout: ALTER не должен ждать
-- забытую транзакцию бесконечно, держа в очереди доску и «Исходы».
set local lock_timeout = '5s';

alter table public.project_lead_board_rows
  add column if not exists source text not null default 'instantly';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'project_lead_board_rows_source_check'
      and conrelid = 'public.project_lead_board_rows'::regclass
  ) then
    alter table public.project_lead_board_rows
      add constraint project_lead_board_rows_source_check check (source in ('instantly', 'sender'));
  end if;
end $$;

create or replace function public.instantly_project_leads_daily(p_from date, p_to date)
returns table(day text, leads bigint)
language sql stable security invoker
set search_path = public
as $$
  select to_char(coalesce(r.reply_timestamp, r.created_at) at time zone 'UTC', 'YYYY-MM-DD') as day,
         count(*) as leads
  from public.project_client_lead_board_rows r
  where r.qualification_id is not null
    and coalesce(r.reply_timestamp, r.created_at) >= p_from::timestamp at time zone 'UTC'
    and coalesce(r.reply_timestamp, r.created_at) < (p_to + 1)::timestamp at time zone 'UTC'
    and not exists (
      select 1 from public.project_lead_board_rows b
      where b.id = r.id and b.source = 'sender'
    )
  group by 1
  order by 1;
$$;

revoke all on function public.instantly_project_leads_daily(date, date) from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant execute on function public.instantly_project_leads_daily(date, date) to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'instantly') then
    execute 'grant execute on function public.instantly_project_leads_daily(date, date) to instantly';
  end if;
end $$;
