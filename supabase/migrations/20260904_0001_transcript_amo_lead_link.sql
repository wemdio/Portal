-- Прямая привязка транскриптов видеозвонков к сделкам AMO по #номеру в подписи.
--
-- Менеджеры выкладывают записи встреч в групповые чаты с подписью вида
--   «#34548997| https://kkt63.ru/ | вела с автоаутрича...»
-- Старая связка (contact_tg_username → личный диалог → tg_chat_id) на групповые
-- чаты не работает: практически все транскрипты лежат из 2 групповых чатов,
-- поэтому AI-разборы никогда не получали ни одного транскрипта. Здесь — явный
-- линк transcript ↔ amo_leads, который парсится из подписи при инжесте
-- (app/src/lib/tgTranscribe.ts) и бэкфиллом ниже.

create table if not exists public.transcript_amo_lead_link (
  id            bigserial primary key,
  transcript_id uuid   not null references public.tg_video_transcripts(id) on delete cascade,
  amo_lead_id   bigint not null references public.amo_leads(id) on delete cascade,
  confidence    numeric(3,2) not null default 1.0 check (confidence between 0 and 1),
  method        text   not null check (method in ('caption_deal_number', 'caption_heuristic', 'manual')),
  matched_at    timestamptz not null default now(),
  unique (transcript_id, amo_lead_id)
);

create index if not exists idx_transcript_amo_link_transcript on public.transcript_amo_lead_link(transcript_id);
create index if not exists idx_transcript_amo_link_lead on public.transcript_amo_lead_link(amo_lead_id);

comment on table public.transcript_amo_lead_link is
  'Привязка транскрипта видеозвонка к сделке AMO. method=caption_deal_number — из «#<номер сделки>» в подписи к видео (confidence 1.0); caption_heuristic — домен/имя клиента в подписи (ниже); manual — руками.';

grant select, insert, update, delete on public.transcript_amo_lead_link to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.transcript_amo_lead_link to readonly';
  end if;
end $$;

-- ─── Бэкфилл за последние 3 месяца по #номеру в подписи ─────────────────

insert into public.transcript_amo_lead_link (transcript_id, amo_lead_id, confidence, method)
select t.id, l.id, 1.0, 'caption_deal_number'
from public.tg_video_transcripts t
join public.amo_leads l
  on l.amo_id = (regexp_match(t.caption, '#\s?(\d{6,10})'))[1]::bigint
where t.caption ~ '#\s?\d{6,10}'
  and t.created_at >= now() - interval '3 months'
on conflict do nothing;

-- ─── View: добавляем прямой линк вторым источником «свежих» транскриптов ──

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
   and lnk.confidence >= 0.9
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

comment on view public.v_sales_ai_stale_transcripts is
  'Сделки, у которых появился транскрипт звонка после последнего AI-разбора: через прямой линк transcript_amo_lead_link (подпись «#номер сделки») или через старую связку по TG-юзернейму. Используется в dealFilter.pickDealsForAnalysis для «молчащих» в AMO сделок с новым звонком.';
