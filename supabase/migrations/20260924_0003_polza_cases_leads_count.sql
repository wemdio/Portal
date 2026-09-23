-- «Наш автоаутрич»: в письма берём только кейсы, где лидов от 8 (решение 24.09.2026).
--
-- Число лидов раньше жило только внутри текста кейса («26 лидов при 15,1%
-- ответов»), отбирать по нему было нечем. Теперь это отдельное поле; для 42
-- кейсов с polzaagency.ru/cases оно заполнено по их текстам. Особые случаи:
-- Moreland — «13 B2B-лидов»; SaaS техподдержки — «49+ лидов в месяц» (49);
-- BPMSoft — 3 регистрации на вебинар, лидов нет (0); RedCat — «20,5 лида» (20).
-- Кейс без числа лидов (null) в письма не идёт.

alter table public.polza_ru_cases
  add column if not exists leads_count integer check (leads_count is null or leads_count >= 0);

comment on column public.polza_ru_cases.leads_count is
  'Сколько лидов дал кейс. В письма русского автоаутрича идут только кейсы с leads_count >= 8.';

update public.polza_ru_cases c
   set leads_count = v.leads, updated_at = now()
  from (values
    ('3d_printer', 26),
    ('adk_trans', 179),
    ('appevent', 11),
    ('beautylizer', 75),
    ('bero_pro', 30),
    ('bpmsoft', 0),
    ('brosto', 16),
    ('deaz', 13),
    ('drink_and_eat', 181),
    ('gate', 8),
    ('general_trading', 5),
    ('godigital', 6),
    ('hvoynyy_ostrov', 9),
    ('ift', 10),
    ('ink_agency', 5),
    ('inxy', 9),
    ('kadry_online', 21),
    ('kitchen_no_more', 3),
    ('kzsk', 24),
    ('leonteona', 41),
    ('magnumstroy', 26),
    ('markway', 27),
    ('moreland', 13),
    ('nevidimka', 23),
    ('onescreen', 13),
    ('profit_gateway', 95),
    ('prolog', 8),
    ('rarematrix', 34),
    ('redcat', 20),
    ('reelscut', 17),
    ('saas_service_management_email_outreach', 49),
    ('sental', 21),
    ('smartica', 39),
    ('soex_gfrc', 24),
    ('sokol_trade', 40),
    ('staffline', 71),
    ('startexam', 4),
    ('stormbpmn', 8),
    ('twee', 17),
    ('uremont', 28),
    ('victory_group', 54),
    ('x10_agency', 8)
  ) as v(case_id, leads)
 where c.case_id = v.case_id
   and c.leads_count is null;
