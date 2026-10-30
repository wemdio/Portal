-- Вторая партия публичных кейсов: полный каталог из 88 страниц, 30.10.2026.
-- Сохраняем формат и канал результата. Повторное применение не меняет исходные кейсы.
WITH source AS (
 SELECT * FROM jsonb_to_recordset($site_cases$
[
  {
    "case_id": "kira_pw",
    "public_name": "KIRA.PW",
    "client_name_internal": "KIRA.PW",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 32,
    "case_text_short": "Для B2B-платформы KIRA.PW по отчёту на 22 июня 2026 получили 32 лида; 9 регистраций учитывались отдельно.",
    "case_text_long": "Для B2B-платформы KIRA.PW по отчёту на 22 июня 2026 получили 32 лида; 9 регистраций учитывались отдельно.",
    "case_text_en": "For B2B platform KIRA.PW, the report recorded 32 leads by 22 June 2026; nine registrations were a separate stage.",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/kira.html",
    "metrics": {
      "outreach_profiles": [
        "workflow_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/kira.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Бесплатные регистрации не равны платящим клиентам."
  },
  {
    "case_id": "zhelezno",
    "public_name": "Железно",
    "client_name_internal": "Железно",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 2,
    "case_text_short": "Для патентного бюро «Железно» в клиентском учёте подтверждены два оплаченных статуса по разным запросам; суммы платежей неизвестны.",
    "case_text_long": "Для патентного бюро «Железно» в клиентском учёте подтверждены два оплаченных статуса по разным запросам; суммы платежей неизвестны.",
    "case_text_en": "For patent bureau Zhelezno, client records marked two separate requests as paid; payment amounts were not provided.",
    "case_segment_en": "legal services",
    "case_url": "https://polzaagency.ru/case-library/zhelezno.html",
    "metrics": {
      "outreach_profiles": [
        "legal_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/zhelezno.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "15,5 — взвешенный показатель другого отчёта. Оплаты не доказаны банковскими платежами."
  },
  {
    "case_id": "marafet",
    "public_name": "Марафет",
    "client_name_internal": "Марафет",
    "industry_groups": [
      "auto_logistics"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 9,
    "case_text_short": "Для B2B-пест-контроля «Марафет» email-отчёт за 11 марта — 27 мая 2026 показывает 9 лидов. В двух более ранних периодах клиент отдельно сообщил о 3 сделках на 76 000 ₽.",
    "case_text_long": "Для B2B-пест-контроля «Марафет» email-отчёт за 11 марта — 27 мая 2026 показывает 9 лидов. В двух более ранних периодах клиент отдельно сообщил о 3 сделках на 76 000 ₽.",
    "case_text_en": "For B2B pest-control provider Marafet, an email report recorded nine leads in March–May 2026; the client separately reported three deals worth RUB 76,000 in earlier periods.",
    "case_segment_en": "pest control",
    "case_url": "https://polzaagency.ru/cases/marafet",
    "metrics": {
      "outreach_profiles": [
        "pest_control"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/cases/marafet",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Два разных периода не складывать. Три сделки подтверждены итогами звонка, не банковскими поступлениями."
  },
  {
    "case_id": "belberry",
    "public_name": "Belberry",
    "client_name_internal": "Belberry",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 36,
    "case_text_short": "Для агентства маркетинга в медицине Belberry итоговый email-отчёт показывает 36 лидов из 20 055 контактов.",
    "case_text_long": "Для агентства маркетинга в медицине Belberry итоговый email-отчёт показывает 36 лидов из 20 055 контактов.",
    "case_text_en": "For healthcare marketing agency Belberry, the final email report recorded 36 leads from 20,055 contacts.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/belberry.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/belberry.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Год начала в заголовке отчёта ошибочен; большую часть лидов не удалось довести до встреч, оплат не подтверждено."
  },
  {
    "case_id": "publio",
    "public_name": "Publio",
    "client_name_internal": "Publio",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 35,
    "case_text_short": "Для рекламной сети Publio отчёт от 27 апреля фиксирует 35 переданных обращений от издателей разного качества.",
    "case_text_long": "Для рекламной сети Publio отчёт от 27 апреля фиксирует 35 переданных обращений от издателей разного качества.",
    "case_text_en": "For ad network Publio, a 27 April report listed 35 publisher enquiries of mixed quality.",
    "case_segment_en": "ad network",
    "case_url": "https://polzaagency.ru/case-library/andrey.html",
    "metrics": {
      "outreach_profiles": [
        "ad_network"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/andrey.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Сумма строк даёт 34, реестр 35. Нельзя называть 35 квалифицированными покупателями."
  },
  {
    "case_id": "darwin",
    "public_name": "Darwin",
    "client_name_internal": "Darwin",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 26,
    "case_text_short": "Для оптового поставщика мебели Darwin команда зафиксировала 26 целевых и отдельно 11 потенциальных обращений на 7 мая.",
    "case_text_long": "Для оптового поставщика мебели Darwin команда зафиксировала 26 целевых и отдельно 11 потенциальных обращений на 7 мая.",
    "case_text_en": "For furniture wholesaler Darwin, the team recorded 26 target and 11 separate potential enquiries as of 7 May.",
    "case_segment_en": "furniture interiors",
    "case_url": "https://polzaagency.ru/case-library/darwin.html",
    "metrics": {
      "outreach_profiles": [
        "furniture_interiors"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/darwin.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "31,5 — взвешенный итог. Оплаченные заказы не подтверждены."
  },
  {
    "case_id": "fitmost",
    "public_name": "Fitmost",
    "client_name_internal": "Fitmost",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 24,
    "case_text_short": "Для корпоративного направления Fitmost email-отчёт за 23 ноября — 23 декабря 2023 фиксирует 24 лида из 2 637 контактов.",
    "case_text_long": "Для корпоративного направления Fitmost email-отчёт за 23 ноября — 23 декабря 2023 фиксирует 24 лида из 2 637 контактов.",
    "case_text_en": "For corporate fitness service Fitmost, an email report recorded 24 leads from 2,637 contacts in November–December 2023.",
    "case_segment_en": "employee benefits",
    "case_url": "https://polzaagency.ru/case-library/fitmost.html",
    "metrics": {
      "outreach_profiles": [
        "employee_benefits"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/fitmost.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Среди лидов отложенный интерес и знакомые клиенты; запрос на встречу не доказывает проведённую встречу."
  },
  {
    "case_id": "ama_family",
    "public_name": "AMA Family",
    "client_name_internal": "AMA Family",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для платформы льгот AMA Family итоговый email-отчёт за 13 апреля — 1 июля 2026 показывает 20 взвешенных лидов; отдельно подтверждены три созвона и два отправленных после них КП.",
    "case_text_long": "Для платформы льгот AMA Family итоговый email-отчёт за 13 апреля — 1 июля 2026 показывает 20 взвешенных лидов; отдельно подтверждены три созвона и два отправленных после них КП.",
    "case_text_en": "For employee-benefits platform AMA Family, the email report showed 20 weighted leads in April–July 2026; three calls and two proposals after calls were recorded separately.",
    "case_segment_en": "employee benefits",
    "case_url": "https://polzaagency.ru/cases/ama-family",
    "metrics": {
      "outreach_profiles": [
        "employee_benefits"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/cases/ama-family",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "20 — взвешенная оценка, не число людей. Оплата не подтверждена."
  },
  {
    "case_id": "ponimayu",
    "public_name": "Понимаю",
    "client_name_internal": "Понимаю",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 20,
    "case_text_short": "Для платформы поддержки сотрудников «Понимаю» итоговый email-отчёт на 7 мая 2026 фиксирует 20 лидов; по одному обращению клиент подтвердил встречу и отправку КП.",
    "case_text_long": "Для платформы поддержки сотрудников «Понимаю» итоговый email-отчёт на 7 мая 2026 фиксирует 20 лидов; по одному обращению клиент подтвердил встречу и отправку КП.",
    "case_text_en": "For employee wellbeing platform Ponimayu, an email report recorded 20 leads by 7 May 2026; one client record confirms a meeting and proposal.",
    "case_segment_en": "employee benefits",
    "case_url": "https://polzaagency.ru/case-library/ponimayu.html",
    "metrics": {
      "outreach_profiles": [
        "employee_benefits"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/ponimayu.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Отчёт включает CRM и нерелевантные контакты; оплаченные сделки не подтверждены."
  },
  {
    "case_id": "ir_bis",
    "public_name": "Ир-Бис",
    "client_name_internal": "Ир-Бис",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для сервиса проверки контрагентов «Ир-Бис» после пересчёта на 22 июля зафиксировали 26,5 зачётного лида, включая три потенциальных с весом 0,5.",
    "case_text_long": "Для сервиса проверки контрагентов «Ир-Бис» после пересчёта на 22 июля зафиксировали 26,5 зачётного лида, включая три потенциальных с весом 0,5.",
    "case_text_en": "For business-verification service Ir-Bis, a recalculation on 22 July reported 26.5 weighted leads, including three potential contacts at half weight.",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/ir-bis.html",
    "metrics": {
      "outreach_profiles": [
        "workflow_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/ir-bis.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "30 в сводной таблице — другой показатель; 26,5 не число покупателей."
  },
  {
    "case_id": "marketing_analytics_service",
    "public_name": "Сервис сквозной аналитики",
    "client_name_internal": "Сервис сквозной аналитики",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 11,
    "case_text_short": "Для сервиса сквозной аналитики в email за 13 апреля — 15 июля 2026 получили 11 целевых и отдельно 4 потенциальных лида; ещё 2 целевых пришли из Лид-сканера.",
    "case_text_long": "Для сервиса сквозной аналитики в email за 13 апреля — 15 июля 2026 получили 11 целевых и отдельно 4 потенциальных лида; ещё 2 целевых пришли из Лид-сканера.",
    "case_text_en": "For a Russian marketing analytics service, email outreach recorded 11 target and four separate potential leads in April–July 2026; two other target leads came from a different channel.",
    "case_segment_en": "marketing analytics",
    "case_url": "https://polzaagency.ru/case-library/marketing-analytics-service.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_analytics"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/marketing-analytics-service.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Лид-сканер не входит в 11 email-лидов. Возможное тематическое пересечение с NDA-кейсом не подтверждает тождество клиентов."
  },
  {
    "case_id": "bonfire",
    "public_name": "Bonfire",
    "client_name_internal": "Bonfire",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 33,
    "case_text_short": "Для агентства email-маркетинга Bonfire сводка за 25 мая — 16 августа 2024 фиксирует 33 лида; промежуточные отчёты этого периода включены в итог.",
    "case_text_long": "Для агентства email-маркетинга Bonfire сводка за 25 мая — 16 августа 2024 фиксирует 33 лида; промежуточные отчёты этого периода включены в итог.",
    "case_text_en": "For email marketing agency Bonfire, the May–August 2024 summary reported 33 leads; interim reports were included in that total.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/bonfire.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/bonfire.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Последующие периоды не суммировать с этим результатом без сверки уникальности."
  },
  {
    "case_id": "fofvideo",
    "public_name": "FoFVideo",
    "client_name_internal": "FoFVideo",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 33,
    "case_text_short": "Для видеопродакшна FoFVideo через Telegram-аутрич получили 33 лида из 2 005 контактов по сообщению на 20 мая 2026.",
    "case_text_long": "Для видеопродакшна FoFVideo через Telegram-аутрич получили 33 лида из 2 005 контактов по сообщению на 20 мая 2026.",
    "case_text_en": "For video production company FoFVideo, Telegram outreach recorded 33 leads from 2,005 contacts by 20 May 2026.",
    "case_segment_en": "video production",
    "case_url": "https://polzaagency.ru/case-library/fofvideo.html",
    "metrics": {
      "outreach_profiles": [
        "video_production"
      ],
      "channels": [
        "telegram"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/fofvideo.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Это результат Telegram, не email. Выручка не заявлена."
  },
  {
    "case_id": "it_atlas",
    "public_name": "IT Atlas",
    "client_name_internal": "IT Atlas",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 12,
    "case_text_short": "Для подбора IT-специалистов IT Atlas ранний отчёт фиксирует 12 лидов; следующий этап с 26 октября — 14 ноября 2024 отдельно показывает 9.",
    "case_text_long": "Для подбора IT-специалистов IT Atlas ранний отчёт фиксирует 12 лидов; следующий этап с 26 октября — 14 ноября 2024 отдельно показывает 9.",
    "case_text_en": "For IT recruitment provider IT Atlas, one stage reported 12 leads; a separate October–November 2024 stage reported nine.",
    "case_segment_en": "hr recruitment",
    "case_url": "https://polzaagency.ru/case-library/it-atlas.html",
    "metrics": {
      "outreach_profiles": [
        "hr_recruitment"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/it-atlas.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Не складывать периоды без проверки уникальности обращений."
  },
  {
    "case_id": "hydromodul",
    "public_name": "Hydromodul",
    "client_name_internal": "Hydromodul",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 13,
    "case_text_short": "Для поставщика климатического оборудования Hydromodul итог на 15 апреля 2026 показывает 13 лидов, из них 12 — из двух тёплых гипотез.",
    "case_text_long": "Для поставщика климатического оборудования Hydromodul итог на 15 апреля 2026 показывает 13 лидов, из них 12 — из двух тёплых гипотез.",
    "case_text_en": "For HVAC supplier Hydromodul, the 15 April 2026 report listed 13 leads, 12 from two warm-list hypotheses.",
    "case_segment_en": "hvac equipment",
    "case_url": "https://polzaagency.ru/case-library/hydromodul.html",
    "metrics": {
      "outreach_profiles": [
        "hvac_equipment"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/hydromodul.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Не представлять 13 как результат только холодного email."
  },
  {
    "case_id": "profitsol",
    "public_name": "Profitsol",
    "client_name_internal": "Profitsol",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 13,
    "case_text_short": "Для услуг сопровождения 1С Profitsol через Telegram-аутрич получили 13 лидов из 2 139 контактов к 13 июля 2026.",
    "case_text_long": "Для услуг сопровождения 1С Profitsol через Telegram-аутрич получили 13 лидов из 2 139 контактов к 13 июля 2026.",
    "case_text_en": "For 1C support provider Profitsol, Telegram outreach recorded 13 leads from 2,139 contacts by 13 July 2026.",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/profitsol.html",
    "metrics": {
      "outreach_profiles": [
        "workflow_software"
      ],
      "channels": [
        "telegram"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/profitsol.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Это Telegram, не email; оплаты не подтверждены."
  },
  {
    "case_id": "alpha_capital",
    "public_name": "Альфа-Капитал",
    "client_name_internal": "Альфа-Капитал",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 13,
    "case_text_short": "Для корпоративного направления «Альфа-Капитал» итоговый email-отчёт от 17 июля 2026 фиксирует 13 лидов из 12 806 контактов.",
    "case_text_long": "Для корпоративного направления «Альфа-Капитал» итоговый email-отчёт от 17 июля 2026 фиксирует 13 лидов из 12 806 контактов.",
    "case_text_en": "For the corporate-finance offering of Alfa-Capital, a 17 July 2026 email report recorded 13 leads from 12,806 contacts.",
    "case_segment_en": "corporate finance",
    "case_url": "https://polzaagency.ru/case-library/alpha-capital.html",
    "metrics": {
      "outreach_profiles": [
        "corporate_finance"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/alpha-capital.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Не заявлять привлечённые инвестиции или доходность."
  },
  {
    "case_id": "mir_reklamy",
    "public_name": "Мир рекламы",
    "client_name_internal": "Мир рекламы",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 16,
    "case_text_short": "Для рекламного агентства «Мир рекламы» в основном реестре на 25 сентября зафиксированы 16 обращений и отдельно 2 потенциальных.",
    "case_text_long": "Для рекламного агентства «Мир рекламы» в основном реестре на 25 сентября зафиксированы 16 обращений и отдельно 2 потенциальных.",
    "case_text_en": "For advertising agency Mir Reklamy, the main register listed 16 enquiries and two separate potential contacts as of 25 September.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/mir-reklamy.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/mir-reklamy.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Статусы включают отказы и отсутствие ответа; 17 в отчёте — другой зачёт."
  },
  {
    "case_id": "axioom",
    "public_name": "Axioom",
    "client_name_internal": "Axioom",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 15,
    "case_text_short": "Для SEO- и веб-агентства Axioom в основном реестре за 20 января — 17 марта нашли 15 обращений, часть нерелевантна.",
    "case_text_long": "Для SEO- и веб-агентства Axioom в основном реестре за 20 января — 17 марта нашли 15 обращений, часть нерелевантна.",
    "case_text_en": "For SEO and web agency Axioom, the main register contained 15 enquiries in January–March, some irrelevant.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/axioom.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/axioom.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Это обращения, не 15 квалифицированных лидов; итог отчёта 14,5 взвешенных."
  },
  {
    "case_id": "hello_world_school",
    "public_name": "Hello World School",
    "client_name_internal": "Hello World School",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 16,
    "case_text_short": "Для корпоративного обучения Hello World School итоговый email-отчёт фиксирует 16 лидов из 11 664 контактов.",
    "case_text_long": "Для корпоративного обучения Hello World School итоговый email-отчёт фиксирует 16 лидов из 11 664 контактов.",
    "case_text_en": "For corporate education provider Hello World School, the final email report recorded 16 leads from 11,664 contacts.",
    "case_segment_en": "education",
    "case_url": "https://polzaagency.ru/case-library/hello-world-school.html",
    "metrics": {
      "outreach_profiles": [
        "education"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/hello-world-school.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Границы дат отчёта неоднозначны; длительность не заявлять."
  },
  {
    "case_id": "sands_studio",
    "public_name": "Sands Studio",
    "client_name_internal": "Sands Studio",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 16,
    "case_text_short": "Для студии брендинга Sands Studio итоговый email-отчёт на 29 декабря 2025 фиксирует 16 лидов, включая потенциальных.",
    "case_text_long": "Для студии брендинга Sands Studio итоговый email-отчёт на 29 декабря 2025 фиксирует 16 лидов, включая потенциальных.",
    "case_text_en": "For branding studio Sands Studio, the 29 December 2025 email report listed 16 leads including potential contacts.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/sands-studio.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/sands-studio.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "16 не число квалифицированных покупателей или продаж."
  },
  {
    "case_id": "d1_project",
    "public_name": "D1 Project",
    "client_name_internal": "D1 Project",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для мебельного производства D1 Project сводка одного направления показывает 25,5 зачётного лида из 12 000 контактов.",
    "case_text_long": "Для мебельного производства D1 Project сводка одного направления показывает 25,5 зачётного лида из 12 000 контактов.",
    "case_text_en": "For furniture manufacturer D1 Project, one campaign summary reported 25.5 weighted leads from 12,000 contacts.",
    "case_segment_en": "furniture interiors",
    "case_url": "https://polzaagency.ru/case-library/d1.html",
    "metrics": {
      "outreach_profiles": [
        "furniture_interiors"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/d1.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Отдельные сводки 14 и 23 не прибавлять; 25,5 не количество людей."
  },
  {
    "case_id": "umnye_novacii_public",
    "public_name": "Умные новации",
    "client_name_internal": "Умные новации",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 21,
    "case_text_short": "Для CRM Telecom 360 «Умные новации» отчёт на 24 июня показывает 21 лид; клиент на следующий день сообщил о 25, состав разницы не подтверждён.",
    "case_text_long": "Для CRM Telecom 360 «Умные новации» отчёт на 24 июня показывает 21 лид; клиент на следующий день сообщил о 25, состав разницы не подтверждён.",
    "case_text_en": "For telecom CRM provider Umnye Novacii, the 24 June report listed 21 leads; a later client note mentioned 25, with the difference unverified.",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/umnye-novacii.html",
    "metrics": {
      "outreach_profiles": [
        "workflow_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/umnye-novacii.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "В библиотеке есть отдельный черновик bpmsoft_telecom; его не переутверждать и не считать второй компанией."
  },
  {
    "case_id": "pervaya_forma",
    "public_name": "Первая Форма",
    "client_name_internal": "Первая Форма",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 11,
    "case_text_short": "Для автоматизации процессов «Первая Форма» email-отчёт за 6 февраля — 19 марта 2024 фиксирует 11 лидов; последующие периоды идут отдельно.",
    "case_text_long": "Для автоматизации процессов «Первая Форма» email-отчёт за 6 февраля — 19 марта 2024 фиксирует 11 лидов; последующие периоды идут отдельно.",
    "case_text_en": "For business automation provider Pervaya Forma, the February–March 2024 email report recorded 11 leads; later periods were reported separately.",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/pervaya-forma.html",
    "metrics": {
      "outreach_profiles": [
        "workflow_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/pervaya-forma.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Уникальность между периодами не проверена; контрактов не заявлять."
  },
  {
    "case_id": "newlight",
    "public_name": "НьюЛайт",
    "client_name_internal": "НьюЛайт",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 11,
    "case_text_short": "Для поставщика светодиодного освещения «НьюЛайт» тест WhatsApp-аутрича к 15 сентября 2023 дал 11 лидов при плане 5.",
    "case_text_long": "Для поставщика светодиодного освещения «НьюЛайт» тест WhatsApp-аутрича к 15 сентября 2023 дал 11 лидов при плане 5.",
    "case_text_en": "For LED supplier NewLight, a WhatsApp outreach test reported 11 leads against a target of five by 15 September 2023.",
    "case_segment_en": "lighting supply",
    "case_url": "https://polzaagency.ru/case-library/newlight.html",
    "metrics": {
      "outreach_profiles": [
        "lighting_supply"
      ],
      "channels": [
        "whatsapp"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/newlight.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Это WhatsApp, не email; оплаты не подтверждены."
  },
  {
    "case_id": "kredeks",
    "public_name": "Кредэкс",
    "client_name_internal": "Кредэкс",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для платёжного сервиса «Кредэкс» за 27 апреля — 22 июня в реестре зафиксировали 34 переданных контакта разного качества.",
    "case_text_long": "Для платёжного сервиса «Кредэкс» за 27 апреля — 22 июня в реестре зафиксировали 34 переданных контакта разного качества.",
    "case_text_en": "For payment provider Kredex, the April–June register contained 34 transferred contacts of mixed quality.",
    "case_segment_en": "fintech payments",
    "case_url": "https://polzaagency.ru/case-library/kredeks.html",
    "metrics": {
      "outreach_profiles": [
        "fintech_payments"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true,
      "cold_email": false
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/kredeks.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Не называть 34 квалифицированными лидами или покупателями; кампаниями суммируются 30."
  },
  {
    "case_id": "inex_partners",
    "public_name": "Inex Partners",
    "client_name_internal": "Inex Partners",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 12,
    "case_text_short": "Для корпоративного обучения Inex Partners сводка показывает 15 лидов, но строки кампаний дают 12; используем осторожный показатель 12 по строкам.",
    "case_text_long": "Для корпоративного обучения Inex Partners сводка показывает 15 лидов, но строки кампаний дают 12; используем осторожный показатель 12 по строкам.",
    "case_text_en": "For corporate training provider Inex Partners, the summary reported 15 leads, while campaign rows added up to 12; the latter is the conservative count.",
    "case_segment_en": "education",
    "case_url": "https://polzaagency.ru/case-library/inex-partners.html",
    "metrics": {
      "outreach_profiles": [
        "education"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/inex-partners.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "12/15 расхождение требует сверки; встречу по запросу Zoom не выдавать за состоявшуюся."
  },
  {
    "case_id": "ostropolskiy_maksim",
    "public_name": "Максим Остропольский",
    "client_name_internal": "Максим Остропольский",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 9,
    "case_text_short": "Для SEO-услуг Максима Остропольского команда сообщила о 13 обращениях, из них 9 целевых, к 19 декабря.",
    "case_text_long": "Для SEO-услуг Максима Остропольского команда сообщила о 13 обращениях, из них 9 целевых, к 19 декабря.",
    "case_text_en": "For SEO consultant Maksim Ostropolskiy, the team reported 13 enquiries, nine target, by 19 December.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/ostropolskiy-maksim.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/ostropolskiy-maksim.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "В другом отчёте 9,5 взвешенного; причина расхождения с 13 не объяснена."
  },
  {
    "case_id": "chatme_ai",
    "public_name": "Chatme.ai",
    "client_name_internal": "Chatme.ai",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 7,
    "case_text_short": "Для ИИ-автоматизации Chatme.ai команда на звонке 11 февраля 2026 выделила 7 целевых лидов из медицины; итоговый отчёт содержит 18,5 взвешенных по разным сегментам.",
    "case_text_long": "Для ИИ-автоматизации Chatme.ai команда на звонке 11 февраля 2026 выделила 7 целевых лидов из медицины; итоговый отчёт содержит 18,5 взвешенных по разным сегментам.",
    "case_text_en": "For healthcare AI provider Chatme.ai, a February 2026 client call identified seven target medical leads; a broader report showed 18.5 weighted leads across segments.",
    "case_segment_en": "healthcare ai",
    "case_url": "https://polzaagency.ru/case-library/chatme-ai.html",
    "metrics": {
      "outreach_profiles": [
        "healthcare_ai"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/chatme-ai.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "7 — медицинский сегмент; логистика оценена хуже. 18,5 не число покупателей."
  },
  {
    "case_id": "luna_target",
    "public_name": "Луна Таргет",
    "client_name_internal": "Луна Таргет",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 11,
    "case_text_short": "Для маркетинговых услуг «Луна Таргет» отчёт от 11 ноября 2024 фиксирует 11 зачётных лидов, из них 8 из IT-гипотез.",
    "case_text_long": "Для маркетинговых услуг «Луна Таргет» отчёт от 11 ноября 2024 фиксирует 11 зачётных лидов, из них 8 из IT-гипотез.",
    "case_text_en": "For marketing provider Luna Target, a November 2024 report listed 11 counted leads, eight from IT hypotheses.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/luna-target.html",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/luna-target.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Предыдущий отчёт относится к той же воронке; не суммировать. Оплат не заявлять."
  },
  {
    "case_id": "east_bridge_solutions",
    "public_name": "East Bridge Solutions",
    "client_name_internal": "East Bridge Solutions",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 5,
    "case_text_short": "Для поставщика промышленных комплектующих East Bridge Solutions email-отчёт на 15 июля 2025 показывает 5 основных и отдельно 15 потенциальных лидов.",
    "case_text_long": "Для поставщика промышленных комплектующих East Bridge Solutions email-отчёт на 15 июля 2025 показывает 5 основных и отдельно 15 потенциальных лидов.",
    "case_text_en": "For industrial parts supplier East Bridge Solutions, a July 2025 email report listed five primary and 15 separate potential leads.",
    "case_segment_en": "industrial equipment",
    "case_url": "https://polzaagency.ru/case-library/east-bridge-solutions.html",
    "metrics": {
      "outreach_profiles": [
        "industrial_equipment"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/east-bridge-solutions.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "12,5 — взвешенный итог, не число людей; поставки не подтверждены."
  },
  {
    "case_id": "youdo_business",
    "public_name": "YouDo Бизнес",
    "client_name_internal": "YouDo Бизнес",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для B2B-направления YouDo итоговый отчёт на 4 декабря 2025 показывает 26 взвешенных обращений; в реестре 20 основных и 12 потенциальных разного качества.",
    "case_text_long": "Для B2B-направления YouDo итоговый отчёт на 4 декабря 2025 показывает 26 взвешенных обращений; в реестре 20 основных и 12 потенциальных разного качества.",
    "case_text_en": "For the B2B offering of YouDo, a December 2025 report listed 26 weighted enquiries; the register contained 20 primary and 12 potential contacts of mixed quality.",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/youdo.html",
    "metrics": {
      "outreach_profiles": [
        "workflow_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true,
      "cold_email": false
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/youdo.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Вес 0,5 лишь вывод из совпадения цифр, правило прямо не подтверждено. Не называть 26 покупателями."
  },
  {
    "case_id": "mozart_for_kids",
    "public_name": "Mozart for kids",
    "client_name_internal": "Mozart for kids",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для программ детских мероприятий Mozart for kids отчёт указывает 62 лида; реестры показывают 52 основных и 16 потенциальных обращений, расхождение не разрешено.",
    "case_text_long": "Для программ детских мероприятий Mozart for kids отчёт указывает 62 лида; реестры показывают 52 основных и 16 потенциальных обращений, расхождение не разрешено.",
    "case_text_en": "For children’s education provider Mozart for kids, a report listed 62 leads; registers showed 52 primary and 16 potential contacts, with the discrepancy unresolved.",
    "case_segment_en": "education",
    "case_url": "https://polzaagency.ru/case-library/mozart.html",
    "metrics": {
      "outreach_profiles": [
        "education"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true,
      "cold_email": false
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/mozart.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "62 не выдавать за проверенное число квалифицированных лидов; описание использовать только с явной оговоркой."
  },
  {
    "case_id": "razvitie_kadrov",
    "public_name": "Развитие Кадров",
    "client_name_internal": "Развитие Кадров",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 11,
    "case_text_short": "Для B2B-юридических услуг «Развитие Кадров» итоговый email-отчёт фиксирует 11 лидов из 7 256 контактов; клиент сообщил, что в сделки они не перешли.",
    "case_text_long": "Для B2B-юридических услуг «Развитие Кадров» итоговый email-отчёт фиксирует 11 лидов из 7 256 контактов; клиент сообщил, что в сделки они не перешли.",
    "case_text_en": "For B2B legal provider Razvitie Kadrov, an email report recorded 11 leads from 7,256 contacts; the client said none became deals.",
    "case_segment_en": "legal services",
    "case_url": "https://polzaagency.ru/case-library/razvitie-kadrov.html",
    "metrics": {
      "outreach_profiles": [
        "legal_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true,
      "cold_email": false
    },
    "source_file_or_url": "https://polzaagency.ru/case-library/razvitie-kadrov.html",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Нельзя представлять как продажу; клиент указал нехватку бюджета у адресатов."
  },
  {
    "case_id": "profit_gateway_public",
    "public_name": "Profit-Gateway",
    "client_name_internal": "Profit-Gateway",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 78,
    "case_text_short": "Для сервиса международных платежей Profit-Gateway email-кампании дали 78 лидов; ещё 17 пришли через Telegram. На сайте отдельно указана одна оплаченная продажа.",
    "case_text_long": "Для сервиса международных платежей Profit-Gateway email-кампании дали 78 лидов; ещё 17 пришли через Telegram. На сайте отдельно указана одна оплаченная продажа.",
    "case_text_en": "For payments provider Profit-Gateway, email campaigns recorded 78 leads and Telegram another 17; the public case also reports one paid sale.",
    "case_segment_en": "fintech payments",
    "case_url": "https://polzaagency.ru/cases/profit-gateway",
    "metrics": {
      "outreach_profiles": [
        "fintech_payments"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/cases/profit-gateway",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "95 — общий итог двух каналов. Не выдавать все 95 за email."
  },
  {
    "case_id": "redcat_public",
    "public_name": "RedCat",
    "client_name_internal": "RedCat",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для команды разработки RedCat на сайте указаны 20,5 зачётного лида и одна оплаченная продажа за три месяца.",
    "case_text_long": "Для команды разработки RedCat на сайте указаны 20,5 зачётного лида и одна оплаченная продажа за три месяца.",
    "case_text_en": "For software developer RedCat, the public case reported 20.5 weighted leads and one paid sale over three months.",
    "case_segment_en": "software development",
    "case_url": "https://polzaagency.ru/cases/redcat",
    "metrics": {
      "outreach_profiles": [
        "software_development"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/cases/redcat",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "20,5 — взвешенный показатель, не число людей."
  },
  {
    "case_id": "kadry_online_public",
    "public_name": "Кадры Онлайн",
    "client_name_internal": "Кадры Онлайн",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для HR-платформы «Кадры Онлайн» тестировали выход на компании с IT-наймом; опубликованные цифры требуют отдельной сверки.",
    "case_text_long": "Для HR-платформы «Кадры Онлайн» тестировали выход на компании с IT-наймом; опубликованные цифры требуют отдельной сверки.",
    "case_text_en": "For HR platform Kadry Online, Polza tested outreach to companies hiring IT staff; published metrics need reconciliation.",
    "case_segment_en": "hr software",
    "case_url": "https://polzaagency.ru/cases/kadry-online",
    "metrics": {
      "outreach_profiles": [
        "hr_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": false,
      "public_project": true,
      "cold_email": false
    },
    "source_file_or_url": "https://polzaagency.ru/cases/kadry-online",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Числа сайта совпадают с другим кейсом StormBPMN; до исправления сайта результат нельзя цитировать."
  },
  {
    "case_id": "brosto_public",
    "public_name": "Brosto.pro",
    "client_name_internal": "Brosto.pro",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 16,
    "case_text_short": "Для SEO-агентства медицинских клиник Brosto.pro на сайте указаны 16 лидов за четыре месяца.",
    "case_text_long": "Для SEO-агентства медицинских клиник Brosto.pro на сайте указаны 16 лидов за четыре месяца.",
    "case_text_en": "For healthcare SEO agency Brosto.pro, the public case reports 16 leads over four months.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/cases/brosto",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/cases/brosto",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "2,5% ответов — ниже приведённой сайтом нормы; не выдавать за выдающуюся конверсию."
  },
  {
    "case_id": "appevent_public",
    "public_name": "AppEvent",
    "client_name_internal": "AppEvent",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 11,
    "case_text_short": "Для event-tech платформы AppEvent на сайте указаны 11 лидов за шесть месяцев; результат связан со спортивным сегментом.",
    "case_text_long": "Для event-tech платформы AppEvent на сайте указаны 11 лидов за шесть месяцев; результат связан со спортивным сегментом.",
    "case_text_en": "For event software provider AppEvent, the public case reports 11 leads over six months from a sports-related segment.",
    "case_segment_en": "event software",
    "case_url": "https://polzaagency.ru/cases/appevent",
    "metrics": {
      "outreach_profiles": [
        "event_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/cases/appevent",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Не приписывать 11 лидов целевым HR/event-менеджерам крупных компаний."
  },
  {
    "case_id": "stormbpmn_public",
    "public_name": "StormBPMN",
    "client_name_internal": "StormBPMN",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 0,
    "case_text_short": "Для SaaS моделирования процессов StormBPMN работали с бизнес-аналитиками; опубликованные цифры требуют отдельной сверки.",
    "case_text_long": "Для SaaS моделирования процессов StormBPMN работали с бизнес-аналитиками; опубликованные цифры требуют отдельной сверки.",
    "case_text_en": "For BPMN software provider StormBPMN, Polza reached business analysts; published metrics need reconciliation.",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/cases/stormbpmn",
    "metrics": {
      "outreach_profiles": [
        "workflow_software"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": false,
      "public_project": true,
      "cold_email": false
    },
    "source_file_or_url": "https://polzaagency.ru/cases/stormbpmn",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "Метрики совпадают с Кадры Онлайн и внутренне противоречивы; числовой результат не цитировать."
  },
  {
    "case_id": "x10_agency_public",
    "public_name": "X10 Agency",
    "client_name_internal": "X10 Agency",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 8,
    "case_text_short": "Для маркетингового агентства Web3 X10 Agency на сайте указаны 8 лидов из 419 контактов за месяц.",
    "case_text_long": "Для маркетингового агентства Web3 X10 Agency на сайте указаны 8 лидов из 419 контактов за месяц.",
    "case_text_en": "For Web3 marketing agency X10 Agency, the public case reports eight leads from 419 contacts over one month.",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/cases/x10-agency",
    "metrics": {
      "outreach_profiles": [
        "marketing_services"
      ],
      "channels": [
        "email"
      ],
      "cross_market_reference": true,
      "public_project": true
    },
    "source_file_or_url": "https://polzaagency.ru/cases/x10-agency",
    "source_location": "Публичная страница, сверка 30.10.2026",
    "status": "approved",
    "legal_publication_approved": true,
    "verified_by": "Запрос владельца Polza от 30.10.2026",
    "notes": "На странице встречается противоречивое число встреч; не цитировать его."
  }
]
$site_cases$::jsonb) AS x(
 case_id text,public_name text,client_name_internal text,industry_groups text[],allowed_chains text[],leads_count integer,
 case_text_short text,case_text_long text,case_text_en text,case_segment_en text,case_url text,metrics jsonb,
 source_file_or_url text,source_location text,status text,legal_publication_approved boolean,verified_by text,notes text)
)
INSERT INTO public.polza_ru_cases
 (case_id,public_name,client_name_internal,industry_groups,allowed_chains,leads_count,
 case_text_short,case_text_long,case_text_en,case_segment_en,case_url,metrics,
 source_file_or_url,source_location,status,legal_publication_approved,verified_at,verified_by,notes)
SELECT case_id,public_name,client_name_internal,industry_groups,allowed_chains,leads_count,
 case_text_short,case_text_long,case_text_en,case_segment_en,case_url,metrics,
 source_file_or_url,source_location,status,legal_publication_approved,now(),verified_by,notes FROM source
ON CONFLICT (case_id) DO NOTHING;

-- Ранее подготовленные 18 российских публичных кейсов тоже доступны как
-- географически маркированные примеры для английского разговора.
UPDATE public.polza_ru_cases
SET metrics=metrics || '{"cross_market_reference":true,"public_project":true}'::jsonb,
    updated_at=now()
WHERE case_id IN ('yuniant','lifetrans','videodoska','chizmol','vt_metall','deco_form','wyn_gifts','webtronics','akelon','dpoprof','jetstat','vacation_fmf','mmvs','qugo','prodavai','reiki','goose_merch','csb_kontrol');
