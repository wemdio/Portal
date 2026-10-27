-- TG-аутрич: убрать из «Диалогов» и статистики переписки аккаунтов друг с
-- другом (прогрев). До 27.10.2026 своими считались только аккаунты той же
-- кампании: аккаунт, прогретый в одной кампании и перенесённый в другую,
-- заводил диалоги с напарниками по прогреву — они попадали в список диалогов,
-- в «ответы» и «требуют внимания». С этой даты боевой цикл узнаёт все наши
-- аккаунты и всех напарников по прогреву (loadFleetTgUserIds в campaignLoop).
--
-- Удаляем только нетронутые: без статуса, без передачи лида и без записей в
-- очереди передач и AMO — сотрудник с ними ничего не делал.
delete from public.tg_outreach_dialogs d
where d.status = 'none'
  and d.lead_source is null
  and d.auto_forwarded_at is null
  and (
    exists (select 1 from public.tg_outreach_accounts a where a.tg_user_id = d.tg_user_id)
    or exists (select 1 from public.tg_outreach_warmup_peers p where p.tg_user_id = d.tg_user_id::text)
  )
  and not exists (select 1 from public.tg_outreach_lead_forwards f where f.dialog_id = d.id)
  and not exists (select 1 from public.tg_outreach_crm_pushes c where c.dialog_id = d.id);
