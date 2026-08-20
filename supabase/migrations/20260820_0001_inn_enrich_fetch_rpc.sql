-- inn_enrich_fetch: read-only RPC для внутреннего тула /tools/inn-enrich
-- (обогащение файла по списку ИНН из companies_directory).
--
-- Нарочно НЕ расширяем companies_directory_fetch_rpc: та функция — общий
-- бэкенд «Нашей базы баз» и клиентского companies-search (и транзитивно
-- ENG-путей), а обогащению нужны поля, которые shared RPC осознанно не
-- отдаёт (ФИО директора, ОКПО, ПФР, GLN, registry_status…). Отдельная
-- функция изолирует риск: правки здесь не ломают те поверхности.
--
-- companies_directory хранит несколько строк на один ИНН (разные
-- source_file). DISTINCT ON выбирает самую полную запись: контакты весят
-- больше финансов (смысл тула — добыть точку контакта), при равенстве —
-- минимальный id (детерминизм, как order by c.id в fetch RPC).
--
-- NB: колонки registry_status / registration_date / okved_code_exact /
-- director_* / okpo / pf_reg_number / branch_code / gln существуют в
-- prod-БД (приехали ветками 2026-07), но на момент этой миграции ещё не
-- представлены в supabase/migrations ветки test. Миграция рассчитана на
-- prod-схему; на чистой БД, поднятой только из миграций test, упадёт —
-- это известный drift, а не регрессия этой миграции.

create or replace function public.inn_enrich_fetch(p_inn_list text[])
returns jsonb
language plpgsql stable
as $$
begin
  return coalesce((
    select jsonb_agg(row_to_json(sub))
    from (
      select distinct on (c.inn)
        c.name,
        c.inn,
        c.kpp,
        c.ogrn,
        c.registry_status,
        c.registration_date,
        c.director_last_name,
        c.director_first_name,
        c.director_middle_name,
        c.address,
        c.phones,
        c.email,
        c.website,
        coalesce(c.okved_code_exact, c.okved_code) as okved_code,
        ok.name as okved_name,
        c.activity_type,
        c.employees_count,
        c.revenue,
        c.cost,
        c.edo_id,
        c.egais,
        c.okpo,
        c.pf_reg_number,
        c.branch_code,
        c.gln
      from public.companies_directory c
      left join public.okved_reference ok
        on ok.code = coalesce(c.okved_code_exact, c.okved_code)
      where c.inn = any(p_inn_list)
      order by
        c.inn,
        (
          (case when c.phones  is not null and c.phones  <> '' then 3 else 0 end) +
          (case when c.email   is not null and c.email   <> '' then 3 else 0 end) +
          (case when c.website is not null and c.website <> '' then 2 else 0 end) +
          (case when c.revenue is not null then 1 else 0 end) +
          (case when c.address is not null and c.address <> '' then 1 else 0 end) +
          (case when coalesce(c.okved_code_exact, c.okved_code) is not null then 1 else 0 end)
        ) desc,
        c.id asc
    ) sub
  ), '[]'::jsonb);
end;
$$;

-- Тул ходит только через supabaseAdmin (service_role). Анонимный и
-- клиентский доступ к полной выгрузке справочника закрыт.
revoke execute on function public.inn_enrich_fetch(text[]) from public, anon, authenticated;
grant execute on function public.inn_enrich_fetch(text[]) to service_role;
