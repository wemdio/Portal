/** @jest-environment node */

function createMockQuery(result: { data: unknown; error: unknown } = { data: null, error: null }) {
  const query: Record<string, unknown> = {};

  const chainFn = () => query;
  query.select = jest.fn(chainFn);
  query.eq = jest.fn(chainFn);
  query.ilike = jest.fn(chainFn);
  query.lt = jest.fn(chainFn);
  query.not = jest.fn(chainFn);
  query.in = jest.fn(chainFn);
  query.gte = jest.fn(chainFn);
  query.order = jest.fn(chainFn);
  query.limit = jest.fn(chainFn);
  query.maybeSingle = jest.fn(() => Promise.resolve(result));
  query.single = jest.fn(() => Promise.resolve(result));
  query.then = (resolve: (v: unknown) => void) => { resolve(result); };

  return query;
}

const mockFrom = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));

import { toolHandlers } from '@/lib/telegramAgent/handlers';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('telegramAgent/handlers', () => {
  describe('get_projects', () => {
    it('returns formatted projects', async () => {
      const projects = [{ id: '1', client: 'Альфа', name: 'Проект 1', status: 'В работе' }];
      mockFrom.mockReturnValue(createMockQuery({ data: projects, error: null }));

      const result = await toolHandlers.get_projects({});
      expect(mockFrom).toHaveBeenCalledWith('projects');
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
      expect(parsed[0].client).toBe('Альфа');
    });

    it('returns message when no projects found', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: [], error: null }));
      const result = await toolHandlers.get_projects({});
      expect(result).toBe('Проекты не найдены.');
    });

    it('applies status filter', async () => {
      const q = createMockQuery({ data: [{ id: '1', status: 'На паузе' }], error: null });
      mockFrom.mockReturnValue(q);
      await toolHandlers.get_projects({ status: 'На паузе' });
      expect(q.eq).toHaveBeenCalledWith('status', 'На паузе');
    });

    it('applies manager filter with ilike', async () => {
      const q = createMockQuery({ data: [{ id: '1', manager: 'Аня' }], error: null });
      mockFrom.mockReturnValue(q);
      await toolHandlers.get_projects({ manager: 'Аня' });
      expect(q.ilike).toHaveBeenCalledWith('manager', '%Аня%');
    });

    it('returns error message on query failure', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: null, error: { message: 'DB error' } }));
      const result = await toolHandlers.get_projects({});
      expect(result).toContain('Ошибка');
    });
  });

  describe('get_project_detail', () => {
    it('returns project by id', async () => {
      const project = { id: 'p-1', client: 'Бета', status: 'В работе' };
      mockFrom.mockReturnValue(createMockQuery({ data: project, error: null }));
      const result = await toolHandlers.get_project_detail({ id: 'p-1' });
      const parsed = JSON.parse(result);
      expect(parsed.client).toBe('Бета');
    });

    it('returns not found message', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: null, error: null }));
      const result = await toolHandlers.get_project_detail({ id: 'nonexistent' });
      expect(result).toBe('Проект не найден.');
    });

    it('requires id or client', async () => {
      const result = await toolHandlers.get_project_detail({});
      expect(result).toContain('Укажите');
    });

    it('searches by client name with ilike', async () => {
      const q = createMockQuery({ data: { id: 'p-2', client: 'Гамма' }, error: null });
      mockFrom.mockReturnValue(q);
      await toolHandlers.get_project_detail({ client: 'Гамма' });
      expect(q.ilike).toHaveBeenCalledWith('client', '%Гамма%');
    });
  });

  describe('get_overdue_projects', () => {
    it('queries projects with deadline before today', async () => {
      const q = createMockQuery({ data: [{ id: '1', deadline: '2025-01-01' }], error: null });
      mockFrom.mockReturnValue(q);
      const result = await toolHandlers.get_overdue_projects({});
      expect(mockFrom).toHaveBeenCalledWith('projects');
      expect(q.lt).toHaveBeenCalled();
      const parsed = JSON.parse(result);
      expect(parsed).toHaveLength(1);
    });

    it('returns message when no overdue projects', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: [], error: null }));
      const result = await toolHandlers.get_overdue_projects({});
      expect(result).toBe('Просроченных проектов нет.');
    });
  });

  describe('get_tasks', () => {
    it('returns tasks', async () => {
      mockFrom.mockReturnValue(createMockQuery({
        data: [{ id: 't-1', title: 'Задача 1', status: 'pending' }],
        error: null,
      }));
      const result = await toolHandlers.get_tasks({});
      const parsed = JSON.parse(result);
      expect(parsed[0].title).toBe('Задача 1');
    });

    it('returns message when no tasks', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: [], error: null }));
      const result = await toolHandlers.get_tasks({});
      expect(result).toBe('Задачи не найдены.');
    });

    it('applies specialist filter', async () => {
      const q = createMockQuery({ data: [{ id: 't-1' }], error: null });
      mockFrom.mockReturnValue(q);
      await toolHandlers.get_tasks({ specialist: 'Маша' });
      expect(q.ilike).toHaveBeenCalledWith('specialist', '%Маша%');
    });
  });

  describe('get_review_requests', () => {
    it('returns review requests', async () => {
      mockFrom.mockReturnValue(createMockQuery({
        data: [{ id: 'r-1', status: 'submitted', tab_name: 'Лист1' }],
        error: null,
      }));
      const result = await toolHandlers.get_review_requests({});
      const parsed = JSON.parse(result);
      expect(parsed[0].status).toBe('submitted');
    });

    it('returns message when no reviews', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: [], error: null }));
      const result = await toolHandlers.get_review_requests({});
      expect(result).toBe('Ревью-запросов не найдено.');
    });

    it('applies status filter', async () => {
      const q = createMockQuery({ data: [{ id: 'r-1' }], error: null });
      mockFrom.mockReturnValue(q);
      await toolHandlers.get_review_requests({ status: 'submitted' });
      expect(q.eq).toHaveBeenCalledWith('status', 'submitted');
    });
  });

  describe('get_parser_results_summary', () => {
    it('requires job_id and parser_type', async () => {
      const result = await toolHandlers.get_parser_results_summary({});
      expect(result).toContain('Нужно указать');
    });
  });

  describe('get_kpi_summary', () => {
    it('aggregates KPI by manager', async () => {
      mockFrom.mockReturnValue(createMockQuery({
        data: [
          { manager: 'Аня', kpi_plan: 100, kpi_fact: 80, status: 'В работе' },
          { manager: 'Аня', kpi_plan: 50, kpi_fact: 50, status: 'Тестирование' },
        ],
        error: null,
      }));
      const result = await toolHandlers.get_kpi_summary({ group_by: 'manager' });
      const parsed = JSON.parse(result);
      expect(parsed[0].manager).toBe('Аня');
      expect(parsed[0].kpi_plan_total).toBe(150);
      expect(parsed[0].kpi_fact_total).toBe(130);
      expect(parsed[0].completion_percent).toBe(87);
    });
  });

  it('exports all 12 handlers', () => {
    const expected = [
      'get_projects', 'get_project_detail', 'get_overdue_projects', 'get_kpi_summary',
      'get_tasks', 'get_task_board_summary', 'get_parser_jobs', 'get_parser_results_summary',
      'get_instantly_campaigns', 'get_review_requests', 'get_team_workload', 'get_weekly_summary',
    ];
    for (const name of expected) {
      expect(typeof toolHandlers[name]).toBe('function');
    }
  });
});
