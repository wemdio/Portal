import type { ToolDefinition } from './types';

export const AGENT_TOOLS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'query_database',
      description: 'Выполнить SQL SELECT-запрос к базе данных портала. Только чтение. Максимум 200 строк. Используй для любых вопросов о проектах, задачах, парсерах, пользователях, статистике и т.д. Схема БД описана в системном промпте.',
      parameters: {
        type: 'object',
        properties: {
          sql: { type: 'string', description: 'SQL SELECT запрос. Пример: SELECT name, status, specialist FROM projects WHERE status = \'В работе\' ORDER BY created_at DESC LIMIT 10' },
        },
        required: ['sql'],
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
      name: 'search_knowledge_base',
      description: 'Поиск по базе знаний компании (продукт, кейсы, процессы, переписки, встречи). Используй когда пользователь спрашивает о компании, продукте, услугах, опыте или клиентах. Гибридный поиск: текст + семантика.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос на русском языке' },
          category: {
            type: 'string',
            enum: ['product_info', 'cases', 'sales_chats', 'video_transcripts', 'client_chats', 'other'],
            description: 'Фильтр по категории (необязательно). product_info=О продукте, cases=Кейсы, sales_chats=Переписки сейлзов, video_transcripts=Расшифровки встреч, client_chats=Чаты с клиентами',
          },
        },
        required: ['query'],
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
          client: { type: 'string' },
          status: { type: 'string', enum: ['В работе', 'Тестирование', 'На паузе', 'Подготовка'] },
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
          status: { type: 'string', enum: ['pending', 'in_progress', 'done'] },
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
      description: 'Обновить поля задачи. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
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
      description: 'Изменить статус ревью базы данных. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ. Допустимые переходы: submitted→review_approved|needs_rework, review_approved→sent_to_client|needs_rework, sent_to_client→client_approved|client_requested_changes.',
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
      description: 'Запустить парсер вакансий HeadHunter (hh.ru). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Поисковый запрос (обязательно)' },
          area: { type: 'string', description: 'Код региона HH (1=Москва, 2=СПб)' },
          salary_from: { type: 'number', description: 'Минимальная зарплата' },
          date_from: { type: 'string', description: 'YYYY-MM-DD' },
          date_to: { type: 'string', description: 'YYYY-MM-DD' },
          fetch_employers: { type: 'boolean', description: 'Загружать детали работодателей' },
        },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_search_parser',
      description: 'Запустить поисковый парсер (Google через Serper). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          queries: { type: 'string', description: 'Поисковые запросы через перенос строки' },
          brief: { type: 'string', description: 'Описание ЦА — система сгенерирует запросы' },
          search_depth: { type: 'number', description: 'Глубина поиска 1-10' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_yandex_maps_parser',
      description: 'Запустить парсер Яндекс.Карт. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          search_urls: { type: 'string', description: 'URL-ы поиска Яндекс.Карт через перенос строки' },
          max_results: { type: 'number', description: 'Макс. организаций (по умолчанию 500)' },
        },
        required: ['search_urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_email_search',
      description: 'Запустить поиск email по списку сайтов. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          urls: { type: 'string', description: 'URL сайтов через перенос строки' },
        },
        required: ['urls'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_email_validation',
      description: 'Валидировать email-адреса. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          emails: { type: 'string', description: 'Email через перенос строки' },
        },
        required: ['emails'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_lpr_search',
      description: 'Найти ЛПР в компании (Apollo + PDL). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          domain: { type: 'string', description: 'Домен компании' },
          company_name: { type: 'string' },
          linkedin_url: { type: 'string' },
          seniorities: { type: 'string', description: 'owner,c_suite,vp,director,manager' },
          functions: { type: 'string', description: 'sales,marketing,operations,finance' },
          max_candidates: { type: 'number' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'launch_brief_scoring',
      description: 'Оценить компании под бриф (скоринг ЦА). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          brief_text: { type: 'string', description: 'Описание ЦА / бриф (обязательно)' },
          companies: { type: 'string', description: 'Названия компаний через перенос строки' },
        },
        required: ['brief_text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clean_company_names',
      description: 'Очистить названия компаний в парсере (убрать ООО, ИП, скобки). ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'UUID парсер-задачи' },
          parser_type: { type: 'string', enum: ['hh', 'search', 'yandex_maps'] },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'deduplicate_results',
      description: 'Убрать дубликаты в парсере по email или сайту. Может удалить строки без значения. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'UUID парсер-задачи' },
          field: { type: 'string', enum: ['email', 'site'] },
          remove_empty: { type: 'boolean', description: 'Удалить строки с пустым полем' },
          parser_type: { type: 'string', enum: ['hh', 'search', 'yandex_maps'] },
        },
        required: ['job_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_pipeline',
      description: 'Создать пайплайн: парсинг → очистка → обогащение → валидация → дедупликация → экспорт. ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Название пайплайна' },
          steps: {
            type: 'array',
            description: 'Шаги. Типы: parse_hh, parse_search, parse_yandex_maps, clean_names, enrich_emails, validate_emails, deduplicate, export.',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['parse_hh', 'parse_search', 'parse_yandex_maps', 'clean_names', 'enrich_emails', 'validate_emails', 'deduplicate', 'export'],
                },
                config: { type: 'object', description: 'Конфиг шага. parse_hh: {text, area?}. parse_search: {queries?, brief?}. parse_yandex_maps: {search_urls}. Остальные: {}.' },
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
