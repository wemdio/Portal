-- «Наш автоаутрич»: оффер «Автоматизированный аутрич» (INSTRUCTION_03, 25.09.2026).
-- Подходящие компании делятся 50/50 по домену между обычной цепочкой и этим оффером.

alter table public.polza_ru_outreach_companies
  drop constraint if exists polza_ru_outreach_companies_chain_type_check;
alter table public.polza_ru_outreach_companies
  add constraint polza_ru_outreach_companies_chain_type_check
  check (chain_type in ('reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only', 'automation'));

alter table public.polza_ru_offer_claims
  drop constraint if exists polza_ru_offer_claims_chain_type_check;
alter table public.polza_ru_offer_claims
  add constraint polza_ru_offer_claims_chain_type_check
  check (chain_type in ('reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only', 'automation', 'all'));
