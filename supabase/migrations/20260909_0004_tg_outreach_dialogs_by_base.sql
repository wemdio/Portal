-- Фильтр «диалоги выбранной базы» считает база, а не URL запроса.
--
-- Прямой связи «диалог → база» в модели нет: диалог заводится по входящему из
-- Telegram и знает только собеседника, а сверяется с контактом базы по тем же
-- двум ключам, что и подпись базы в списке диалогов (buildDialogBaseIndex):
-- нормализованный юзернейм (usernameKey — trim, без собачки, нижний регистр)
-- или tg_user_id.
--
-- Раньше API списка диалогов собирал этот фильтр сам: выгружал все контакты
-- базы (до 20 000) и вклеивал их в PostgREST-условие
-- `or(tg_username.in.(…),tg_user_id.in.(…))`. Условие едет в URL запроса к
-- PostgREST, и уже на 441 юзернейме (база atol-1, ~7,5 КБ строки фильтра)
-- URL перешагнул лимит шлюза — вкладка «Диалоги» падала с «URI too long».
--
-- Функция возвращает SETOF самой таблицы: PostgREST разворачивает такой вызов
-- как источник строк, и остальные фильтры, сортировка и пагинация списка
-- цепляются к нему как к обычной выборке. exists, а не join: контакт базы
-- может совпасть с диалогом дважды (одинаковый tg_user_id у двух контактов),
-- join дал бы дубликаты строк.
--
-- Права вызываемого (security invoker — по умолчанию): чтение идёт от роли
-- запроса, RLS обеих таблиц применяется ровно как к прямым запросам, которые
-- функция заменяет. Пустая база честно даёт ноль строк.

create or replace function public.tg_outreach_dialogs_by_base(
  p_campaign_id uuid,
  p_base_id uuid
)
returns setof public.tg_outreach_dialogs
language sql
stable
set search_path = ''
as $$
  select d.*
  from public.tg_outreach_dialogs d
  where d.campaign_id = p_campaign_id
    and exists (
      select 1
      from public.tg_outreach_base_contacts c
      where c.base_id = p_base_id
        and (
          (c.tg_user_id is not null and c.tg_user_id = d.tg_user_id)
          or lower(regexp_replace(btrim(c.username), '^@', ''))
            = lower(regexp_replace(btrim(d.tg_username), '^@', ''))
        )
    )
$$;

grant execute on function public.tg_outreach_dialogs_by_base(uuid, uuid) to authenticated, service_role;

comment on function public.tg_outreach_dialogs_by_base(uuid, uuid) is
  'Диалоги кампании, чей собеседник есть среди контактов базы (совпадение по нормализованному юзернейму или tg_user_id). Кормит фильтр по базе на вкладке «Диалоги» вместо in-списка в URL, который не влезал в лимит шлюза.';
