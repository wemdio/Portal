-- «Проверять доставку»: ящик каждый день шлёт пробы на контрольные ящики,
-- даже если не стоит ни в одной рассылке (почты продаж: polza@polzaagency.ru,
-- julia@polzaagency.com). Холодных писем такой ящик не шлёт — только пробы.
alter table public.sender_mailboxes
  add column if not exists seed_watch boolean not null default false;
