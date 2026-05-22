-- One-off backfill: re-label leads that were misclassified as 'invited' by the
-- pre-fix campaign runner when LinkedIn actually responded `already_invited`.
--
-- Why this exists
-- ---------------
-- Before commit "fix(li-outreach): honest already_invited handling" the
-- runner did this on `already_invited` response from LinkedIn:
--   UPDATE li_leads        SET status='invited'   WHERE id = lead.id;
--   UPDATE li_campaign_leads SET current_step = stepIdx+1,
--                                status = 'in_progress' (or 'completed')
--    WHERE id = cl.id;
--
-- So leads we never actually invited (LinkedIn refused because someone had
-- already invited them) were marked 'invited' in our DB. In one prod case
-- this inflated the campaign funnel "Приглашены" to 153 while the LinkedIn
-- account dashboard reported only 57 invitations sent.
--
-- After the fix the runner sets status='already_invited' and marks the
-- campaign-lead row 'skipped' WITHOUT advancing current_step. This script
-- retroactively applies the same correction to existing rows.
--
-- How we identify mis-labelled rows
-- ---------------------------------
-- The success path logs "Инвайт отправлен" via li_campaign_logs; the
-- already_invited path logs the literal Russian "already_invited" warning.
-- A lead is mis-labelled when:
--   1) Its li_leads.status is currently 'invited', AND
--   2) There is at least one log row whose message contains «already_invited»
--      for that lead (matched by lead_name + campaign_id), AND
--   3) There is NO «Инвайт отправлен» log row for that lead in ANY campaign
--      — i.e. we never actually sent a real invite anywhere.
--
-- Run order
-- ---------
-- 1) Run the SELECT block first — it lists what will change, nothing else.
-- 2) If counts look right, run the UPDATE block inside an explicit
--    transaction. Wrap in BEGIN/ROLLBACK first if you want to dry-run.
--
-- Prereq: the 20260522_0001 migration must already be applied (the new
-- 'already_invited' enum value must be in the CHECK constraint).

-- ─── 1. Preview: list the rows that would be re-labelled ─────────────────

with mis_labelled as (
  select cl.id   as campaign_lead_id,
         cl.lead_id,
         cl.campaign_id,
         l.name  as lead_name,
         l.status as current_lead_status,
         cl.status as current_cl_status,
         cl.current_step
    from public.li_campaign_leads cl
    join public.li_leads l on l.id = cl.lead_id
   where l.status = 'invited'
     and exists (
       select 1
         from public.li_campaign_logs lg
        where lg.campaign_id = cl.campaign_id
          and lg.lead_name   = l.name
          and lg.step_index  = 0
          and lg.message    ilike '%already_invited%'
     )
     and not exists (
       -- never had a real "Инвайт отправлен" anywhere
       select 1
         from public.li_campaign_logs lg
        where lg.lead_name = l.name
          and lg.message  ilike '%Инвайт отправлен%'
     )
)
select count(*)                                                 as rows_to_flip,
       count(distinct lead_id)                                  as distinct_leads,
       count(distinct campaign_id)                              as campaigns_touched,
       array_agg(distinct campaign_id)                          as campaigns
  from mis_labelled;

-- (Inspect the list itself if you want — same CTE, returned in full)
-- select * from mis_labelled order by campaign_id, lead_name;


-- ─── 2. Apply: re-label leads + skip their campaign-lead rows ────────────
-- Run inside a transaction so you can ROLLBACK if anything looks off.

begin;

with mis_labelled as (
  select cl.id as campaign_lead_id,
         cl.lead_id,
         cl.campaign_id,
         l.name as lead_name
    from public.li_campaign_leads cl
    join public.li_leads l on l.id = cl.lead_id
   where l.status = 'invited'
     and exists (
       select 1
         from public.li_campaign_logs lg
        where lg.campaign_id = cl.campaign_id
          and lg.lead_name   = l.name
          and lg.step_index  = 0
          and lg.message    ilike '%already_invited%'
     )
     and not exists (
       select 1
         from public.li_campaign_logs lg
        where lg.lead_name = l.name
          and lg.message  ilike '%Инвайт отправлен%'
     )
),
flip_leads as (
  -- Per-lead funnel state: was invited (wrong), now already_invited.
  update public.li_leads l
     set status     = 'already_invited',
         updated_at = now()
    from mis_labelled m
   where l.id = m.lead_id
     and l.status = 'invited'
  returning l.id
),
flip_campaign_leads as (
  -- Per-campaign state: drop them out of the funnel for this campaign
  -- without advancing current_step (matches post-fix runner behaviour).
  update public.li_campaign_leads cl
     set status       = 'skipped',
         current_step = 0,
         updated_at   = now()
    from mis_labelled m
   where cl.id = m.campaign_lead_id
  returning cl.id
)
select (select count(*) from flip_leads)            as leads_relabelled,
       (select count(*) from flip_campaign_leads)   as campaign_lead_rows_skipped;

-- Sanity-check the new global funnel for the affected campaigns.
-- Compare the result to what the LinkedIn account itself reports.
-- If everything looks right:
commit;
-- Otherwise:
-- rollback;
