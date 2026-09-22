-- Задержка между шагами цепочки в часах вместо целых дней: «написать через
-- 2 дня утром» днями не выражается, а follow-up чаще всего нужен через
-- несколько часов после первого письма.

alter table public.sender_campaign_steps
  add column delay_hours int not null default 0 check (delay_hours >= 0);

update public.sender_campaign_steps
   set delay_hours = delay_days * 24
 where delay_days > 0;

alter table public.sender_campaign_steps
  drop column delay_days;

comment on column public.sender_campaign_steps.delay_hours is
  'Delay from the previous step in hours (ignored for step 1); replaces the former delay_days int.';
