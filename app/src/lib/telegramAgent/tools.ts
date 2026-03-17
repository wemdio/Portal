import type { ToolDefinition } from './types';

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'get_projects',
      description: 'Получить список проектов с опциональными фильтрами по статусу, менеджеру, специалисту',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', description: 'Фильтр по статусу: В работе, Тестирование, На паузе, Подготовка, Завершен, Отменен' },
          manager: { type: 'string', description: 'Имя менеджера (частичное совпадение)' },
          specialist: { type: 'string', description: 'Имя специалиста (частичное совпадение)' },
          limit: { type: 'number', description: 'Макс. количество результатов (по умолчанию 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_project_detail',
      description: 'Получить полную информацию об одном проекте по ID или имени клиента',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'UUID проекта' },
          client: { type: 'string', description: 'Имя клиента (частичное совпадение)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_overdue_projects',
      description: 'Получить проекты с просроченным дедлайном (deadline < сегодня, статус не Завершен/Отменен)',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Макс. количество (по умолчанию 50)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_kpi_summary',
      description: 'Получить сводку KPI план/факт по проектам, сгруппированную по менеджеру или специалисту',
      parameters: {
        type: 'object',
        properties: {
          group_by: { type: 'string', enum: ['manager', 'specialist'], description: 'Группировать по менеджеру или специалисту' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_tasks',
      description: 'Получить список задач с фильтрами',
      parameters: {
        type: 'object',
        properties: {
          specialist: { type: 'string', description: 'Имя специалиста (частичное совпадение)' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'Статус задачи' },
          project_id: { type: 'string', description: 'UUID проекта' },
          limit: { type: 'number', description: 'Макс. количество (по умолчанию 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_task_board_summary',
      description: 'Получить сводку по доскам задач: количество задач в каждой колонке',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_parser_jobs',
      description: 'Получить список последних парсер-задач',
      parameters: {
        type: 'object',
        properties: {
          parser_type: { type: 'string', enum: ['hh', 'search', 'yandex_maps'], description: 'Тип парсера' },
          limit: { type: 'number', description: 'Макс. количество (по умолчанию 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_parser_results_summary',
      description: 'Получить сводку результатов конкретного парсера по ID задачи',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'UUID парсер-задачи' },
          parser_type: { type: 'string', enum: ['hh', 'search', 'yandex_maps'], description: 'Тип парсера' },
        },
        required: ['job_id', 'parser_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'export_parser_results',
      description: 'Экспортировать результаты парсера в CSV-файл и отправить пользователю. Не требует подтверждения.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'UUID парсер-задачи (обязательно)' },
          parser_type: { type: 'string', enum: ['hh', 'search', 'yandex_maps'], description: 'Тип парсера. Если не указан — определится автоматически' },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_instantly_campaigns',
      description: 'Получить список кампаний Instantly (email-аутрич)',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_review_requests',
      description: 'Получить список запросов на ревью баз данных',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['submitted', 'needs_rework', 'review_approved', 'sent_to_client', 'client_approved', 'client_requested_changes'],
            description: 'Фильтр по статусу ревью',
          },
          limit: { type: 'number', description: 'Макс. количество (по умолчанию 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_team_workload',
      description: 'Получить нагрузку команды: количество проектов, задач и просроченных по каждому специалисту/менеджеру',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_weekly_summary',
      description: 'Получить агрегированную сводку за последнюю неделю: новые проекты, завершённые, KPI, парсеры',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_pipeline_status',
      description: 'Получить статус пайплайна(ов). Без параметров — показать последние пайплайны текущего пользователя.',
      parameters: {
        type: 'object',
        properties: {
          pipeline_id: { type: 'string', description: 'UUID пайплайна' },
        },
      },
    },
  },
];

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'update_project_status',
      description: 'Изменить статус проекта. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ пользователя.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'UUID проекта' },
          new_status: { type: 'string', enum: ['В работе', 'Тестирование', 'На паузе', 'Подготовка', 'Завершен', 'Отменен'] },
        },
        required: ['project_id', 'new_status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_project_fields',
      description: 'Обновить поля проекта (менеджер, специалист, дедлайн, KPI, комментарии и др.). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          project_id: { type: 'string', description: 'UUID проекта' },
          manager: { type: 'string' },
          specialist: { type: 'string' },
          deadline: { type: 'string', description: 'Дата в формате YYYY-MM-DD' },
          kpi_plan: { type: 'string' },
          kpi_fact: { type: 'string' },
          budget: { type: 'string' },
          margin: { type: 'string' },
          comments: { type: 'string' },
          weekly_tasks: { type: 'string' },
          contacts_obligation: { type: 'string' },
          contacts_done: { type: 'string' },
        },
        required: ['project_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_project',
      description: 'Создать новый проект. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Название проекта (обязательно)' },
          client: { type: 'string', description: 'Клиент' },
          status: { type: 'string', enum: ['В работе', 'Тестирование', 'На паузе', 'Подготовка'], description: 'По умолчанию: Подготовка' },
          manager: { type: 'string' },
          specialist: { type: 'string' },
          deadline: { type: 'string', description: 'YYYY-MM-DD' },
          kpi_plan: { type: 'string' },
          budget: { type: 'string' },
          margin: { type: 'string' },
          comments: { type: 'string' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Создать новую задачу. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Название задачи (обязательно)' },
          specialist: { type: 'string' },
          project_id: { type: 'string', description: 'UUID проекта' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'], description: 'По умолчанию: pending' },
          deadline: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_status',
      description: 'Изменить статус задачи. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'UUID задачи' },
          new_status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
        },
        required: ['task_id', 'new_status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_task_fields',
      description: 'Обновить поля задачи (название, специалист, описание, результат, дедлайн). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'UUID задачи' },
          title: { type: 'string' },
          specialist: { type: 'string' },
          description: { type: 'string' },
          result: { type: 'string' },
          deadline: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['task_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'update_review_status',
      description: 'Изменить статус ревью базы данных. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ. Допустимые переходы: submitted→review_approved|needs_rework, needs_rework→submitted, review_approved→sent_to_client|needs_rework, sent_to_client→client_approved|client_requested_changes, client_requested_changes→submitted.',
      parameters: {
        type: 'object',
        properties: {
          review_id: { type: 'string', description: 'UUID ревью-запроса' },
          new_status: { type: 'string', enum: ['submitted', 'needs_rework', 'review_approved', 'sent_to_client', 'client_approved', 'client_requested_changes'] },
          comment: { type: 'string', description: 'Комментарий ревьюера' },
        },
        required: ['review_id', 'new_status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_hh_parser',
      description: 'Запустить парсер вакансий HeadHunter (hh.ru). Результаты появятся на портале у пользователя. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Поисковый запрос (обязательно). Пример: "Python разработчик", "менеджер по продажам"' },
          area: { type: 'string', description: 'Код региона HH (1=Москва, 2=Санкт-Петербург). Можно несколько через запятую' },
          salary_from: { type: 'number', description: 'Минимальная зарплата' },
          date_from: { type: 'string', description: 'Дата начала поиска (YYYY-MM-DD)' },
          date_to: { type: 'string', description: 'Дата окончания поиска (YYYY-MM-DD)' },
          fetch_employers: { type: 'boolean', description: 'Загружать детали работодателей (сайт, описание, индустрии). По умолчанию false — быстрее' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_search_parser',
      description: 'Запустить поисковый парсер (Google через Serper). Ищет сайты по запросам. Результаты появятся на портале. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          queries: { type: 'string', description: 'Поисковые запросы через перенос строки. Пример: "стоматологии Москва\\nклиники СПб"' },
          brief: { type: 'string', description: 'Описание целевой аудитории — система сгенерирует запросы автоматически' },
          search_depth: { type: 'number', description: 'Глубина поиска 1-10 (по умолчанию 5)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_yandex_maps_parser',
      description: 'Запустить парсер Яндекс.Карт. Собирает организации по поисковому URL. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          search_urls: { type: 'string', description: 'URL-ы поиска Яндекс.Карт через перенос строки (обязательно). Пример: "https://yandex.ru/maps/?text=стоматологии+москва"' },
          max_results: { type: 'number', description: 'Макс. организаций (по умолчанию 500, максимум 5000)' },
        },
        required: ['search_urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_email_search',
      description: 'Запустить поиск email-адресов по списку сайтов. Парсит страницы и извлекает контакты. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'string', description: 'Список URL сайтов через перенос строки (обязательно). Пример: "https://company1.ru\\nhttps://company2.ru"' },
        },
        required: ['urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_email_validation',
      description: 'Запустить валидацию email-адресов. Проверяет существование и доставляемость. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          emails: { type: 'string', description: 'Список email через перенос строки (обязательно). Пример: "info@company1.ru\\nsales@company2.ru"' },
        },
        required: ['emails'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_lpr_search',
      description: 'Найти ЛПР (лицо, принимающее решения) в компании. Использует Apollo + PDL. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Домен компании (например company.ru)' },
          company_name: { type: 'string', description: 'Название компании' },
          linkedin_url: { type: 'string', description: 'URL LinkedIn компании' },
          seniorities: { type: 'string', description: 'Уровни: owner,c_suite,vp,director,manager (через запятую)' },
          functions: { type: 'string', description: 'Отделы: sales,marketing,operations,finance,engineering,hr (через запятую)' },
          max_candidates: { type: 'number', description: 'Макс. кандидатов (по умолчанию 10)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_brief_scoring',
      description: 'Запустить оценку компаний под бриф (скоринг ЦА). Оценивает релевантность компаний для целевой аудитории. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          brief_text: { type: 'string', description: 'Описание целевой аудитории / бриф (обязательно)' },
          companies: { type: 'string', description: 'Названия компаний через перенос строки. Пример: "ООО Ромашка\\nАО Тюльпан"' },
        },
        required: ['brief_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clean_company_names',
      description: 'Очистить названия компаний в результатах парсера (убрать ООО, ИП, АО, GmbH, скобки, символы, привести к красивому виду). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'UUID парсер-задачи (обязательно)' },
          parser_type: { type: 'string', enum: ['hh', 'search', 'yandex_maps'], description: 'Тип парсера. Если не указан — определится автоматически' },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pipeline',
      description: 'Создать автоматический пайплайн из нескольких шагов (парсинг → обогащение → валидация → экспорт). Шаги выполняются последовательно, результаты передаются между ними, файл отправляется в чат. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Краткое название пайплайна' },
          steps: {
            type: 'array',
            description: 'Шаги пайплайна. Типы: parse_hh, parse_search, parse_yandex_maps, clean_names, enrich_emails, validate_emails, export. Export добавляется автоматически если не указан.',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['parse_hh', 'parse_search', 'parse_yandex_maps', 'clean_names', 'enrich_emails', 'validate_emails', 'export'],
                },
                config: {
                  type: 'object',
                  description: 'parse_hh: {text, area?, salary_from?, fetch_employers?}. parse_search: {queries?: string[], brief?}. parse_yandex_maps: {search_urls: string[]}. clean_names/enrich_emails/validate_emails/export: {} (данные из предыдущих шагов).',
                },
              },
              required: ['type'],
            },
          },
        },
        required: ['steps'],
      },
    },
  },
];

export const ALL_TOOLS: ToolDefinition[] = [...AGENT_TOOLS, ...WRITE_TOOLS];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.function.name));

export const TOOL_NAMES = ALL_TOOLS.map((t) => t.function.name);
