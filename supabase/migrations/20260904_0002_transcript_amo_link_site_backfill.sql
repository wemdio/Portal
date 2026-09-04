-- Дополнение к transcript_amo_lead_link: бэкфилл по сайту клиента в подписи.
--
-- Не все менеджеры пишут «#номер сделки» — многие ограничиваются доменом
-- («https://itprotect.ru/»). Если домен из подписи однозначно матчится ровно
-- на одну активную (не won/lost) сделку — создаём линк с confidence 0.8
-- (method=caption_heuristic). Неоднозначные (uprav.ru → 8 сделок) не линкуем.

with candidates as (
  select distinct t.id as transcript_id, l.id as amo_lead_id
  from public.tg_video_transcripts t
  cross join lateral regexp_matches(
    lower(t.caption),
    '(?:https?://)?(?:www\.)?([a-z0-9][a-z0-9-]{1,}\.[a-z]{2,10})',
    'g'
  ) as d(domain)
  join public.amo_leads l
    on l.status_id not in (142, 143)
   and (strpos(lower(coalesce(l.company_website, '')), d.domain[1]) > 0
     or strpos(lower(l.name), d.domain[1]) > 0)
  where t.created_at >= now() - interval '3 months'
    and t.caption is not null
    and d.domain[1] <> 'polzaagency.ru'
    -- уже привязанные по #номеру не трогаем
    and not exists (
      select 1 from public.transcript_amo_lead_link x
       where x.transcript_id = t.id and x.method = 'caption_deal_number')
),
unique_per_transcript as (
  select transcript_id, min(amo_lead_id) as amo_lead_id
  from candidates
  group by transcript_id
  having count(distinct amo_lead_id) = 1
)
insert into public.transcript_amo_lead_link (transcript_id, amo_lead_id, confidence, method)
select transcript_id, amo_lead_id, 0.8, 'caption_heuristic'
from unique_per_transcript
on conflict do nothing;

-- Порог view опускаем до 0.8, чтобы эвристические линки тоже триггерили
-- доразбор «молчащих» сделок.
create or replace view public.v_sales_ai_stale_transcripts as
with linked as (
  select
    l.id as amo_lead_id,
    l.updated_at,
    l.status_name,
    l.responsible_name,
    max(t.created_at) as latest_transcript_at,
    a.last_analyzed_at
  from public.amo_leads l
  join public.transcript_amo_lead_link lnk
    on lnk.amo_lead_id = l.id
   and lnk.confidence >= 0.8
  join public.tg_video_transcripts t
    on t.id = lnk.transcript_id
   and t.status = 'completed'
  join lateral (
    select max(analyzed_at) as last_analyzed_at
      from public.sales_ai_deal_analysis
     where amo_lead_id = l.id
  ) a on a.last_analyzed_at is not null
  where l.status_id not in (142, 143)
    and t.created_at > a.last_analyzed_at
  group by l.id, l.updated_at, l.status_name, l.responsible_name, a.last_analyzed_at
),
by_username as (
  select
    l.id as amo_lead_id,
    l.updated_at,
    l.status_name,
    l.responsible_name,
    max(t.created_at) as latest_transcript_at,
    a.last_analyzed_at
  from public.amo_leads l
  join public.sales_chat_dialogs d
    on lower(d.peer_username) = lower(l.contact_tg_username)
  join public.tg_video_transcripts t
    on t.tg_chat_id = d.tg_peer_id
   and t.status = 'completed'
  join lateral (
    select max(analyzed_at) as last_analyzed_at
      from public.sales_ai_deal_analysis
     where amo_lead_id = l.id
  ) a on a.last_analyzed_at is not null
  where l.status_id not in (142, 143)
    and l.contact_tg_username is not null
    and t.created_at > a.last_analyzed_at
  group by l.id, l.updated_at, l.status_name, l.responsible_name, a.last_analyzed_at
)
select * from linked
union
select * from by_username;
