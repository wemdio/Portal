-- Автоаутричи (RU и EN): персональная строка о компании в письме 1 (28.09.2026).
-- Письма шли одним текстом на всех компаний оффера — менялось только название.
-- Разбор сайта дешёвой моделью теперь пишет ещё одно предложение «что компания
-- продаёт и кому» (about_line), а английский — название, как на сайте
-- (brand_name: «Ambience Healthcare» вместо «ambiencehealthcare» из адреса
-- вакансии). Колонки нужны «Переписать цепочку»: она собирает письма из строки
-- журнала, без повторного разбора сайта.

alter table public.polza_outreach_companies
  add column if not exists brand_name text,
  add column if not exists about_line text;

alter table public.polza_ru_outreach_companies
  add column if not exists about_line text;
