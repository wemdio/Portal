-- VE2 2ГИС, R3 часть 5: срез public_info знает сон базы и подписи близнеца.
--
-- Меняется ТОЛЬКО функция среза public.ve_base_public_info — тело из
-- 20261012_0002_ve_project_exclusions.sql байт в байт, кроме двух вставок:
--   1) two_gis_sleep {since, reason} после белого списка;
--   2) у задачи-близнеца two_gis базы с флагом — unavailable/exhausted/
--      hit_ceiling/note/postponed (причина отсрочки, без not_before).
-- Триггер ve_bases_public_info_sync и ve_base_public_info_cached не меняются:
-- они зовут эту функцию.
--
-- Пересчёта старых строк НЕТ и не нужно: массовый UPDATE ve_bases детоастил бы
-- каждый collect_info (гигабайты) и держал бы блокировки строк во время деплоя.
-- На проде нет ни флагов two_gis_source, ни меток сна; новая запись collect_info
-- пересчитывает срез триггером сама. У баз без этих ключей срез не меняется:
-- ключа сна нет, а || '{}' — тождество.
--
-- Перезапускаема: create or replace сохраняет права и комментарий функции, а
-- revoke/grant ниже повторяют 20260925_0001 и идемпотентны.

create or replace function public.ve_base_public_info(b public.ve_bases)
returns jsonb language plpgsql stable parallel safe set search_path = '' as $$
declare
  -- ПОРЯДОК ЗДЕСЬ — ЭТО ПРОИЗВОДИТЕЛЬНОСТЬ, А НЕ СТИЛЬ. Сначала ОДНОЙ операцией
  -- снимаем тяжёлые ветки: дальше все обращения идут по документу в сотни раз
  -- меньше. Замер на проекте «Аврора» (17 баз, 586 МБ): такой порядок — 1,7 с,
  -- белый список сразу по полному документу — 12,7 с, а двадцать два отдельных
  -- обращения по ключам — 31 с, потому что переменная детоастится на каждое.
  v jsonb := b.collect_info - array['project_exclusion_reserve', 'relevance_reserve', 'target_checkpoint',
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
                     'project_exclusions', 'relevance_summary', 'company_contact_cap', 'company_name_cleanup',
                     'company_name_recovery', 'source_contact_discovery',
                     'relevance_review_requested', 'validation_retry', 'hypothesis_id',
                     'hypothesis_ids', 'hypotheses', 'plan_repair', 'slice_probe')), '{}'::jsonb);

  -- two_gis_sleep (R3 части 4–5): только когда и почему база спит. Его читают
  -- карточка базы и монитор health-check («база с близнецом спит дольше суток»).
  if jsonb_typeof(v->'two_gis_sleep') = 'object' then
    info := info || jsonb_build_object('two_gis_sleep', jsonb_strip_nulls(jsonb_build_object(
      'since', v->'two_gis_sleep'->'since', 'reason', v->'two_gis_sleep'->'reason')));
  end if;

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
  -- Близнец 2ГИС (только у базы с флагом two_gis_source) добавляет подписи
  -- состояния. Курсор t->'two_gis' (after — card_id) и two_gis_query наружу не идут;
  -- у остальных задач || '{}' ничего не меняет.
  if jsonb_typeof(v->'tasks') = 'array' and jsonb_array_length(v->'tasks') > 0 then
    info := info || jsonb_build_object('tasks', (
      select coalesce(jsonb_agg((jsonb_strip_nulls(jsonb_build_object(
               'source', t->'source', 'status', t->'status', 'rows', t->'rows'))
             || case when t->>'source' = 'two_gis' and v ? 'two_gis_source' then jsonb_strip_nulls(jsonb_build_object(
               'unavailable', t->'unavailable', 'exhausted', t->'exhausted', 'hit_ceiling', t->'hit_ceiling',
               'note', t->'note', 'postponed', t->'two_gis_wait'->'postponed'->'reason')) else '{}'::jsonb end)
             order by ord), '[]'::jsonb)
        from jsonb_array_elements(v->'tasks') with ordinality as x(t, ord)));
  end if;

  return case when info = '{}'::jsonb then null else info end;
end $$;

revoke all on function public.ve_base_public_info(public.ve_bases)
  from public, anon, authenticated;
grant execute on function public.ve_base_public_info(public.ve_bases)
  to service_role, postgres;
