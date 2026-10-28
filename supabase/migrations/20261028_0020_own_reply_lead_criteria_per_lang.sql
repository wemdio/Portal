-- «Что считать лидом» для наших кампаний Instantly — своё на каждый язык.
--
-- 27.10.2026 кампании «N. Polza_…» и «ENagency …» перевели на правило папки
-- автоаутрича того же языка (auto_ru / auto_en). 28.10.2026 пользователь решил
-- развести: у автоаутрича («Рассылка») и у наших кампаний Instantly — разные
-- правила, отдельно для RU и EN. Правила автоаутрича остаются в
-- sender_folders.lead_criteria, правила Instantly — здесь.
--
-- Старт — текущее правило папки того же языка: после выкладки квалификация
-- не меняется, пока правило не поправят на вкладке «Квалификация».
-- Колонка lead_criteria (общая, до 27.10) не читается с 27.10 и остаётся как есть.

alter table public.own_reply_lead_settings
  add column if not exists lead_criteria_ru text,
  add column if not exists lead_criteria_en text;

alter table public.own_reply_lead_settings
  drop constraint if exists own_reply_lead_settings_criteria_ru_len,
  drop constraint if exists own_reply_lead_settings_criteria_en_len;

alter table public.own_reply_lead_settings
  add constraint own_reply_lead_settings_criteria_ru_len
    check (lead_criteria_ru is null or char_length(lead_criteria_ru) <= 2000),
  add constraint own_reply_lead_settings_criteria_en_len
    check (lead_criteria_en is null or char_length(lead_criteria_en) <= 2000);

update public.own_reply_lead_settings s
   set lead_criteria_ru = coalesce(s.lead_criteria_ru, (select nullif(btrim(f.lead_criteria), '') from public.sender_folders f where f.key = 'auto_ru')),
       lead_criteria_en = coalesce(s.lead_criteria_en, (select nullif(btrim(f.lead_criteria), '') from public.sender_folders f where f.key = 'auto_en'))
 where s.id = 1;
