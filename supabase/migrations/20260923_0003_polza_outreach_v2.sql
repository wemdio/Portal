-- Английский автоаутрич v2 (en-outreach-flow-improvements CEO, 23.09.2026):
-- компания → fit → поводы → данные → Lead Score → кейс → угол → цепочка.
--
-- polza_outreach_companies получает поля скоринга и персонализации. Строка
-- по-прежнему = компания в запуске; отсеянные остаются с причиной.
-- Библиотека кейсов общая с «Нашим автоаутричем»: у кейса появляется
-- английский текст, утверждение одно на оба языка.

alter table public.polza_outreach_companies
  add column if not exists source_list text[] not null default '{}',
  add column if not exists trigger_list jsonb not null default '[]'::jsonb,
  add column if not exists primary_trigger text,
  add column if not exists trigger_evidence_url text,
  add column if not exists trigger_phrase text,
  add column if not exists company_context text,
  add column if not exists likely_gtm_problem text,
  add column if not exists outreach_angle text,
  add column if not exists segments jsonb not null default '[]'::jsonb,
  add column if not exists employee_range text,
  add column if not exists industry text,
  add column if not exists country text,
  add column if not exists lead_score integer,
  add column if not exists score_breakdown jsonb,
  add column if not exists data_quality_score integer,
  add column if not exists lead_status text
    check (lead_status in ('write_now', 'manual_check', 'skip')),
  add column if not exists recommended_case text,
  add column if not exists case_reason text,
  add column if not exists case_snippet text,
  add column if not exists cta_type text;

alter table public.polza_ru_cases
  add column if not exists case_text_en text,
  add column if not exists case_segment_en text,
  add column if not exists case_url text;

-- Английские черновики тех же шести кейсов. Без имени клиента: для зарубежной
-- аудитории название российской компании ничего не говорит, а разрешение на
-- публикацию имени ещё не получено. Утверждение — вместе с русским текстом.
update public.polza_ru_cases set
  case_segment_en = 'B2B software',
  case_text_en = 'a CRM integrator selling to telecom operators get 240 replies, 25 MQLs and 21 SQLs from a validated base of 830 companies'
where case_id = 'bpmsoft_telecom' and case_text_en is null;

update public.polza_ru_cases set
  case_segment_en = 'industrial manufacturing',
  case_text_en = 'a steel structures manufacturer get 24 leads with a 13.6% reply rate'
where case_id = 'kkzsk' and case_text_en is null;

update public.polza_ru_cases set
  case_segment_en = 'service platform',
  case_text_en = 'a fleet maintenance platform get 28 qualified leads across 12 campaigns'
where case_id = 'uremont' and case_text_en is null;

update public.polza_ru_cases set
  case_segment_en = 'HoReCa supplier',
  case_text_en = 'an edible cup manufacturer get 87.5 qualified leads from cafes, restaurants and hotels in 2 months'
where case_id = 'drink_and_eat' and case_text_en is null;

update public.polza_ru_cases set
  case_segment_en = 'digital agency',
  case_text_en = 'a digital agency working with dental clinics and property developers get 54 leads'
where case_id = 'victory_group' and case_text_en is null;

update public.polza_ru_cases set
  case_segment_en = 'equipment distribution',
  case_text_en = 'a label printer and barcode scanner distributor get 10 leads in a month from resellers and integrators'
where case_id = 'compass_c' and case_text_en is null;
