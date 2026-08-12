-- gisSignalOutreach: legal-скоринг 0–100 (сегмент legal) + 2 скоринговых сигнала.
--
-- Два новых детектора в signals.ts гоняются для ВСЕХ сегментов (дешёвые проверки
-- по уже скачанным страницам), поэтому булевы колонки — NOT NULL DEFAULT false
-- для всех строк архива. score/grade — только у сегментов со скоринг-профилем
-- (legal); у edu/remont и остальных остаются NULL.
--
-- Профиль legal (scoring.ts): веса 25/10/10/20/15/10/5/5 (сумма 100),
-- threshold 35, грейды A=75–100, B=55–74, C=35–54; скор < 35 — отсев.

alter table public.gis_signal_company_signals
  add column if not exists signal_legal_relevance boolean not null default false, -- юридическая релевантность сайта
  add column if not exists signal_crm_calltracking boolean not null default false, -- CRM / коллтрекинг / речевая аналитика
  add column if not exists score integer,   -- взвешенный скор 0..100 (только scored-сегменты, напр. legal)
  add column if not exists grade text;      -- 'A' | 'B' | 'C'; NULL — сегмент без профиля или скор ниже порога

comment on column public.gis_signal_company_signals.signal_legal_relevance is
  'Скоринговый сигнал: сайт явно юридической тематики (signals.ts detectLegalRelevance).';
comment on column public.gis_signal_company_signals.signal_crm_calltracking is
  'Скоринговый сигнал: CRM / коллтрекинг / речевая аналитика на сайте (signals.ts detectCrmCalltracking).';
comment on column public.gis_signal_company_signals.score is
  'Взвешенный скор 0..100 по профилю сегмента (scoring.ts). NULL у сегментов без скоринг-профиля.';
comment on column public.gis_signal_company_signals.grade is
  'Грейд A/B/C по поясам профиля. NULL — сегмент без профиля или скор ниже threshold (отсев).';

-- Аналитический срез «legal × грейд/скор» для калибровки профиля.
create index if not exists idx_gis_signal_company_signals_score
  on public.gis_signal_company_signals(segment_key, score desc)
  where score is not null;
