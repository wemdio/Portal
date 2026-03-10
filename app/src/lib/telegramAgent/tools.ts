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

export const TOOL_NAMES = AGENT_TOOLS.map((t) => t.function.name);
