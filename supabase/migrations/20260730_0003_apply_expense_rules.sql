-- Применение правил разметки к неразмеченным тратам.
--
-- p_rule_id = NULL → прогнать все правила (ночной синк).
-- p_rule_id = <id> → прогнать одно только что созданное правило (вызов из API
-- после ручной разметки с галкой «применить ко всем похожим»).
--
-- Возвращает число затронутых строк.

create or replace function public.apply_expense_rules(p_rule_id uuid default null)
returns integer
language plpgsql
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  with matched as (
    select distinct on (e.source, e.source_ref)
           e.source,
           e.source_ref,
           r.vendor_id,
           r.id as rule_id
    from public.expenses_v e
    join public.expense_rules r
      on (p_rule_id is null or r.id = p_rule_id)
     and (r.source is null or r.source = e.source)
    cross join lateral (
      select case r.match_field
               when 'payee_inn' then e.counterparty_inn
               when 'purpose'   then e.details
               -- payee_name и merchant — одно и то же поле витрины:
               -- у банка это получатель платежа, у Brocard это мерчант.
               else e.counterparty
             end as field_value
    ) f
    where f.field_value is not null
      and (
        (r.match_type = 'exact'
          and lower(btrim(f.field_value)) = lower(btrim(r.pattern)))
        or
        -- position(), а не LIKE: образец приходит от человека и может
        -- содержать % или _, которые LIKE трактует как шаблон.
        (r.match_type = 'contains'
          and position(lower(btrim(r.pattern)) in lower(f.field_value)) > 0)
      )
    order by e.source, e.source_ref, r.priority, r.created_at
  )
  insert into public.expense_classifications (source, source_ref, vendor_id, method, rule_id)
  select m.source, m.source_ref, m.vendor_id, 'rule', m.rule_id
  from matched m
  on conflict (source, source_ref) do update
     set vendor_id     = excluded.vendor_id,
         rule_id       = excluded.rule_id,
         classified_at = now()
   -- Ключевая строка всей задачи: правило не трогает то, что размечено
   -- человеком. Защита структурная, а не договорённость между разработчиками.
   where public.expense_classifications.method = 'rule';

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.apply_expense_rules(uuid) from public;
grant execute on function public.apply_expense_rules(uuid) to service_role, postgres;

comment on function public.apply_expense_rules(uuid) is
  'Размечает траты по expense_rules. Строки с method=manual не перезаписываются никогда.';
