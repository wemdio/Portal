-- gisSignalOutreach: сегмент medicine — 4 новых скоринговых сигнала + seed.
--
-- Как и legal/accounting/consulting, новые детекторы гоняются для ВСЕХ
-- сегментов: это дешёвый матчинг по уже скачанным страницам, а архив за счёт
-- этого копит сопоставимый срез по всем нишам. В signalsCount они НЕ входят,
-- поэтому фильтр edu/remont по signal_min_count не меняется.
--
-- Колонки NOT NULL DEFAULT false — у всех уже накопленных строк архива сигнал
-- считается несработавшим: назад мы сайты не переспрашиваем.
--
-- Профиль (scoring.ts), сумма весов = 100, threshold 35, грейды A=75+/B=55+/C=35+:
--   medicine: medicineRelevance 20, medicinePromo 20, medicinePremium 15,
--             contactForm 10, generalPhone 10, multiOffice 10,
--             crmCalltracking 10, medicineMarketingTeam 5
--
-- Кампания Instantly (22.08.2026):
--   «Roistat - Медицина - Автоаутрич - Сквозная аналитика»
--   569b8189-7123-46db-a366-df4b87656c6f
-- Сегмент включается сразу: без кампании лиды некуда было лить.
--
-- quota_weight на шесть ниш — равные рабочие дни от остатка пула на 22.08.2026
-- (pool с сайтом минус seen; medicine ≈36.5k с сайтом при 52 966 карточках
-- рубрик, уникальный COUNT с has_website на проде упёрся в timeout).
-- daily_limit 2000 не меняем. Старые ниши замедляются.

alter table public.gis_signal_company_signals
  add column if not exists signal_medicine_relevance boolean not null default false, -- частная клиника / медцентр / сеть
  add column if not exists signal_medicine_promo boolean not null default false,     -- акции, посадочные, спецпредложения
  add column if not exists signal_medicine_premium boolean not null default false,   -- имплантация / хирургия / диагностика
  add column if not exists signal_medicine_marketing_team boolean not null default false; -- маркетолог / performance / агентство

comment on column public.gis_signal_company_signals.signal_medicine_relevance is
  'Скоринговый сигнал: частная клиника / медцентр / сеть клиник (signals.ts detectMedicineRelevance). ГБУЗ, аптеки, продажа медоборудования и кабинет врача отсекаются стоп-листом MEDICINE_NEGATIVE_RE.';
comment on column public.gis_signal_company_signals.signal_medicine_promo is
  'Скоринговый сигнал: акции, спецпредложения, посадочные страницы, реклама (signals.ts detectMedicinePromo).';
comment on column public.gis_signal_company_signals.signal_medicine_premium is
  'Скоринговый сигнал: имплантация, хирургия, диагностика, программы лечения, косметология, стоматология (signals.ts detectMedicinePremium).';
comment on column public.gis_signal_company_signals.signal_medicine_marketing_team is
  'Скоринговый сигнал: вакансия маркетолога / performance, руководитель маркетинга, агентство (signals.ts detectMedicineMarketingTeam).';

insert into public.gis_signal_segments
  (key, label, instantly_campaign_id, priority, require_online, enabled, quota_weight, rubric_groups)
values
('medicine', 'Медицина', '569b8189-7123-46db-a366-df4b87656c6f', 60, false, true, 540, '[
  {"category":"Медицина / Здоровье / Красота","includedSubcategories":[
    "Частные стоматологии",
    "Частные детские стоматологии",
    "Многопрофильные медицинские центры",
    "Медицинская диагностика",
    "Медицинские анализы",
    "Пластическая хирургия",
    "Микрохирургия глаза",
    "Проведение хирургических операций",
    "Диализные центры",
    "Медицинское лечение зависимостей"
  ],"excludedSubcategories":[]}
]'::jsonb)
on conflict (key) do update set
  instantly_campaign_id = excluded.instantly_campaign_id,
  label = excluded.label,
  rubric_groups = excluded.rubric_groups,
  priority = excluded.priority,
  require_online = excluded.require_online,
  enabled = excluded.enabled,
  quota_weight = excluded.quota_weight;

-- Равные дни: edu 286, remont 787, legal 263, accounting 74, consulting 50, medicine 540.
update public.gis_signal_segments s
set quota_weight = v.w
from (values
  ('edu', 286),
  ('remont', 787),
  ('legal', 263),
  ('accounting', 74),
  ('consulting', 50),
  ('medicine', 540)
) as v(key, w)
where s.key = v.key;
