-- TG Outreach: «Начать прогрев» падала с permission denied for table tg_outreach_warmup_runs.
--
-- 20260803_0006 выдала роли authenticated только select и завела единственную
-- политику — тоже на select. Но запуск прогрева заводит строку прогона
-- пользовательским клиентом, а не воркером:
--   POST /api/tools/tg-outreach/campaigns/[id]/warmup
--     insert into tg_outreach_warmup_runs ...            (создать прогон)
--     delete from tg_outreach_warmup_runs where id = ... (откат, если не встала job'а)
-- Ни гранта, ни RLS-политики на запись у authenticated не было, поэтому кнопка
-- не работала вообще ни разу с момента выката фичи.
--
-- Политики намеренно _all, а не _own, как select_all в 20260320_0003: прогрев —
-- командная операция, специалист должен уметь греть аккаунты кампании
-- независимо от того, кто её завёл. Воркер как ходил под service_role
-- (grant all в 20260803_0006), так и ходит — здесь только то, что нужно UI.

grant insert, update, delete on public.tg_outreach_warmup_runs to authenticated;

drop policy if exists tg_outreach_warmup_runs_insert_all on public.tg_outreach_warmup_runs;
create policy tg_outreach_warmup_runs_insert_all on public.tg_outreach_warmup_runs
  for insert to authenticated with check (true);

drop policy if exists tg_outreach_warmup_runs_update_all on public.tg_outreach_warmup_runs;
create policy tg_outreach_warmup_runs_update_all on public.tg_outreach_warmup_runs
  for update to authenticated using (true) with check (true);

drop policy if exists tg_outreach_warmup_runs_delete_all on public.tg_outreach_warmup_runs;
create policy tg_outreach_warmup_runs_delete_all on public.tg_outreach_warmup_runs
  for delete to authenticated using (true);
