-- Публичный срез collect_info для карточки проекта «Движок вертикалей».
--
-- Зачем функция, а не проекция в select. PostgreSQL детоастит toasted jsonb
-- заново на КАЖДОЕ обращение к колонке, кэша детоаста на кортеж нет. Точечная
-- проекция из 60 JSON-путей превращала чтение баз проекта «Аврора» (17 баз,
-- 586 МБ collect_info) в 76 секунд против 1,4 секунды при одном обращении —
-- то есть лечила отказ по пределу строки V8, но ценой сожжённого ядра на
-- каждом опросе карточки (а она опрашивается раз в 4 секунды).
--
-- Здесь collect_info читается РОВНО ОДИН РАЗ, в переменную, и дальше документ
-- собирается уже из неё. Наружу отдаётся тот же набор ключей, что карточка
-- получала раньше после stripTaskHarvest: рабочее состояние воркера
-- (relevance_reserve, relevance_checkpoint, target_checkpoint, harvest задач,
-- search_policy.deferred_rows, карта checked) не покидает сервер.
create or replace function public.ve_base_public_info(b public.ve_bases)
returns jsonb language plpgsql stable parallel safe set search_path = '' as $$
declare
  -- ПОРЯДОК ЗДЕСЬ — ЭТО ПРОИЗВОДИТЕЛЬНОСТЬ, А НЕ СТИЛЬ. Сначала ОДНОЙ операцией
  -- снимаем тяжёлые ветки: дальше все обращения идут по документу в сотни раз
  -- меньше. Замер на проекте «Аврора» (17 баз, 586 МБ): такой порядок — 1,7 с,
  -- белый список сразу по полному документу — 12,7 с, а двадцать два отдельных
  -- обращения по ключам — 31 с, потому что переменная детоастится на каждое.
  v jsonb := b.collect_info - array['relevance_reserve', 'target_checkpoint',
    'relevance_checkpoint', 'source_contact_recovery', 'preview_pipeline',
    'company_name_checkpoint', 'company_name_queue'];
  info jsonb;
  adaptive jsonb;
  completed jsonb;
  batches integer;
begin
  if b.collect_info is null then return null; end if;

  -- Белый список публичных ключей. Чего здесь нет — до клиента не доедет,
  -- поэтому новый публичный ключ добавляется и сюда тоже.
  info := coalesce((
    select jsonb_object_agg(e.key, e.value)
      from jsonb_each(v) e
     where e.value <> 'null'::jsonb
       and e.key in ('collection_mode', 'ready_target', 'supply_hold', 'waiting_for_base_id',
                     'limit', 'target_progress', 'construct', 'plan', 'estimate', 'stats',
                     'relevance_summary', 'company_contact_cap', 'company_name_cleanup',
                     'company_name_recovery', 'source_contact_discovery',
                     'relevance_review_requested', 'validation_retry', 'hypothesis_id',
                     'hypothesis_ids', 'hypotheses', 'plan_repair', 'slice_probe')), '{}'::jsonb);

  -- search_policy: наружу только фаза. deferred_rows — рабочие строки воркера.
  if v->'search_policy' ? 'version' then
    info := info || jsonb_build_object('search_policy', jsonb_strip_nulls(jsonb_build_object(
      'version', v->'search_policy'->'version',
      'phase', v->'search_policy'->'phase')));
  end if;

  -- adaptive_collection: сводка. pending.ready_before — хэши уже готовых
  -- контактов, их нельзя отдавать наружу, поэтому берём только признак.
  adaptive := v->'adaptive_collection';
  if adaptive ? 'version' then
    completed := case when jsonb_typeof(adaptive->'completed') = 'array'
                      then adaptive->'completed' else '[]'::jsonb end;
    batches := jsonb_array_length(completed);
    info := info || jsonb_build_object('adaptive_collection', jsonb_strip_nulls(jsonb_build_object(
      'version', adaptive->'version',
      'switches', adaptive->'switches',
      'note', adaptive->'note',
      'replan_error', adaptive->'replan_error',
      'checking_batch', to_jsonb((adaptive->'pending'->>'id') is not null),
      'completed_batches', to_jsonb(batches),
      'last_batch', case when batches > 0 then completed->(batches - 1) end)));
  end if;

  -- saved_email_recovery: наружу только флаг ожидания, не карта проверенных.
  if (v->'saved_email_recovery'->>'attempt_id') is not null then
    info := info || jsonb_build_object('saved_email_review_pending', to_jsonb(
      (v->'saved_email_recovery'->'batch'->>'id') is not null
      and (v->'saved_email_recovery'->>'error') is null));
  end if;

  -- tasks: три поля для прогресс-карты. harvest внутри задачи — до 50 тысяч
  -- строк, именно он и делал документ неподъёмным.
  if jsonb_typeof(v->'tasks') = 'array' and jsonb_array_length(v->'tasks') > 0 then
    info := info || jsonb_build_object('tasks', (
      select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
               'source', t->'source', 'status', t->'status', 'rows', t->'rows')) order by ord), '[]'::jsonb)
        from jsonb_array_elements(v->'tasks') with ordinality as x(t, ord)));
  end if;

  return case when info = '{}'::jsonb then null else info end;
end $$;

comment on function public.ve_base_public_info(public.ve_bases) is
  'VE2: публичный срез collect_info для карточки проекта. Один детоаст на строку; рабочее состояние воркера наружу не отдаётся.';

revoke all on function public.ve_base_public_info(public.ve_bases) from public, anon;
grant execute on function public.ve_base_public_info(public.ve_bases) to authenticated, service_role;
