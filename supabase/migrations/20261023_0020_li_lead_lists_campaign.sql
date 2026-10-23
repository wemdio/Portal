-- База лидов LinkedIn принадлежит кампании: кампания рассылает одну (активную)
-- базу — её li_campaigns.lead_list_id, — но баз у неё может быть несколько.
-- NULL — база без кампании (наследство общих списков): её переносят в кампанию.
alter table public.li_lead_lists
  add column if not exists campaign_id uuid references public.li_campaigns(id) on delete set null;

create index if not exists idx_li_lead_lists_campaign on public.li_lead_lists(campaign_id);

-- Перенос: список, выбранный в кампании, становится её базой. Если один список
-- выбрали в нескольких кампаниях — достаётся самой старой, остальные привязываются вручную.
update public.li_lead_lists l
   set campaign_id = pick.campaign_id
  from (
    select distinct on (lead_list_id) lead_list_id, id as campaign_id
      from public.li_campaigns
     where lead_list_id is not null
     order by lead_list_id, created_at
  ) pick
 where l.id = pick.lead_list_id and l.campaign_id is null;

comment on column public.li_lead_lists.campaign_id is
  'Campaign that owns this base. The campaign sends only its active base (li_campaigns.lead_list_id); NULL = base without a campaign.';
