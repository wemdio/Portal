-- ── Статистика всех кампаний «Рассылки» одним запросом ──────────────────────
-- Список кампаний во вкладке «Письма» считал статистику отдельно по каждой
-- кампании: около 16 запросов счётчиков через PostgREST на кампанию, сотни на
-- одну загрузку страницы, ответ сервера — больше двух секунд. Здесь те же
-- счётчики считаются группировкой по campaign_id за один вызов.
--
-- «Сегодня» — с начала суток в поясе кампании (у EN — Нью-Йорк), как и раньше.
-- remaining — сколько писем ещё должно уйти активным получателям: на шаге k
-- осталось step_count − k; при step_count = 0 приложение показывает «—».
create or replace function public.sender_campaign_stats_all()
returns table (
  campaign_id   uuid,
  recipients    bigint,
  replied       bigint,
  bounced       bigint,
  reached       bigint,
  finished      bigint,
  unsubscribed  bigint,
  in_progress   bigint,
  not_contacted bigint,
  sent          bigint,
  scheduled     bigint,
  failed        bigint,
  sent_today    bigint,
  new_today     bigint,
  step_count    integer,
  remaining     bigint
)
language sql
stable
as $$
  with c as (
    select id,
           (date_trunc('day', now() at time zone coalesce(timezone, 'Europe/Moscow'))
              at time zone coalesce(timezone, 'Europe/Moscow')) as day_start
      from public.sender_campaigns
  ),
  st as (
    select s.campaign_id, max(s.step_no)::integer as step_count
      from public.sender_campaign_steps s
     group by s.campaign_id
  ),
  r as (
    select r.campaign_id,
           count(*)                                                         as recipients,
           count(*) filter (where r.status = 'replied')                     as replied,
           count(*) filter (where r.status = 'bounced')                     as bounced,
           count(*) filter (where r.last_step_sent > 0)                     as reached,
           count(*) filter (where r.status = 'finished')                    as finished,
           count(*) filter (where r.status = 'unsubscribed')                as unsubscribed,
           count(*) filter (where r.status = 'active' and r.last_step_sent > 0) as in_progress,
           count(*) filter (where r.status = 'active' and r.last_step_sent = 0) as not_contacted,
           coalesce(sum(greatest(coalesce(st.step_count, 0) - r.last_step_sent, 0))
                      filter (where r.status = 'active'), 0)               as remaining
      from public.sender_recipients r
      left join st on st.campaign_id = r.campaign_id
     group by r.campaign_id
  ),
  m as (
    select m.campaign_id,
           count(*) filter (where m.status = 'sent')                                            as sent,
           count(*) filter (where m.status = 'scheduled')                                       as scheduled,
           count(*) filter (where m.status = 'failed')                                          as failed,
           count(*) filter (where m.status = 'sent' and m.sent_at >= c.day_start)               as sent_today,
           count(*) filter (where m.status = 'sent' and m.step_no = 1 and m.sent_at >= c.day_start) as new_today
      from public.sender_messages m
      join c on c.id = m.campaign_id
     group by m.campaign_id
  )
  select c.id,
         coalesce(r.recipients, 0), coalesce(r.replied, 0), coalesce(r.bounced, 0),
         coalesce(r.reached, 0), coalesce(r.finished, 0), coalesce(r.unsubscribed, 0),
         coalesce(r.in_progress, 0), coalesce(r.not_contacted, 0),
         coalesce(m.sent, 0), coalesce(m.scheduled, 0), coalesce(m.failed, 0),
         coalesce(m.sent_today, 0), coalesce(m.new_today, 0),
         coalesce(st.step_count, 0), coalesce(r.remaining, 0)
    from c
    left join r  on r.campaign_id  = c.id
    left join m  on m.campaign_id  = c.id
    left join st on st.campaign_id = c.id
$$;

revoke all on function public.sender_campaign_stats_all() from public;
grant execute on function public.sender_campaign_stats_all() to service_role;

comment on function public.sender_campaign_stats_all is
  'Per-campaign counters for the sender campaign list (recipients, messages, today in campaign timezone, letters remaining) in one call instead of ~16 count queries per campaign.';
