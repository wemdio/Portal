-- Reviewed 2026-09-23. The account-2 campaign predates the Portal project and
-- has a generic name, so name-based auto-matching could not claim it. Its
-- outbound identifies Mailganer. Claim only this campaign through the same
-- cross-table ownership lock used by manual project settings. Do not replay
-- or requalify its historical replies. The recovery worker can resolve old
-- ownerless leads after a link appears, so abort if any are still inside its
-- normal seven-day retry window rather than risk a retrospective alert.
--
-- Seven existing guest-board rows had an explicit organization and two had a
-- signed personal name, but their corresponding cells were empty. Fill only
-- those reviewed cells; preserve edits and every other board column. Another
-- blank company appears after ambiguous forwarded history and stays blank.
do $$
declare
  v_campaign_id constant text := '58a0d67d-6b15-4da8-ae4d-a2059579b5d2';
  v_project_id constant uuid := 'd440e6ab-513a-41b4-81bd-8c962728e714';
  v_claim jsonb;
begin
  if not exists (
    select 1 from public.instantly_campaign_catalog
    where id = v_campaign_id::uuid
      and instantly_account_id = 'account-2'
      and name = 'Высокий скор'
  ) or exists (
    select 1 from public.project_instantly_campaigns_denylist
    where campaign_id = v_campaign_id and project_id = v_project_id
  ) or (
    select count(*) from public.instantly_lead_qualifications
    where campaign_id = v_campaign_id
      and last_outbound_preview ilike '%Mailganer%'
  ) < 20 then
    raise exception 'Mailganer campaign evidence changed; review ownership before linking';
  end if;

  if exists (
    select 1 from public.instantly_lead_qualifications
    where campaign_id = v_campaign_id
      and status = 'lead'
      and qualified_project_id is null
      and qualified_project_owner_proven is distinct from true
      and queue_archived_at is null
      and (created_at >= now() - interval '7 days' or updated_at >= now() - interval '7 days')
  ) then
    raise exception 'Recent ownerless Mailganer leads need no-replay review before linking';
  end if;

  v_claim := public.claim_project_instantly_campaign(
    p_project_id => v_project_id,
    p_campaign_id => v_campaign_id,
    p_match_source => 'manual',
    p_period_id => null,
    p_baseline_contacts => 0,
    p_match_confidence => 1,
    p_match_reason => 'Reviewed account-2 Mailganer outbound and unique project on 2026-09-23',
    p_replace_automatic => false
  );
  if coalesce(v_claim->>'status', '') not in ('claimed', 'unchanged') then
    raise exception 'Mailganer campaign ownership conflict: %', v_claim;
  end if;

  update public.project_lead_board_rows as row
  set company_name = reviewed.company_name,
      updated_at = now()
  from (values
    ('ef020d28-08b3-42d2-a35d-36253cad8c58'::uuid, '5bccaf1d-8552-47d5-9635-927b59390708'::uuid, 'ООО "ЦР Софториум"'),
    ('9adeb07d-cddd-4e71-a8fb-350333312732'::uuid, 'b5042c6d-0b87-40f6-a6a9-5303ea0507c6'::uuid, 'Музей МАФ'),
    ('735d4888-f9e2-4fb8-8c97-605038852717'::uuid, '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c'::uuid, 'Иргиредмет'),
    ('2cba4b3d-877f-4a34-92e9-edf808ac0e73'::uuid, '837cbcb1-9afb-49c9-965c-d83d1e7d8e9c'::uuid, 'ООО «Сумитек Интернейшнл»'),
    ('283669b5-7ed1-4f5a-8e76-c93a049edfc3'::uuid, 'd600221d-32b2-4e62-b3a5-b4c6f5d17c38'::uuid, 'ИНФОПРО'),
    ('f7cf5ef5-715b-457d-b5e7-4ea385b1c5cb'::uuid, '93310d6c-803a-40ce-9b3d-97e8e7d14527'::uuid, 'Агентство недвижимости "Добрый день"'),
    ('7068ed9b-19bf-4971-88f7-eec567e502d6'::uuid, '7b1ecc94-2e8a-4f19-ae74-9bf63ca907cc'::uuid, 'ООО «ОСК»')
  ) as reviewed(qualification_id, project_id, company_name)
  where row.qualification_id = reviewed.qualification_id
    and row.project_id = reviewed.project_id
    and nullif(btrim(coalesce(row.company_name, '')), '') is null;

  -- Keep personal names out of the migration source: extract them only from
  -- these two verified current-author signatures at apply time.
  update public.project_lead_board_rows as row
  set lead_name = reviewed.lead_name,
      updated_at = now()
  from (
    select target.qualification_id, target.project_id,
      (regexp_match(qualification.reply_body, target.name_pattern))[1] as lead_name
    from (values
      ('14685f9b-3887-4985-ab98-649db40b337d'::uuid, '055602fa-2f8a-47af-8c7d-e395ba45ba67'::uuid,
        '([A-Z][A-Za-z-]+[[:space:]][A-Z][A-Za-z-]+)<https://www[.]linkedin[.]com/in/[a-z-]+/?>'),
      ('f7cf5ef5-715b-457d-b5e7-4ea385b1c5cb'::uuid, '93310d6c-803a-40ce-9b3d-97e8e7d14527'::uuid,
        '([А-ЯЁ][а-яё]+[[:space:]][А-ЯЁ][а-яё]+),[[:space:]]*директор Агентства недвижимости')
    ) as target(qualification_id, project_id, name_pattern)
    join public.instantly_lead_qualifications as qualification
      on qualification.id = target.qualification_id
  ) as reviewed
  where row.qualification_id = reviewed.qualification_id
    and row.project_id = reviewed.project_id
    and reviewed.lead_name is not null
    and nullif(btrim(coalesce(row.lead_name, '')), '') is null;
end $$;
