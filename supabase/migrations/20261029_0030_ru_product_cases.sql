-- Короткие кейсы в письмах и диалогах: решение владельца 29.10.2026.
-- SDR подтверждает достижение роли и ответ, не продажи SDR-услуги.
-- Канал исходных Smartway-кампаний — email; не приписывать им ручные звонки.

-- Общая прежняя библиотека — результаты классического аутрича.
update public.polza_ru_cases
set allowed_chains = array['classic']::text[], updated_at = now()
where cardinality(allowed_chains) = 0;

update public.polza_ru_cases
set allowed_chains = array['classic_abroad']::text[], updated_at = now()
where case_id in ('inxy', 'rarematrix')
  and allowed_chains = array['classic']::text[];

-- Сохраняем статус/апрув существующих кейсов; сокращаем только проверенные тексты.
update public.polza_ru_cases c
set case_text_short = v.copy, updated_at = now()
from (values
  ('bero_pro', 'для команды разработки Bero.pro получили 30 лидов за два месяца. Один из диалогов завершился сделкой на 10,8 млн ₽.'),
  ('adk_trans', 'для B2B-грузоперевозчика АДК Транс получили 179 лидов и 5 продаж за две волны email-аутрича.'),
  ('kzsk', 'для производителя металлоконструкций КЗСК получили 24 лида за 4 месяца.'),
  ('markway', 'для агентства управления репутацией Markway получили 27 лидов за 3,5 месяца.'),
  ('staffline', 'для рекрутингового агентства StaffLine получили 71 лид за 5 месяцев.'),
  ('sental', 'для IT-рекрутингового агентства Сентал получили 21 лид за 5 месяцев.'),
  ('drink_and_eat', 'для производителя съедобных стаканчиков Drink-and-eat получили 181 лид за 4 месяца.'),
  ('3d_printer', 'для поставщика 3D-принтеров для рекламных производств получили 26 лидов за 3 месяца.')
) as v(case_id, copy)
where c.case_id = v.case_id and c.status = 'approved' and c.legal_publication_approved;

insert into public.polza_ru_cases
  (case_id, public_name, client_name_internal, industry_groups, allowed_chains,
   case_text_short, leads_count, metrics, source_file_or_url, source_location,
   status, legal_publication_approved, verified_at, verified_by, notes)
values
  ('demis_group', 'Demis Group', 'Demis Group', '{digital_agency}', '{classic}',
   'для digital-агентства Demis Group получили 53 лида за 3 месяца.', 53,
   '{"evidence_type":"campaign_result","period_months":3}'::jsonb,
   'Polza_Agency_redesign_v43.pdf', 'Страница 29',
   'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Формулировка из предоставленного владельцем КП; без обещания повторить результат.'),
  ('auto_marketing_saas_2026_q3', 'SaaS для маркетинга под NDA', null, '{it_saas}', '{auto}',
   'для SaaS-сервиса в сфере маркетинга автоматизированные кампании дали 99 новых лидов за 3 месяца. Название клиента скрыто по NDA.', 99,
   '{"evidence_type":"campaign_result","period_months":3,"contacts":24280,"months":"2026-07/2026-09"}'::jsonb,
   'Polza_Auto_Outreach_RU_v5.pdf', 'Страница 11',
   'approved', true, now(), 'Dmitriy Kulaga — предоставленное КП 29.10.2026',
   'Обезличенный кейс из КП. Не раскрывать/угадывать клиента и не обещать такой же результат.')
on conflict (case_id) do nothing;

update public.polza_ru_cases set anonymization_required = true
where case_id = 'auto_marketing_saas_2026_q3';

-- Контакты людей (имена, телефоны, email) из журнала сюда не переносятся.
insert into public.polza_ru_cases
  (case_id, public_name, client_name_internal, industry_groups, allowed_chains,
   case_text_short, case_text_long, leads_count, metrics,
   source_file_or_url, source_location, status, legal_publication_approved,
   verified_at, verified_by, notes)
values
  ('sdr_smartway_eltex', 'Smartway Отпуск — ЭЛТЕКС', 'Smartway Отпуск', '{it_saas}', '{sdr}',
   'для Smartway Отпуск, сервиса тревел-бенефитов, вышли на менеджера по корпоративной культуре ЭЛТЕКС и провели встречу.',
   'Менеджер согласилась рассмотреть предложение. Встреча проведена; в журнале ожидали обратную связь руководителя. Продажа не подтверждена.',
   null, '{"evidence_type":"role_contact","cold_email":true,"outcome":"meeting_held"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=2080177137&range=C6:H6',
   'Лиды, строка 6', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Роль и исход сверены с журналом. Не называть директором и не добавлять выручку или штат.'),
  ('sdr_smartway_keaz', 'Smartway Отпуск — КЭАЗ', 'Smartway Отпуск', '{manufacturing}', '{sdr}',
   'для Smartway Отпуск вышли на начальника службы компенсаций и льгот КЭАЗ, предприятия с 2600+ специалистами. Получили запрос на подробности подключения.',
   'Попросили подробную информацию о сервисе с бонусами для работников промышленных предприятий на поездки в отпуск. Встреча и продажа не подтверждены.',
   null, '{"evidence_type":"role_contact","cold_email":true,"outcome":"details_requested","scale_source":"https://keaz.ru/","scale_checked_at":"2026-10-29"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=2080177137&range=C18:H18',
   'Лиды, строка 18; масштаб — keaz.ru', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   '2600+ специалистов подтверждает официальный сайт КЭАЗ. Не превращать запрос информации во встречу/сделку.'),
  ('sdr_smartway_sotex_nn', 'Smartway Отпуск — НПП СОТЕКС', 'Smartway Отпуск', '{manufacturing}', '{sdr}',
   'для Smartway Отпуск вышли на директора по персоналу НПП «СОТЕКС»: она согласилась на разговор; далее планировали согласование с руководством.',
   'Согласилась выслушать в конкретное время. Следующий шаг в комментарии — согласование с генеральным, коммерческим и финансовым директорами; факт сделки не установлен.',
   null, '{"evidence_type":"role_contact","cold_email":true,"outcome":"call_agreed","account_domain":"sotex-nn.ru"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=2080177137&range=C10:H10',
   'Лиды, строка 10', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Это НПП СОТЕКС, Нижний Новгород (sotex-nn.ru), не ФармФирма Сотекс (sotex.ru). Не использовать 1500+ сотрудников, чужую выручку или неподтверждённую встречу.'),
  ('sdr_smartway_avtodom', 'Smartway Отпуск — АВТОДОМ и АвтоСпецЦентр', 'Smartway Отпуск', '{auto_logistics}', '{sdr}',
   'для Smartway Отпуск вышли на PR-менеджера ГК АВТОДОМ и АвтоСпецЦентр: предложили обсудить программу для всего холдинга, но бюджеты года уже распределили.',
   'Предложили направить материалы и запланировать созвон для холдинга. В комментарии — ограничение бюджета; проведённая встреча и продажа не подтверждены.',
   null, '{"evidence_type":"role_contact","cold_email":false,"outcome":"budget_blocked"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=571906515&range=C7:H7',
   'Лиды 1 период, строка 7', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Для честного разбора опыта в диалоге. Не называть контакт HR-директором, не писать о состоявшейся встрече.'),
  ('sdr_smartway_relef', 'Smartway Отпуск — Рельеф-центр', 'Smartway Отпуск', '{manufacturing}', '{sdr}',
   'для Smartway Отпуск вышли на ведущего менеджера корпоративных проектов Рельеф-центра. После интереса к деталям компания отказалась из-за модели оплаты и бюджета.',
   'В комментарии журнала указано 1200 сотрудников. Заинтересованный первый ответ не завершился сотрудничеством: платный формат и бюджет не подошли.',
   null, '{"evidence_type":"role_contact","cold_email":false,"outcome":"budget_and_model_rejected"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=2080177137&range=C9:H9',
   'Лиды, строка 9', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Выход на роль, не кейс продажи. Отказ не скрывать в пересказе.'),
  ('sdr_smartway_starline', 'Smartway Отпуск — НПО StarLine', 'Smartway Отпуск', '{manufacturing}', '{sdr}',
   'для Smartway Отпуск вышли на и. о. директора по персоналу НПО StarLine. Бюджет уже сформировали, поэтому она предложила вернуться в январе.',
   'Ответ об отложенном контакте: внутренние бенефиты и бюджет года уже сформированы. Текущая потребность, встреча и сделка не подтверждены.',
   null, '{"evidence_type":"role_contact","cold_email":false,"outcome":"deferred_to_january"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=368288483&range=C3:H3',
   'Потенциальные лиды, строка 3', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Не выдавать отложенный контакт за активный интерес и не добавлять неподтверждённый штат.'),
  ('sdr_smartway_interrao', 'Smartway Отпуск — ИНТЕР РАО СЕРВИС', 'Smartway Отпуск', '{manufacturing}', '{sdr}',
   'для Smartway Отпуск вышли на руководителя направления мотивации и развития персонала ИНТЕР РАО СЕРВИС. Получили запрос презентации, но модель сотрудничества не подошла.',
   'Попросили контакты и презентацию, затем отказались от встречи из-за несовпадения модели. Численность группы Интер РАО нельзя приписывать этому юрлицу.',
   null, '{"evidence_type":"role_contact","cold_email":false,"outcome":"presentation_then_model_rejected"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=2080177137&range=C4:H4',
   'Лиды, строка 4', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Не писать про 60 тысяч сотрудников юрлица, состоявшуюся встречу или продажу.'),
  ('sdr_smartway_mmk', 'Smartway Отпуск — профсоюз группы ММК', 'Smartway Отпуск', '{manufacturing}', '{sdr}',
   'для Smartway Отпуск получили адресную переадресацию к сотруднику профсоюза группы ММК по предложениям и скидкам. Дальше интерес не подтвердился из-за действующих льгот.',
   'Точная переадресация и договорённость связаться позже. Встреча, роль ЛПР и продажа не подтверждены.',
   null, '{"evidence_type":"role_contact","cold_email":false,"outcome":"referral_only"}'::jsonb,
   'https://docs.google.com/spreadsheets/d/1QUROwdsdp0KA9VaRvYmB8pkcedI2w6KVmcSqQjHwUOQ/edit?gid=620831536&range=C3:H3',
   'Потенциальные лиды 1 период, строка 3', 'approved', true, now(), 'Dmitriy Kulaga — запрос 29.10.2026',
   'Только переадресация. Не называть руководителем или состоявшимся лидом/встречей.')
on conflict (case_id) do nothing;
