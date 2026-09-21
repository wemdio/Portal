-- Лимит автоподъёмов сделан оконным, а не пожизненным.
--
-- Было: пять подъёмов за всё время жизни базы, и шестой не случится никогда.
-- База, которая исправно собирает контакты, но раз в несколько часов ловит
-- очередной сбой Serper, исчерпывала лимит и вставала насовсем. 2026-09-21
-- одна из пятнадцати баз дошла до четырёх при лимите пять, имея 291 контакт
-- из 500 — то есть в шаге от того, чтобы замереть на ровном месте.
--
-- Стало: пять подъёмов в окне. Успешный промежуток длиннее окна обнуляет
-- счётчик, поэтому здоровая база живёт сколько нужно, а тесный цикл отказов
-- по-прежнему останавливается после пятой попытки подряд.
create or replace function public.ve_auto_resume_transient_preparations(
  p_limit integer default 10,
  p_max_attempts integer default 5,
  p_cooldown_minutes integer default 20,
  p_now timestamptz default now(),
  p_window_hours integer default 6
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_limit constant integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_max constant integer := greatest(1, least(coalesce(p_max_attempts, 5), 20));
  v_cooldown constant interval := make_interval(mins => greatest(1, least(coalesce(p_cooldown_minutes, 20), 24 * 60)));
  v_window constant interval := make_interval(hours => greatest(1, least(coalesce(p_window_hours, 6), 72)));
  item record;
  v_resumed integer := 0;
begin
  for item in
    select p.project_id, p.hypothesis_id, p.base_id, s.revision,
           -- Окно прошло: считаем эту попытку первой, а не шестой.
           (p.auto_resumed_at is null or p.auto_resumed_at < p_now - v_window) as window_expired
      from public.ve_outreach_preparations p
      join public.ve_bases b on b.id = p.base_id
      join public.ve_outreach_setups s on s.project_id = p.project_id
     where p.status = 'error'
       and p.cancelled_at is null
       and (p.auto_resumes < v_max or p.auto_resumed_at is null or p.auto_resumed_at < p_now - v_window)
       and (p.auto_resumed_at is null or p.auto_resumed_at < p_now - v_cooldown)
       and b.status = 'failed'
       and b.source = 'auto'
       and b.hypothesis_id is not null
       and public.ve_transient_collect_error(b.error)
       and p.hypothesis_id = any(s.selected_hypothesis_ids)
       and not (s.approved_bases ? b.id::text)
       and not public.ve_base_audience_frozen(b.id)
       and not exists (select 1 from public.ve_templates t where t.base_id = b.id and t.launch_info is not null)
       and not exists (select 1 from public.ve_jobs j
             where j.project_id = p.project_id and j.payload->>'base_id' = b.id::text
               and j.status in ('pending','running'))
     order by p.updated_at
     limit v_limit
  loop
    -- Счётчик двигаем ДО попытки: если RPC упадёт, повтор не станет вечным.
    update public.ve_outreach_preparations
       set auto_resumes = case when item.window_expired then 1 else auto_resumes + 1 end,
           auto_resumed_at = p_now
     where project_id = item.project_id and hypothesis_id = item.hypothesis_id;
    perform public.ve_request_outreach_hypothesis_preparation(item.project_id, item.revision, item.hypothesis_id);
    v_resumed := v_resumed + 1;
  end loop;
  return v_resumed;
end $$;

revoke all on function public.ve_auto_resume_transient_preparations(integer,integer,integer,timestamptz,integer) from public, anon, authenticated;
grant execute on function public.ve_auto_resume_transient_preparations(integer,integer,integer,timestamptz,integer) to service_role;
-- Старая четырёхаргументная версия больше не нужна: воркер зовёт RPC по имени
-- с одним p_limit, и две перегрузки сделали бы вызов неоднозначным.
drop function if exists public.ve_auto_resume_transient_preparations(integer,integer,integer,timestamptz);
