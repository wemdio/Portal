-- Провайдер ящика больше не выбирается руками при загрузке файла: портал
-- определяет его сам (app/src/lib/sender/providerDetect.ts) — по хостам в
-- колонках выгрузки, по шапке выгрузки Google Workspace и, если файл промолчал,
-- по MX домена ящика.
--
-- Отсюда два изменения в наборе значений:
--   * добавился 'outlook' — ZapMail продаёт ящики и на Microsoft, раньше они
--     молча получали бы настройки Gmail и не прошли бы проверку входа;
--   * 'zapmail' перестал записываться (под ним всегда Google или Outlook, и
--     настройки те же), но остаётся разрешённым ради уже загруженных строк.
alter table public.sender_mailboxes
  drop constraint if exists sender_mailboxes_provider_check;

alter table public.sender_mailboxes
  add constraint sender_mailboxes_provider_check
  check (provider in ('maildoso', 'zapmail', 'google', 'outlook', 'custom'));
