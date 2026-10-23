-- Этапы баз кампании: базы одного этапа рассылаются параллельно (по контакту из
-- каждой по кругу), следующий этап стартует, когда предыдущий выдал всё.
-- Заменяет общий переключатель bases_chain (колонка остаётся, но не читается).
--
-- stage — номер этапа (меньше — раньше). Одинаковый номер — параллельно.
alter table public.tg_outreach_campaign_bases
  add column if not exists stage integer not null default 0;

-- Перенос старого режима: цепочка — у каждой базы свой этап по порядку,
-- параллельно — все в нулевом.
update public.tg_outreach_campaign_bases cb
   set stage = cb.position
  from public.tg_outreach_campaigns c
 where c.id = cb.campaign_id and c.bases_chain is true and cb.stage = 0 and cb.position > 0;

comment on column public.tg_outreach_campaign_bases.stage is
  'Stage of the base in the campaign (lower first). Bases with the same stage are sent in parallel; the next stage starts when the previous has nothing left.';
