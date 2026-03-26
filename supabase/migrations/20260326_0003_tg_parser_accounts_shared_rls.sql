-- TG Parser: аккаунты общие для всех авторизованных пользователей (user_id = кто добавил, не владелец)
-- Сохраняем user_id при UPDATE (аудит), RLS не привязывает строки к auth.uid().

drop policy if exists tg_parser_accounts_select_own on public.tg_parser_accounts;
drop policy if exists tg_parser_accounts_insert_own on public.tg_parser_accounts;
drop policy if exists tg_parser_accounts_update_own on public.tg_parser_accounts;
drop policy if exists tg_parser_accounts_delete_own on public.tg_parser_accounts;

create policy tg_parser_accounts_select_all on public.tg_parser_accounts
  for select to authenticated using (true);

create policy tg_parser_accounts_insert_self on public.tg_parser_accounts
  for insert to authenticated with check (user_id = auth.uid());

create policy tg_parser_accounts_update_all on public.tg_parser_accounts
  for update to authenticated using (true) with check (true);

create policy tg_parser_accounts_delete_all on public.tg_parser_accounts
  for delete to authenticated using (true);

create or replace function public.tg_parser_accounts_preserve_user_id()
returns trigger
language plpgsql
as $$
begin
  new.user_id := old.user_id;
  return new;
end;
$$;

drop trigger if exists tg_parser_accounts_preserve_user_id on public.tg_parser_accounts;
create trigger tg_parser_accounts_preserve_user_id
  before update on public.tg_parser_accounts
  for each row
  execute function public.tg_parser_accounts_preserve_user_id();

-- Старая таблица usage (если есть): доступ по любому аккаунту
drop policy if exists tg_parser_account_usage_select_own on public.tg_parser_account_usage;
drop policy if exists tg_parser_account_usage_insert_own on public.tg_parser_account_usage;
drop policy if exists tg_parser_account_usage_update_own on public.tg_parser_account_usage;

create policy tg_parser_account_usage_select_all on public.tg_parser_account_usage
  for select to authenticated using (true);
create policy tg_parser_account_usage_insert_all on public.tg_parser_account_usage
  for insert to authenticated with check (true);
create policy tg_parser_account_usage_update_all on public.tg_parser_account_usage
  for update to authenticated using (true) with check (true);
