-- «Проверять доставку»: ящик каждый день шлёт пробы на контрольные ящики,
-- даже если не стоит ни в одной рассылке (почты продаж: polza@polzaagency.ru,
-- julia@polzaagency.com). Холодных писем такой ящик не шлёт — только пробы.
alter table public.sender_mailboxes
  add column if not exists seed_watch boolean not null default false;

-- «Проверить доставку сейчас»: проба по кнопке, а не по дневному плану.
-- Уходит с любого проверенного ящика, папку смотрим через несколько минут.
alter table public.sender_seed_probes
  add column if not exists manual boolean not null default false;
