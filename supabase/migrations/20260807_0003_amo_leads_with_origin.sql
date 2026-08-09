-- Сделки с исходной воронкой — для запросов, которым нужны колонки самой сделки.
--
-- `amo_lead_stage_dates_v` уже отдаёт исходную воронку (см. 20260807_0002), но
-- только вместе с датами этапов и без полей сделки: имени, компании, сайта,
-- названия статуса. Запросам вроде поиска сделки при привязке записи встречи
-- нужны именно они, и им приходилось фильтровать `amo_leads.pipeline_id` —
-- то есть текущую воронку, из-за чего перенесённая сделка в поиске не находилась.
--
-- Логика вычисления исходной воронки НЕ продублирована: она берётся из того же
-- представления. Вторая независимая копия рано или поздно разъехалась бы с
-- первой, и два экрана начали бы считать одну и ту же сделку по-разному —
-- ровно та ошибка, от которой предостерегают комментарии в 20260730_0001.
--
-- `coalesce` на случай, если сделки почему-то нет в stage-dates: тогда исходной
-- считаем текущую воронку, как и везде в этой связке.
create or replace view public.amo_leads_with_origin_v as
  select
    l.*,
    coalesce(v.pipeline_id, l.pipeline_id) as origin_pipeline_id
  from public.amo_leads l
  left join public.amo_lead_stage_dates_v v on v.amo_deal_id = l.amo_id;

alter view public.amo_leads_with_origin_v set (security_invoker = on);

comment on view public.amo_leads_with_origin_v is
  'Сделки AMO плюс origin_pipeline_id — воронка, где сделка РОДИЛАСЬ. Для запросов, которым нужны поля сделки и устойчивость к переносам между воронками.';

grant select on public.amo_leads_with_origin_v to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.amo_leads_with_origin_v to readonly';
  end if;
end $$;
