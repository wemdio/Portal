-- Атомарный инкремент счётчиков кампании обзвона.
--
-- Зачем. `called_contacts` и `successful_contacts` двигались чтением-изменением-
-- записью из памяти: цикл держал `calledCount` в переменной, увеличивал её и
-- писал `called_contacts = calledCount`. Пока исполнитель был ровно один, это
-- работало. С переездом обзвона на единый жизненный цикл задач
-- (app/src/lib/jobs/lifecycle.ts) исполнителей может быть двое одновременно —
-- библиотека намеренно допускает короткое окно пересечения владельцев, — и
-- второй такой писатель молча затирает инкремент первого. Тот же класс потери
-- был и между воркером и ручным «позвонить следующему» из интерфейса
-- (app/src/app/api/ai-caller/campaigns/[id]/call-next).
--
-- `col = col + delta` внутри одного UPDATE терять нечего: обе строки-писателя
-- сериализуются на уровне строки в Postgres.
--
-- Ограждение жетоном. p_run_token — тот же жетон владения, которым библиотека
-- ограждает все записи исполнителя в строку задачи. Передан не null — запись
-- проходит, только если кампания всё ещё наша и всё ещё в работе; кампанию
-- перехватил сосед или её остановил оператор — счётчик не двинется. null —
-- ручной путь из интерфейса, у которого аренды нет вовсе.
--
-- Возвращает число обновлённых строк: 0 значит «кампании нет, или она уже не
-- ваша», и вызывающий может отличить это от успеха.
--
-- security invoker (по умолчанию): функция ходит в таблицу правами вызывающего,
-- поэтому RLS-политики `ai_campaigns` продолжают действовать — из браузера
-- счётчик двинет только владелец кампании, ровно как и раньше через PATCH.

create or replace function public.ai_campaign_bump_counters(
  p_campaign_id uuid,
  p_called integer default 0,
  p_successful integer default 0,
  p_run_token uuid default null
)
returns integer
language plpgsql
as $$
declare
  updated_count integer;
begin
  update public.ai_campaigns
     set called_contacts = called_contacts + coalesce(p_called, 0),
         successful_contacts = successful_contacts + coalesce(p_successful, 0),
         updated_at = now()
   where id = p_campaign_id
     and (
       p_run_token is null
       or (run_token = p_run_token and status = 'running')
     );
  get diagnostics updated_count = row_count;
  return updated_count;
end;
$$;

comment on function public.ai_campaign_bump_counters(uuid, integer, integer, uuid) is
  'Атомарный инкремент счётчиков ai_campaigns; p_run_token ограждает запись жетоном аренды (lib/jobs/lifecycle.ts).';

grant execute on function public.ai_campaign_bump_counters(uuid, integer, integer, uuid)
  to authenticated, service_role;
