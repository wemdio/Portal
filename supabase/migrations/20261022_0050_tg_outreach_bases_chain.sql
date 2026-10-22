-- Цепочка баз кампании: порядок, в котором их берёт рассылка, и режим.
--
-- position — номер базы в цепочке (по порядку, в котором поставили галочки).
-- bases_chain — выключен: базы идут параллельно, по контакту из каждой по
-- кругу (как было); включён: сначала целиком первая, как закончится — сразу
-- вторая, и так далее, без остановки круга.
alter table public.tg_outreach_campaign_bases
  add column if not exists position integer not null default 0;

alter table public.tg_outreach_campaigns
  add column if not exists bases_chain boolean not null default false;

comment on column public.tg_outreach_campaign_bases.position is
  'Order of the base in the campaign chain (0-based), used when tg_outreach_campaigns.bases_chain is true.';
comment on column public.tg_outreach_campaigns.bases_chain is
  'true: bases are sent one after another in position order; false: round-robin across bases.';
