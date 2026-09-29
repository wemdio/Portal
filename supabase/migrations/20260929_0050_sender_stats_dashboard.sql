-- Вкладка «Статистика» «Рассылки»: ответы, доставляемость, лиды — одним вызовом.
--
-- Раньше цифры жили кнопкой «Статистика ответов» в шапке списка ящиков
-- (представление sender_mailbox_stats, всё время целиком) — её три дня не
-- могли найти. Здесь то же и больше, но за выбранный период.
--
-- Два разных среза, и это намеренно:
--   * доли (ответили, отбились, лиды) — по КОГОРТЕ: получатели, которым первое
--     письмо ушло в периоде, и что с ними стало к сегодняшнему дню. Иначе
--     ответ на письмо прошлой недели делился бы на письма этой;
--   * ряды по дням и счётчики писем — по СОБЫТИЯМ: сколько ушло, ответило,
--     отбилось в конкретный день.
-- Ответом, как и во вкладке «Кампании», считается статус replied получателя;
-- отбоем — статус bounced (его ставят и SMTP-отказ, и разбор отбойника).
--
-- p_since null — всё время.

create or replace function public.sender_stats_dashboard(p_since timestamptz default null)
returns jsonb
language sql
stable
as $$
  with first_touch as (
    select m.recipient_id, min(m.sent_at) as first_sent_at
      from public.sender_messages m
     where m.status = 'sent'
     group by m.recipient_id
  ),
  cohort as (
    select r.id, r.campaign_id, r.mailbox_id, r.status, r.lead_verdict,
           r.last_step_sent, r.replied_at, f.first_sent_at
      from first_touch f
      join public.sender_recipients r on r.id = f.recipient_id
     where p_since is null or f.first_sent_at >= p_since
  ),
  letters as (
    select m.campaign_id, m.mailbox_id, m.status
      from public.sender_messages m
     where m.status in ('sent', 'failed')
       and (p_since is null or coalesce(m.sent_at, m.created_at) >= p_since)
  ),
  totals as (
    select count(*)                                          as reached,
           count(*) filter (where c.status = 'replied')      as replied,
           count(*) filter (where c.status = 'bounced')      as bounced,
           count(*) filter (where c.status = 'unsubscribed') as unsubscribed,
           count(*) filter (where c.lead_verdict = 'lead')   as leads,
           count(*) filter (where c.status = 'active')       as in_progress,
           percentile_cont(0.5) within group (
             order by extract(epoch from (c.replied_at - c.first_sent_at)) / 3600
           ) filter (where c.status = 'replied' and c.replied_at is not null) as median_reply_hours
      from cohort c
  ),
  letter_totals as (
    select count(*) filter (where l.status = 'sent')   as sent,
           count(*) filter (where l.status = 'failed') as failed
      from letters l
  ),
  inbox as (
    select p.kind, count(*) as n
      from public.sender_replies p
     where p.kind <> 'warmup'
       and (p_since is null or coalesce(p.received_at, p.created_at) >= p_since)
     group by p.kind
  ),
  suppressed as (
    select s.reason, count(*) as n
      from public.sender_suppressions s
     where p_since is null or s.created_at >= p_since
     group by s.reason
  ),
  -- Ряд по дням (МСК): от начала периода, а для «всего времени» — от первого
  -- отправленного письма; пустые дни — нулями, иначе график склеивает провалы.
  day_range as (
    select d::date as day
      from generate_series(
             (coalesce(p_since,
                       (select min(first_sent_at) from first_touch),
                       now()) at time zone 'Europe/Moscow')::date,
             (now() at time zone 'Europe/Moscow')::date,
             interval '1 day') d
  ),
  daily_sent as (
    select (m.sent_at at time zone 'Europe/Moscow')::date as day, count(*) as n
      from public.sender_messages m
     where m.status = 'sent'
       and (p_since is null or m.sent_at >= p_since)
     group by 1
  ),
  daily_replied as (
    select (r.replied_at at time zone 'Europe/Moscow')::date as day, count(*) as n
      from public.sender_recipients r
     where r.status = 'replied'
       and r.replied_at is not null
       and (p_since is null or r.replied_at >= p_since)
     group by 1
  ),
  daily_bounced as (
    select (r.updated_at at time zone 'Europe/Moscow')::date as day, count(*) as n
      from public.sender_recipients r
     where r.status = 'bounced'
       and (p_since is null or r.updated_at >= p_since)
     group by 1
  ),
  daily_leads as (
    select (r.lead_verdict_at at time zone 'Europe/Moscow')::date as day, count(*) as n
      from public.sender_recipients r
     where r.lead_verdict = 'lead'
       and r.lead_verdict_at is not null
       and (p_since is null or r.lead_verdict_at >= p_since)
     group by 1
  ),
  by_campaign as (
    select c.campaign_id,
           count(*)                                     as reached,
           count(*) filter (where c.status = 'replied') as replied,
           count(*) filter (where c.status = 'bounced') as bounced,
           count(*) filter (where c.lead_verdict = 'lead') as leads
      from cohort c
     group by c.campaign_id
  ),
  campaign_letters as (
    select l.campaign_id, count(*) filter (where l.status = 'sent') as sent
      from letters l
     group by l.campaign_id
  ),
  by_mailbox as (
    select c.mailbox_id,
           count(*)                                     as reached,
           count(*) filter (where c.status = 'replied') as replied,
           count(*) filter (where c.status = 'bounced') as bounced,
           count(*) filter (where c.lead_verdict = 'lead') as leads
      from cohort c
     where c.mailbox_id is not null
     group by c.mailbox_id
  ),
  mailbox_letters as (
    select l.mailbox_id,
           count(*) filter (where l.status = 'sent')   as sent,
           count(*) filter (where l.status = 'failed') as failed
      from letters l
     group by l.mailbox_id
  ),
  -- Какое письмо цепочки получило ответ: ответ обрывает цепочку, поэтому
  -- последний отправленный шаг у ответившего — тот, на который он ответил.
  by_step as (
    select c.last_step_sent as step, count(*) as replied
      from cohort c
     where c.status = 'replied' and c.last_step_sent > 0
     group by c.last_step_sent
  ),
  step_reached as (
    select m.step_no as step, count(distinct m.recipient_id) as reached
      from public.sender_messages m
      join cohort c on c.id = m.recipient_id
     where m.status = 'sent'
     group by m.step_no
  )
  select jsonb_build_object(
    'totals', (select to_jsonb(t) from totals t),
    'letters', (select to_jsonb(l) from letter_totals l),
    'inbox', coalesce((select jsonb_object_agg(i.kind, i.n) from inbox i), '{}'::jsonb),
    'suppressed', coalesce((select jsonb_object_agg(s.reason, s.n) from suppressed s), '{}'::jsonb),
    'mailboxes', (
      select jsonb_build_object(
               'total', count(*),
               'enabled', count(*) filter (where mb.enabled),
               'failed', count(*) filter (where mb.enabled and mb.status = 'failed'))
        from public.sender_mailboxes mb
    ),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
               'day', d.day,
               'sent', coalesce(s.n, 0),
               'replied', coalesce(r.n, 0),
               'bounced', coalesce(b.n, 0),
               'leads', coalesce(ld.n, 0)) order by d.day)
        from day_range d
        left join daily_sent s on s.day = d.day
        left join daily_replied r on r.day = d.day
        left join daily_bounced b on b.day = d.day
        left join daily_leads ld on ld.day = d.day
    ), '[]'::jsonb),
    'campaigns', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', sc.id,
               'name', sc.name,
               'status', sc.status,
               'sent', coalesce(cl.sent, 0),
               'reached', coalesce(bc.reached, 0),
               'replied', coalesce(bc.replied, 0),
               'bounced', coalesce(bc.bounced, 0),
               'leads', coalesce(bc.leads, 0)) order by coalesce(cl.sent, 0) desc, sc.name)
        from public.sender_campaigns sc
        left join by_campaign bc on bc.campaign_id = sc.id
        left join campaign_letters cl on cl.campaign_id = sc.id
       where coalesce(cl.sent, 0) > 0 or coalesce(bc.reached, 0) > 0
    ), '[]'::jsonb),
    'mailboxList', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', mb.id,
               'email', mb.email,
               'enabled', mb.enabled,
               'status', mb.status,
               'sent', coalesce(ml.sent, 0),
               'failed', coalesce(ml.failed, 0),
               'reached', coalesce(bm.reached, 0),
               'replied', coalesce(bm.replied, 0),
               'bounced', coalesce(bm.bounced, 0),
               'leads', coalesce(bm.leads, 0)) order by coalesce(ml.sent, 0) desc, mb.email)
        from public.sender_mailboxes mb
        left join by_mailbox bm on bm.mailbox_id = mb.id
        left join mailbox_letters ml on ml.mailbox_id = mb.id
       where coalesce(ml.sent, 0) > 0 or coalesce(ml.failed, 0) > 0 or coalesce(bm.reached, 0) > 0
    ), '[]'::jsonb),
    'steps', coalesce((
      select jsonb_agg(jsonb_build_object(
               'step', sr.step,
               'reached', sr.reached,
               'replied', coalesce(bs.replied, 0)) order by sr.step)
        from step_reached sr
        left join by_step bs on bs.step = sr.step
    ), '[]'::jsonb)
  )
$$;

comment on function public.sender_stats_dashboard is
  'Sender «Статистика» tab in one call: cohort rates (recipients first reached since p_since), daily event series in Europe/Moscow, per campaign / mailbox / chain step. p_since null = all time.';
