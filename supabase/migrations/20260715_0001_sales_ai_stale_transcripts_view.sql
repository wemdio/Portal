-- View «сделки со свежим транскриптом после последнего AI-анализа».
--
-- Обычный dealFilter в pickDealsForAnalysis берёт активные сделки по
-- amo_leads.updated_at >= now() - 60d. Но бывают «молчащие» в AMO
-- сделки, у которых менеджер провёл видеозвонок (транскрипт лёг в
-- tg_video_transcripts), а карточку AMO не обновил — такие сделки
-- крон пропустил бы, хотя данных для нового разбора уже больше.
--
-- View связывает:
--   amo_leads (contact_tg_username)
--   ├─ sales_chat_dialogs (peer_username, tg_peer_id)
--   │   └─ tg_video_transcripts (tg_chat_id, created_at)
--   └─ sales_ai_deal_analysis (max analyzed_at на сделку)
--
-- и оставляет только пары, где latest_transcript_at > last_analyzed_at
-- (то есть транскрипт свежее последнего разбора). Won/lost сделки
-- отфильтрованы, лиды без TG-контакта тоже (по ним линкер не находит
-- диалог, значит и транскрипт не привязан).

create or replace view public.v_sales_ai_stale_transcripts as
select
  l.id                      as amo_lead_id,
  l.updated_at,
  l.status_name,
  l.responsible_name,
  max(t.created_at)         as latest_transcript_at,
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
group by l.id, l.updated_at, l.status_name, l.responsible_name, a.last_analyzed_at;

comment on view public.v_sales_ai_stale_transcripts is
  'Сделки, у которых появился транскрипт звонка после последнего AI-разбора. Используется в dealFilter.pickDealsForAnalysis для «молчащих» в AMO сделок с новым звонком.';

grant select on public.v_sales_ai_stale_transcripts to service_role, postgres;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'readonly') then
    execute 'grant select on public.v_sales_ai_stale_transcripts to readonly';
  end if;
end $$;
