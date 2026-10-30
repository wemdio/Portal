-- Публичные кейсы polzaagency.ru, проверены 30.10.2026 по запросу владельца.
-- Только библиотека: готовые письма, очереди, флаги ИИ и кампании не переписываются.
-- Числа относятся к указанным периодам и каналам, не обещают результат новому клиенту.
WITH source AS (
 SELECT * FROM jsonb_to_recordset($site_cases$
[
  {
    "case_id": "yuniant",
    "public_name": "Юниант",
    "industry_groups": [
      "auto_logistics"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 26,
    "case_text_short": "Для поставщика замороженных продуктов Юниант получили 26 лидов за 11 октября — 5 ноября 2024 года.",
    "case_text_en": "frozen food supplier Yuniant get 26 leads between 11 October and 5 November 2024",
    "case_segment_en": "food supply",
    "case_url": "https://polzaagency.ru/case-library/yuniant.html",
    "metrics": {
      "leads": 26,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "food_supply"
      ],
      "period": "2024-10-11/2024-11-05"
    },
    "notes": "Девять клиентов с отгрузками — отдельный отзыв от февраля 2024. Не приписывать их этому периоду и не складывать этапы."
  },
  {
    "case_id": "lifetrans",
    "public_name": "Лайфтранс",
    "industry_groups": [
      "auto_logistics"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 54,
    "case_text_short": "Для B2B-перевозчика Лайфтранс получили 54 лида за 12 мая — 15 июля 2026 года. В журнале клиента подтверждены два выполненных рейса.",
    "case_text_en": "B2B freight carrier Lifetrans get 54 leads between 12 May and 15 July 2026, with two completed shipments recorded by the client",
    "case_segment_en": "logistics services",
    "case_url": "https://polzaagency.ru/cases/lifetrans",
    "metrics": {
      "leads": 54,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "logistics_services"
      ],
      "period": "2026-05-12/2026-07-15"
    },
    "notes": "Показатель отчёта, не число продаж. Периоды не суммируются."
  },
  {
    "case_id": "videodoska",
    "public_name": "VideoDoska",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 33,
    "case_text_short": "Для VideoDoska, поставщика оборудования и ПО для видеолекций, получили 33 лида по отчёту за март — май 2026 года.",
    "case_text_en": "video recording equipment and software provider VideoDoska get 33 reported leads in March–May 2026",
    "case_segment_en": "media equipment",
    "case_url": "https://polzaagency.ru/case-library/videodoska.html",
    "metrics": {
      "leads": 33,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "media_equipment"
      ],
      "period": "2026-03/2026-05"
    },
    "notes": "Часть результата — контакты из CRM клиента. Не выдавать все 33 за новые компании из холодной базы."
  },
  {
    "case_id": "chizmol",
    "public_name": "Чизмол",
    "industry_groups": [
      "auto_logistics"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 111,
    "case_text_short": "Для поставщика пищевого сырья Чизмол получили 111 лидов из 9 482 контактов по накопительному отчёту на 17 июня 2026 года.",
    "case_text_en": "food ingredients supplier Chizmol get 111 reported leads from 9,482 contacts, as of 17 June 2026",
    "case_segment_en": "food supply",
    "case_url": "https://polzaagency.ru/cases/chizmol",
    "metrics": {
      "leads": 111,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "food_supply"
      ]
    },
    "notes": "Накопительный срез, срок всей кампании не установлен. Не обещать 111 лидов за месяц."
  },
  {
    "case_id": "vt_metall",
    "public_name": "VT Metall",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 27,
    "case_text_short": "Для контрактного производства VT Metall получили 27 лидов за 5 августа — 5 сентября 2024 года: запросы на изготовление деталей и корпусов из металла.",
    "case_text_en": "contract metal manufacturer VT Metall get 27 reported leads between 5 August and 5 September 2024",
    "case_segment_en": "metal manufacturing",
    "case_url": "https://polzaagency.ru/case-library/vt-metall.html",
    "metrics": {
      "leads": 27,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "metal_manufacturing"
      ],
      "period": "2024-08-05/2024-09-05"
    },
    "notes": "Показатель отчёта, не число продаж. Периоды не суммируются."
  },
  {
    "case_id": "deco_form",
    "public_name": "DECO FORM",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 19,
    "case_text_short": "Для интерьерных решений DECO FORM получили 19 лидов из 12 168 контактов по итоговому отчёту на 17 июля 2026 года.",
    "case_text_en": "interior products company DECO FORM get 19 reported leads from 12,168 contacts, as of 17 July 2026",
    "case_segment_en": "furniture interiors",
    "case_url": "https://polzaagency.ru/case-library/deco-form.html",
    "metrics": {
      "leads": 19,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "furniture_interiors"
      ]
    },
    "notes": "Дата итогового отчёта известна, начало периода не установлено. Запросы не выдавать за продажи."
  },
  {
    "case_id": "wyn_gifts",
    "public_name": "WYN Gifts",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 20,
    "case_text_short": "Для производителя корпоративных подарков WYN Gifts получили 20 основных и отдельно 8 потенциальных лидов по отчёту на 6 ноября 2025 года.",
    "case_text_en": "corporate gifts manufacturer WYN Gifts get 20 primary leads and, separately, 8 potential contacts, as of 6 November 2025",
    "case_segment_en": "corporate merch",
    "case_url": "https://polzaagency.ru/case-library/wyn-31.html",
    "metrics": {
      "leads": 20,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "corporate_merch"
      ]
    },
    "notes": "24 — взвешенный итог 20 + 8 × 0,5, не число людей или клиентов."
  },
  {
    "case_id": "webtronics",
    "public_name": "Webtronics",
    "industry_groups": [
      "digital_agency"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 13,
    "case_text_short": "Для SEO-команды Webtronics получили 13 целевых и отдельно 7 потенциальных лидов по итоговому отчёту на 30 января 2026 года.",
    "case_text_en": "SEO provider Webtronics get 13 target leads and, separately, 7 potential contacts, as of 30 January 2026",
    "case_segment_en": "marketing services",
    "case_url": "https://polzaagency.ru/case-library/webtronics.html",
    "metrics": {
      "leads": 13,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "marketing_services"
      ]
    },
    "notes": "16,5 — взвешенный итог. Не превращать потенциальные контакты в целевые лиды или продажи."
  },
  {
    "case_id": "akelon",
    "public_name": "Akelon",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 14,
    "case_text_short": "Для команды автоматизации бизнеса Akelon получили 14 лидов за 10 ноября 2025 — 13 апреля 2026 года.",
    "case_text_en": "business automation provider Akelon get 14 reported leads between 10 November 2025 and 13 April 2026",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/akelon.html",
    "metrics": {
      "leads": 14,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "workflow_software"
      ],
      "period": "2025-11-10/2026-04-13"
    },
    "notes": "Показатель отчёта, не число продаж. Периоды не суммируются."
  },
  {
    "case_id": "dpoprof",
    "public_name": "DPOPROF",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 16,
    "case_text_short": "Для профессионального обучения DPOPROF получили 16 лидов за 19 мая — 20 июля 2026 года.",
    "case_text_en": "professional training provider DPOPROF get 16 reported leads between 19 May and 20 July 2026",
    "case_segment_en": "education",
    "case_url": "https://polzaagency.ru/cases/dpoprof",
    "metrics": {
      "leads": 16,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "education"
      ],
      "period": "2026-05-19/2026-07-20"
    },
    "notes": "Показатель отчёта, не число продаж. Периоды не суммируются."
  },
  {
    "case_id": "jetstat",
    "public_name": "JetStat",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 15,
    "case_text_short": "Для сервиса маркетинговой отчётности JetStat в email-реестре за сентябрь 2025 — март 2026 зафиксированы 15 лидов и отдельно 5 потенциальных контактов.",
    "case_text_en": "marketing reporting platform JetStat get 15 recorded leads and, separately, 5 potential contacts through email outreach in September 2025–March 2026",
    "case_segment_en": "marketing analytics",
    "case_url": "https://polzaagency.ru/case-library/jetstat.html",
    "metrics": {
      "leads": 15,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "marketing_analytics"
      ],
      "period": "2025-09/2026-03"
    },
    "notes": "17,5 — взвешенный показатель. Часть контактов не ответила дальше; 15 не называть покупателями. Telegram и LeadScan не добавлены."
  },
  {
    "case_id": "vacation_fmf",
    "public_name": "Vacation FMF",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 12,
    "case_text_short": "Для сервиса планирования отпусков Vacation FMF получили 12 лидов за 29 июля — 28 октября 2024 года.",
    "case_text_en": "leave management platform Vacation FMF get 12 reported leads between 29 July and 28 October 2024",
    "case_segment_en": "hr software",
    "case_url": "https://polzaagency.ru/case-library/vacation-fmf.html",
    "metrics": {
      "leads": 12,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "hr_software"
      ],
      "period": "2024-07-29/2024-10-28"
    },
    "notes": "Показатель отчёта, не число продаж. Периоды не суммируются."
  },
  {
    "case_id": "mmvs",
    "public_name": "ММВС",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 13,
    "case_text_short": "Для команды разработки ПО ММВС зафиксированы 13 лидов по итогам обсуждения с клиентом 21 апреля 2025 года.",
    "case_text_en": "software development team MMVS get 13 recorded leads, as discussed with the client on 21 April 2025",
    "case_segment_en": "software development",
    "case_url": "https://polzaagency.ru/case-library/mmvs.html",
    "metrics": {
      "leads": 13,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "software_development"
      ]
    },
    "notes": "Период сбора не установлен. На итоговом звонке лиды оставались в обработке, продажи не подтверждены."
  },
  {
    "case_id": "qugo",
    "public_name": "Qugo",
    "industry_groups": [
      "hr_education"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 12,
    "case_text_short": "Для сервиса работы с исполнителями Qugo получили 12 лидов из 16 email-кампаний по итогам на 14 апреля 2025 года.",
    "case_text_en": "contractor management service Qugo get 12 reported leads across 16 email campaigns, as of 14 April 2025",
    "case_segment_en": "hr software",
    "case_url": "https://polzaagency.ru/case-library/b2b-qugo.html",
    "metrics": {
      "leads": 12,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "hr_software"
      ]
    },
    "notes": "Промежуточные 9,5 относятся к этому же периоду и повторно не прибавляются."
  },
  {
    "case_id": "fourdev",
    "public_name": "4dev",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic_abroad"
    ],
    "leads_count": 9,
    "case_text_short": "Для международного платёжного сервиса 4dev получили 9 лидов из 13 725 контактов в 24 email-кампаниях.",
    "case_text_en": "international payroll platform 4dev get 9 leads from 13,725 contacts across 24 email campaigns",
    "case_segment_en": "fintech payments",
    "case_url": "https://polzaagency.ru/cases/4dev",
    "metrics": {
      "leads": 9,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "fintech_payments"
      ]
    },
    "notes": "Карточка каталога показывает 10, подробный итог страницы — 9. Используется подробный итог 9; срок и продажи не заявляются."
  },
  {
    "case_id": "prodavai",
    "public_name": "ProdavAI",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 9,
    "case_text_short": "Для сервиса ИИ-агентов ProdavAI получили 9 основных и отдельно 13 потенциальных лидов по отчёту на 22 сентября 2025 года.",
    "case_text_en": "AI agents provider ProdavAI get 9 primary leads and, separately, 13 potential contacts, as of 22 September 2025",
    "case_segment_en": "ai agents",
    "case_url": "https://polzaagency.ru/case-library/prodavai.html",
    "metrics": {
      "leads": 9,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "ai_agents"
      ]
    },
    "notes": "15,5 — взвешенный итог, не число клиентов. Оплаченные продажи не установлены."
  },
  {
    "case_id": "reiki",
    "public_name": "Reiki",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 14,
    "case_text_short": "Для потолочных решений Reiki получили 14 лидов по отчёту за 5 июня — 5 июля 2024 года.",
    "case_text_en": "ceiling systems provider Reiki get 14 reported leads between 5 June and 5 July 2024",
    "case_segment_en": "construction materials",
    "case_url": "https://polzaagency.ru/case-library/reiki.html",
    "metrics": {
      "leads": 14,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "construction_materials"
      ],
      "period": "2024-06-05/2024-07-05"
    },
    "notes": "Показатель отчёта, не число продаж. Периоды не суммируются."
  },
  {
    "case_id": "goose_merch",
    "public_name": "GOOSE MERCH",
    "industry_groups": [
      "manufacturing"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 12,
    "case_text_short": "Для производителя корпоративного мерча GOOSE MERCH получили 12 лидов по отчёту за 1–28 апреля 2026 года.",
    "case_text_en": "corporate merchandise manufacturer GOOSE MERCH get 12 reported leads between 1 and 28 April 2026",
    "case_segment_en": "corporate merch",
    "case_url": "https://polzaagency.ru/case-library/goose-merch.html",
    "metrics": {
      "leads": 12,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "corporate_merch"
      ],
      "period": "2026-04-01/2026-04-28"
    },
    "notes": "В звонке 29 апреля — 13 лидов и 5 SQL. Здесь используется отчётный период с 12; SQL не продажи."
  },
  {
    "case_id": "csb_kontrol",
    "public_name": "ЦСБ Контроль",
    "industry_groups": [
      "it_saas"
    ],
    "allowed_chains": [
      "classic"
    ],
    "leads_count": 9,
    "case_text_short": "Для сервиса проверки контрагентов ЦСБ Контроль клиент подтвердил 9 квалифицированных лидов 4 августа 2025 года.",
    "case_text_en": "business verification service CSB Kontrol get 9 client-qualified leads, confirmed on 4 August 2025",
    "case_segment_en": "workflow software",
    "case_url": "https://polzaagency.ru/case-library/csb-kontrol.html",
    "metrics": {
      "leads": 9,
      "channels": [
        "email"
      ],
      "outreach_profiles": [
        "workflow_software"
      ]
    },
    "notes": "В отчёте за 27 мая — 30 июля 11 лидов, сумма строк 12. Используются 9, подтверждённые клиентом; год подтверждён текстом страницы."
  }
]
$site_cases$::jsonb) AS x(
 case_id text,public_name text,industry_groups text[],allowed_chains text[],leads_count integer,
 case_text_short text,case_text_en text,case_segment_en text,case_url text,metrics jsonb,notes text)
)
INSERT INTO public.polza_ru_cases
 (case_id,public_name,client_name_internal,industry_groups,allowed_chains,leads_count,
 case_text_short,case_text_long,case_text_en,case_segment_en,case_url,metrics,
 source_file_or_url,source_location,status,legal_publication_approved,verified_at,verified_by,notes)
SELECT case_id,public_name,public_name,industry_groups,allowed_chains,leads_count,
 case_text_short,case_text_short,case_text_en,case_segment_en,case_url,metrics,
 case_url,'Публичная страница: результат и оговорки; сверка 30.10.2026',
 'approved',true,now(),'Запрос владельца Polza от 30.10.2026',notes
FROM source
ON CONFLICT (case_id) DO NOTHING;

-- Разметка существующих записей не меняет их цифры, статус, разрешение или срок.
UPDATE public.polza_ru_cases c
SET metrics=(CASE WHEN jsonb_typeof(c.metrics)='object' THEN c.metrics
 WHEN c.metrics IS NULL THEN '{}'::jsonb
 ELSE jsonb_build_object('legacy_metrics',c.metrics) END)
 || jsonb_build_object('outreach_profiles',p.value),updated_at=now()
FROM jsonb_each($profiles$
{
  "3d_printer": [
    "industrial_equipment"
  ],
  "adk_trans": [
    "logistics_services"
  ],
  "appevent": [
    "event_software"
  ],
  "auto_marketing_saas_2026_q3": [
    "marketing_analytics"
  ],
  "beautylizer": [
    "beauty_equipment"
  ],
  "bero_pro": [
    "software_development"
  ],
  "bpmsoft": [
    "workflow_software"
  ],
  "bpmsoft_telecom": [
    "workflow_software"
  ],
  "brosto": [
    "marketing_services"
  ],
  "deaz": [
    "content_ai"
  ],
  "demis_group": [
    "marketing_services"
  ],
  "drink_and_eat": [
    "food_supply"
  ],
  "gate": [
    "marketing_services"
  ],
  "general_trading": [
    "industrial_equipment"
  ],
  "godigital": [
    "marketing_services"
  ],
  "hvoynyy_ostrov": [
    "seasonal_decor"
  ],
  "ift": [
    "logistics_services"
  ],
  "ink_agency": [
    "marketing_services"
  ],
  "inxy": [
    "fintech_payments"
  ],
  "kadry_online": [
    "hr_software",
    "hr_recruitment"
  ],
  "kitchen_no_more": [
    "food_supply"
  ],
  "kzsk": [
    "metal_manufacturing"
  ],
  "leonteona": [
    "lighting_supply"
  ],
  "magnumstroy": [
    "construction_materials"
  ],
  "markway": [
    "reputation"
  ],
  "moreland": [
    "food_supply"
  ],
  "nevidimka": [
    "reputation"
  ],
  "onescreen": [
    "marketing_analytics"
  ],
  "profit_gateway": [
    "fintech_payments"
  ],
  "prolog": [
    "warehouse_equipment"
  ],
  "rarematrix": [
    "reputation"
  ],
  "redcat": [
    "software_development"
  ],
  "reelscut": [
    "content_ai"
  ],
  "saas_service_management_email_outreach": [
    "workflow_software"
  ],
  "sental": [
    "hr_recruitment"
  ],
  "smartica": [
    "healthcare_ai"
  ],
  "soex_gfrc": [
    "construction_materials"
  ],
  "sokol_trade": [
    "industrial_equipment"
  ],
  "staffline": [
    "hr_recruitment"
  ],
  "startexam": [
    "hr_software"
  ],
  "stormbpmn": [
    "workflow_software"
  ],
  "twee": [
    "education"
  ],
  "uremont": [
    "fleet_software"
  ],
  "victory_group": [
    "marketing_services",
    "reputation"
  ],
  "x10_agency": [
    "marketing_services"
  ]
}
$profiles$::jsonb) p
WHERE c.case_id=p.key;
