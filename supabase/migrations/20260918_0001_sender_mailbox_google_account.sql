-- Из какого Workspace пришёл ящик.
--
-- Каталогов Google может быть несколько (по админу на каждый Workspace), и на
-- экране нужно видеть, чей ящик. Заодно синхронизация по этой отметке решает,
-- чьи ящики можно пометить «Пропал»: если Google отказал одному аккаунту, его
-- ящики не должны разом стать пропавшими. У уже заведённых ящиков отметка
-- проставится на ближайшей синхронизации.
alter table public.sender_mailboxes
  add column if not exists google_account text;

comment on column public.sender_mailboxes.google_account is
  'Админ Workspace, из чьего каталога пришёл ящик (SENDER_GOOGLE_ADMIN_EMAIL). null — ящик не из каталога Google или ещё не синхронизирован.';
