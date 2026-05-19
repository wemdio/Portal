-- «Анализатор сейлз-переписок»: при удалении аккаунта выгруженные диалоги
-- и сообщения должны ОСТАВАТЬСЯ в базе (раньше каскадно удалялись).
--
-- Меняем FK account_id с ON DELETE CASCADE на ON DELETE SET NULL,
-- колонка становится nullable. Сам диалог/сообщение при этом сохраняется.

alter table public.sales_chat_dialogs
  drop constraint if exists sales_chat_dialogs_account_id_fkey;
alter table public.sales_chat_dialogs
  alter column account_id drop not null;
alter table public.sales_chat_dialogs
  add constraint sales_chat_dialogs_account_id_fkey
    foreign key (account_id) references public.sales_chat_accounts(id) on delete set null;

alter table public.sales_chat_messages
  drop constraint if exists sales_chat_messages_account_id_fkey;
alter table public.sales_chat_messages
  alter column account_id drop not null;
alter table public.sales_chat_messages
  add constraint sales_chat_messages_account_id_fkey
    foreign key (account_id) references public.sales_chat_accounts(id) on delete set null;
