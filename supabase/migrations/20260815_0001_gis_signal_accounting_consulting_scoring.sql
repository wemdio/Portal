-- gisSignalOutreach: сегменты accounting/consulting — 4 новых скоринговых сигнала.
--
-- Как и legal-сигналы (миграция 20260811_0003), новые детекторы гоняются для ВСЕХ
-- сегментов: это дешёвый матчинг по уже скачанным страницам, а архив за счёт этого
-- копит сопоставимый срез по всем нишам. В signalsCount они НЕ входят, поэтому
-- фильтр edu/remont по signal_min_count не меняется.
--
-- Колонки NOT NULL DEFAULT false — у всех уже накопленных строк архива (14k+ на
-- 15.08.2026) сигнал считается несработавшим: назад мы сайты не переспрашиваем.
--
-- Профили (scoring.ts), сумма весов = 100, threshold 35, грейды A=75+/B=55+/C=35+:
--   accounting:  accountingRelevance 25, generalPhone 10, contactForm 10,
--                salesDept 20, targetVacancy 10, pricingPackages 10,
--                highVolume 5, clientSegments 5, crmCalltracking 5
--   consulting:  consultingRelevance 25, generalPhone 10, contactForm 10,
--                salesDept 20, targetVacancy 15, highVolume 10,
--                multiOffice 5, crmCalltracking 5

alter table public.gis_signal_company_signals
  add column if not exists signal_accounting_relevance boolean not null default false, -- бухуслуги / аутсорсинг учёта / налоговое сопровождение
  add column if not exists signal_consulting_relevance boolean not null default false, -- управленческий / финансовый / HR / IT / операционный консалтинг
  add column if not exists signal_pricing_packages boolean not null default false,     -- калькулятор стоимости, тарифы, пакеты обслуживания
  add column if not exists signal_client_segments boolean not null default false;      -- работа с несколькими формами бизнеса (ИП, ООО, МСБ)

comment on column public.gis_signal_company_signals.signal_accounting_relevance is
  'Скоринговый сигнал: компания оказывает бухгалтерские услуги (signals.ts detectAccountingRelevance). Сайты бухгалтерских ПРОГРАММ и КУРСОВ отсекаются стоп-листом ACCOUNTING_NEGATIVE_RE.';
comment on column public.gis_signal_company_signals.signal_consulting_relevance is
  'Скоринговый сигнал: компания оказывает консалтинговые услуги (signals.ts detectConsultingRelevance). Голое «консультация» как CTA сигналом не считается.';
comment on column public.gis_signal_company_signals.signal_pricing_packages is
  'Скоринговый сигнал: услуга упакована — калькулятор стоимости, тарифы, пакеты обслуживания, абонентка (signals.ts detectPricingPackages).';
comment on column public.gis_signal_company_signals.signal_client_segments is
  'Скоринговый сигнал: компания открыто работает с несколькими формами бизнеса — ИП, ООО, МСБ (signals.ts detectClientSegments).';
