-- Автоподъём баз, легших на ВРЕМЕННОМ сбое провайдера.
--
-- Сегодня база, у которой моргнул Serper или прилетел 429, ложится в failed и
-- лежит до ручного «Продолжить подготовку». 2026-09-21 так простаивали три
-- базы из пятнадцати: не «кончились деньги», а «поиск моргнул». Оплаченная
-- работа при этом стоит, а бюджет уходит на соседние базы.
--
-- Поднимаем ТОЛЬКО временные сбои. Пустой баланс, неверный ключ и отмену
-- пользователем трогать нельзя: первые два повторять бессмысленно и вредно,
-- третье — прямое решение специалиста.
alter table public.ve_outreach_preparations
  add column if not exists auto_resumes integer not null default 0;
alter table public.ve_outreach_preparations
  add column if not exists auto_resumed_at timestamptz;

comment on column public.ve_outreach_preparations.auto_resumes is
  'Сколько раз подготовку поднимал автоподъём после временного сбоя провайдера. Ручное «Продолжить подготовку» счётчик не трогает.';

/**
 * Временный сбой: повтор имеет смысл. Явно исключаем оплату и конфигурацию —
 * их повтор только сожжёт время и замаскирует настоящую причину.
 */
create or replace function public.ve_transient_collect_error(p_error text)
returns boolean language sql immutable set search_path = '' as $$
  select p_error is not null
    and p_error !~* '\m(402|insufficient|not enough credits|payment required|billing)\M'
    and p_error !~* '\m(401|403|api[_ -]?key|unauthorized|forbidden)\M'
    and p_error !~* 'Отменено пользователем'
    and (
      p_error ~* 'Serper transient'
      or p_error ~* '\mRequesty\s+(408|425|429|500|502|503|504)\M'
      or p_error ~* '(timeout|timed out|timing out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|fetch failed|network error)'
      or p_error ~* 'временно (недоступн|ограничил)'
      or p_error ~* 'завершил(ась|ся) не полностью'
      -- «не завершено: provider» — тот же временный сбой провайдера, просто
      -- другой стадии (исправление доказательств).
      or p_error ~* 'не завершен\w*: *provider'
    );
$$;

/**
 * Один проход автоподъёма. Возвращает, сколько подготовок вернул в работу.
 *
 * Условия сознательно жёсткие: поднимаем только базу, которая уже лежит
 * (failed), чья подготовка не отменена пользователем, гипотеза всё ещё
 * выбрана, база не одобрена и не запущена, по ней нет активной джобы, и
 * автоподъёмов ещё меньше лимита. База под остывающим повтором пропускается:
 * иначе сбой провайдера превратился бы в цикл платных попыток.
 */
create or replace function public.ve_auto_resume_transient_preparations(
  p_limit integer default 10,
  p_max_attempts integer default 5,
  p_cooldown_minutes integer default 20,
  p_now timestamptz default now()
) returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_limit constant integer := greatest(1, least(coalesce(p_limit, 10), 50));
  v_max constant integer := greatest(1, least(coalesce(p_max_attempts, 5), 20));
  v_cooldown constant interval := make_interval(mins => greatest(1, least(coalesce(p_cooldown_minutes, 20), 24 * 60)));
  item record;
  v_resumed integer := 0;
begin
  for item in
    select p.project_id, p.hypothesis_id, p.base_id, s.revision
      from public.ve_outreach_preparations p
      join public.ve_bases b on b.id = p.base_id
      join public.ve_outreach_setups s on s.project_id = p.project_id
     where p.status = 'error'
       and p.cancelled_at is null
       and p.auto_resumes < v_max
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
       set auto_resumes = auto_resumes + 1, auto_resumed_at = p_now
     where project_id = item.project_id and hypothesis_id = item.hypothesis_id;
    perform public.ve_request_outreach_hypothesis_preparation(item.project_id, item.revision, item.hypothesis_id);
    v_resumed := v_resumed + 1;
  end loop;
  return v_resumed;
end $$;

revoke all on function public.ve_transient_collect_error(text),
  public.ve_auto_resume_transient_preparations(integer,integer,integer,timestamptz) from public, anon, authenticated;
grant execute on function public.ve_transient_collect_error(text),
  public.ve_auto_resume_transient_preparations(integer,integer,integer,timestamptz) to service_role;
