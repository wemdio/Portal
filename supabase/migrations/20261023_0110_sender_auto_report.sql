-- «Автоотчёты» по кампаниям «Рассылки» (решение владельца 23.10.2026).
--
-- Отчёт клиенту собирает тот же построитель, что и по Instantly
-- (lib/tools/autoReportBuilder), поэтому цифры отдаются в той же форме, что
-- аналитика Instantly: сводка кампании (/campaigns/analytics) и строки шагов с
-- вариантами (/campaigns/analytics/steps). Открытий нет — трекинга у «Рассылки»
-- нет намеренно.
--
--   • взято в работу (new_leads_contacted_count) — получатели, которым ушло
--     первое письмо;
--   • ответы — получатели с ответом человека и отдельно с автоответом, как
--     «REPLIED» у Instantly;
--   • база (leads_count) — взятые в работу и ещё ждущие первого письма;
--     снятые до первого письма (стоп-лист, остановка) в «осталось» не идут;
--   • бракованные — получатели в статусе «отбой» или с пришедшим отбоем
--     (статус мог смениться позже, например на «ответил»);
--   • ответ по шагу — как в разбивке по шагам «Рассылки»: лид ответил после
--     письма этого шага; лиды по шагу — то же для отметки «лид».
create or replace function public.sender_auto_report(p_campaign_ids uuid[])
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'campaign_id', c.id,
           'summary', jsonb_build_object(
             'campaign_id', c.id,
             'campaign_name', c.name,
             'new_leads_contacted_count', s.contacted,
             'contacted_count', s.contacted,
             'emails_sent_count', s.sent,
             'reply_count_unique', s.human_replied,
             'reply_count_automatic_unique', s.auto_replied,
             'leads_count', s.recipients,
             'bounced_count', s.bounced,
             'open_count', 0,
             'open_count_unique', 0
           ),
           'steps', coalesce(st.steps, '[]'::jsonb)
         ) order by array_position(p_campaign_ids, c.id)), '[]'::jsonb)
    from public.sender_campaigns c
    cross join lateral (
      select count(*) filter (where r.last_step_sent >= 1 or r.status = 'active') as recipients,
             count(*) filter (where r.last_step_sent >= 1) as contacted,
             count(*) filter (where r.status = 'bounced' or h.has_bounce) as bounced,
             count(*) filter (where h.has_human) as human_replied,
             count(*) filter (where not h.has_human and h.has_auto) as auto_replied,
             (select count(*) from public.sender_messages m
               where m.campaign_id = c.id and m.status = 'sent') as sent
        from public.sender_recipients r
        cross join lateral (
          select exists (select 1 from public.sender_replies p
                          where p.recipient_id = r.id and p.kind = 'human') as has_human,
                 exists (select 1 from public.sender_replies p
                          where p.recipient_id = r.id and p.kind = 'auto_reply') as has_auto,
                 exists (select 1 from public.sender_replies p
                          where p.recipient_id = r.id and p.kind = 'bounce') as has_bounce
        ) h
       where r.campaign_id = c.id
    ) s
    left join lateral (
      select jsonb_agg(jsonb_build_object(
               'step', v.step_no - 1,
               'variant', v.variant_no - 1,
               'sent', v.sent,
               'unique_replies', v.replied,
               'opportunities', v.leads
             ) order by v.step_no, v.variant_no) as steps
        from (
          select m.step_no,
                 m.variant_no,
                 count(*) filter (where m.status = 'sent') as sent,
                 count(*) filter (where m.status = 'sent' and r.status = 'replied'
                                    and r.last_step_sent = m.step_no) as replied,
                 count(*) filter (where m.status = 'sent' and r.lead_verdict = 'lead'
                                    and r.last_step_sent = m.step_no) as leads
            from public.sender_messages m
            join public.sender_recipients r on r.id = m.recipient_id
           where m.campaign_id = c.id
           group by m.step_no, m.variant_no
        ) v
    ) st on true
   where c.id = any(p_campaign_ids)
$$;

revoke all on function public.sender_auto_report(uuid[]) from public;
grant execute on function public.sender_auto_report(uuid[]) to service_role;

comment on function public.sender_auto_report(uuid[]) is
  'Auto-report numbers for sender campaigns in the shape of Instantly campaign analytics (summary + per-step variants).';
