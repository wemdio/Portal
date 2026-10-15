-- Списки прокси TG-аутрича: «new row violates row-level security policy» при создании
-- (15.10.2026). Политики проверяли владельца кампании (user_id), а кампании и
-- остальные таблицы кампании общие (миграция 20260807_0004). Здесь — та же схема.

drop policy if exists tg_outreach_proxy_lists_select_own on public.tg_outreach_proxy_lists;
drop policy if exists tg_outreach_proxy_lists_insert_own on public.tg_outreach_proxy_lists;
drop policy if exists tg_outreach_proxy_lists_update_own on public.tg_outreach_proxy_lists;
drop policy if exists tg_outreach_proxy_lists_delete_own on public.tg_outreach_proxy_lists;

create policy tg_outreach_proxy_lists_select_all on public.tg_outreach_proxy_lists
  for select to authenticated using (true);
create policy tg_outreach_proxy_lists_insert_all on public.tg_outreach_proxy_lists
  for insert to authenticated with check (true);
create policy tg_outreach_proxy_lists_update_all on public.tg_outreach_proxy_lists
  for update to authenticated using (true) with check (true);
create policy tg_outreach_proxy_lists_delete_all on public.tg_outreach_proxy_lists
  for delete to authenticated using (true);
