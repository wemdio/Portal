/** @jest-environment node */

const mockFrom = jest.fn();
jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: (...args: unknown[]) => mockFrom(...args) },
}));
jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(),
  logError: jest.fn(),
}));

import {
  updateProjectStatus,
  updateProjectFields,
  createProject,
  createTask,
  updateTaskStatus,
  updateTaskFields,
  updateReviewStatus,
  launchHhParser,
} from '@/lib/telegramAgent/writeHandlers';
import type { AgentUser } from '@/lib/telegramAgent/types';

const testUser: AgentUser = {
  userId: 'u-test-123',
  fullName: 'Test User',
  role: 'admin',
  email: 'test@example.com',
  telegramId: 12345,
};

function createMockQuery(resolvedValue: { data: unknown; error: unknown }) {
  const query: Record<string, jest.Mock> = {};
  const methods = ['select', 'eq', 'single', 'maybeSingle', 'insert', 'update', 'delete', 'in', 'ilike', 'order', 'limit', 'gte', 'lt', 'not'];
  for (const m of methods) {
    query[m] = jest.fn().mockReturnValue(query);
  }
  query.single = jest.fn().mockResolvedValue(resolvedValue);
  query.maybeSingle = jest.fn().mockResolvedValue(resolvedValue);
  query.then = jest.fn().mockImplementation((resolve) => resolve(resolvedValue));
  return query;
}

afterEach(() => jest.clearAllMocks());

describe('writeHandlers', () => {
  describe('updateProjectStatus', () => {
    it('updates project status', async () => {
      const fetchQuery = createMockQuery({ data: { id: 'p1', name: 'Alpha', client: 'C1', status: 'В работе' }, error: null });
      const updateQuery = createMockQuery({ data: null, error: null });
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? fetchQuery : updateQuery;
      });

      const result = await updateProjectStatus({ project_id: 'p1', new_status: 'Завершен' }, testUser);
      expect(result).toContain('Alpha');
      expect(result).toContain('Завершен');
    });

    it('returns error when project not found', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: null, error: null }));
      const result = await updateProjectStatus({ project_id: 'xxx', new_status: 'Завершен' }, testUser);
      expect(result).toContain('не найден');
    });
  });

  describe('createProject', () => {
    it('creates a project', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: { id: 'p2', name: 'Beta', status: 'Подготовка' }, error: null }));
      const result = await createProject({ name: 'Beta', client: 'C2' }, testUser);
      expect(result).toContain('Beta');
      expect(result).toContain('создан');
    });

    it('rejects missing name', async () => {
      const result = await createProject({}, testUser);
      expect(result).toContain('обязательно');
    });
  });

  describe('createTask', () => {
    it('creates a task', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: { id: 't1', title: 'Do thing', status: 'pending' }, error: null }));
      const result = await createTask({ title: 'Do thing', specialist: 'Ivan' }, testUser);
      expect(result).toContain('Do thing');
      expect(result).toContain('создана');
    });
  });

  describe('updateReviewStatus', () => {
    it('validates status transitions', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: { id: 'r1', tab_name: 'Tab1', status: 'submitted' }, error: null }));
      const result = await updateReviewStatus({ review_id: 'r1', new_status: 'client_approved' }, testUser);
      expect(result).toContain('Недопустимый переход');
    });

    it('allows valid transition', async () => {
      const fetchQuery = createMockQuery({ data: { id: 'r1', tab_name: 'Tab1', status: 'submitted' }, error: null });
      const updateQuery = createMockQuery({ data: null, error: null });
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? fetchQuery : updateQuery;
      });

      const result = await updateReviewStatus({ review_id: 'r1', new_status: 'review_approved' }, testUser);
      expect(result).toContain('Tab1');
      expect(result).toContain('Одобрено');
    });
  });

  describe('updateProjectFields', () => {
    it('rejects empty fields', async () => {
      const result = await updateProjectFields({ project_id: 'p1' }, testUser);
      expect(result).toContain('Не указаны');
    });
  });

  describe('updateTaskFields', () => {
    it('updates task fields', async () => {
      const fetchQuery = createMockQuery({ data: { id: 't1', title: 'Task1' }, error: null });
      const updateQuery = createMockQuery({ data: null, error: null });
      let callCount = 0;
      mockFrom.mockImplementation(() => {
        callCount++;
        return callCount === 1 ? fetchQuery : updateQuery;
      });

      const result = await updateTaskFields({ task_id: 't1', specialist: 'Петров' }, testUser);
      expect(result).toContain('Task1');
      expect(result).toContain('specialist');
    });
  });

  describe('launchHhParser', () => {
    it('creates parser job with correct user_id and config', async () => {
      mockFrom.mockReturnValue(createMockQuery({
        data: { id: 'job-1', status: 'pending', parser_type: 'hh_vacancies', config: { text: 'Python' } },
        error: null,
      }));

      const result = await launchHhParser({ text: 'Python разработчик', area: '1' }, testUser);
      expect(result).toContain('job-1');
      expect(result).toContain('Python разработчик');
      expect(mockFrom).toHaveBeenCalledWith('parser_jobs');
    });

    it('rejects missing search text', async () => {
      const result = await launchHhParser({}, testUser);
      expect(result).toContain('обязателен');
    });

    it('passes user_id from agent user', async () => {
      const insertQuery = createMockQuery({
        data: { id: 'job-2', status: 'pending', parser_type: 'hh_vacancies', config: { text: 'Java' } },
        error: null,
      });
      mockFrom.mockReturnValue(insertQuery);

      await launchHhParser({ text: 'Java' }, testUser);

      expect(insertQuery.insert).toHaveBeenCalledWith(
        expect.objectContaining({ user_id: 'u-test-123', parser_type: 'hh_vacancies', status: 'pending' }),
      );
    });

    it('returns error on DB failure', async () => {
      mockFrom.mockReturnValue(createMockQuery({ data: null, error: { message: 'DB error' } }));

      const result = await launchHhParser({ text: 'Test' }, testUser);
      expect(result).toContain('Ошибка');
    });
  });
});
