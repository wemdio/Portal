-- Контрольные ящики «Рассылки»: вход через прокси. Яндекс пускает купленные
-- ящики только с российских адресов и по одному ящику на адрес, поэтому у
-- каждого ящика свой прокси. Сам прокси (с логином и паролем) — в
-- secret_encrypted вместе с паролем IMAP; здесь только «адрес:порт» для экрана.
alter table public.sender_seed_boxes
  add column if not exists proxy_label text;

-- Один прокси — один ящик.
create unique index if not exists uq_sender_seed_boxes_proxy_label
  on public.sender_seed_boxes (proxy_label)
  where proxy_label is not null;
