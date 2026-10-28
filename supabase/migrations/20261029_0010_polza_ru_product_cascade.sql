-- Каскад «Нашего автоаутрича» (RU): одной и той же компании по очереди предлагаем
-- продукты СДР, классика, классика за рубеж и автоаутрич, с паузами между ними.
-- Для каскада нужны: продукт и номер шага у строки запуска, причина закрытия
-- разговора ИИ, короткие КП и ссылки на КП по продуктам у папки.

-- Продукт и шаг каскада у строки компании; у старых строк (до каскада) — null.
alter table public.polza_ru_outreach_companies
  add column if not exists product text,
  add column if not exists cascade_no smallint;

alter table public.polza_ru_outreach_companies
  drop constraint if exists polza_ru_outreach_companies_product_check;
alter table public.polza_ru_outreach_companies
  add constraint polza_ru_outreach_companies_product_check
  check (product in ('sdr', 'classic', 'classic_abroad', 'auto'));

alter table public.polza_ru_outreach_companies
  drop constraint if exists polza_ru_outreach_companies_cascade_no_check;
alter table public.polza_ru_outreach_companies
  add constraint polza_ru_outreach_companies_cascade_no_check
  check (cascade_no between 1 and 3);

-- Утверждения оффера теперь бывают и на продукт: ключи продуктов рядом с цепочками.
alter table public.polza_ru_offer_claims
  drop constraint if exists polza_ru_offer_claims_chain_type_check;
alter table public.polza_ru_offer_claims
  add constraint polza_ru_offer_claims_chain_type_check
  check (chain_type in (
    'reactivation', 'hiring', 'ad_budget', 'event', 'growth_event', 'icp_only', 'automation',
    'all',
    'sdr', 'classic', 'classic_abroad', 'auto'
  ));

-- Поиск прошлых запусков компании по домену и по ИНН (вернувшиеся компании).
-- Те же индексы уже создавала 20260922_0008; здесь — страховка, если их там нет.
create index if not exists idx_polza_ru_outreach_ready_domain
  on public.polza_ru_outreach_companies (normalized_domain) where row_status = 'ready';
create index if not exists idx_polza_ru_outreach_ready_inn
  on public.polza_ru_outreach_companies (inn) where row_status = 'ready';

-- Чем закончился разговор ИИ: отказ, встречное предложение или остановка.
alter table public.sender_ai_conversations
  add column if not exists close_reason text;

alter table public.sender_ai_conversations
  drop constraint if exists sender_ai_conversations_close_reason_check;
alter table public.sender_ai_conversations
  add constraint sender_ai_conversations_close_reason_check
  check (close_reason in ('decline', 'counter_offer', 'stop'));

-- Короткие КП и ссылки на КП по продуктам; ключи — продукты (sdr, classic, ...).
alter table public.sender_folders
  add column if not exists ai_offer_texts jsonb not null default '{}'::jsonb,
  add column if not exists kp_links jsonb not null default '{}'::jsonb;
