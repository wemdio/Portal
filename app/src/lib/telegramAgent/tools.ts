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
];

export const ALL_TOOLS: ToolDefinition[] = [...AGENT_TOOLS, ...WRITE_TOOLS];

export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.function.name));

export const TOOL_NAMES = ALL_TOOLS.map((t) => t.function.name);
