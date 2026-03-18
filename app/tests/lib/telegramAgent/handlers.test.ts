/** @jest-environment node */

const mockRpc = jest.fn();

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => mockRpc(...args) },
}));

jest.mock('@/lib/telegramAgent/pipeline', () => ({
  getPipelineStatus: jest.fn(() => Promise.resolve('Pipeline status')),
  advanceAllPipelines: jest.fn(() => Promise.resolve(0)),
}));

import { toolHandlers } from '@/lib/telegramAgent/handlers';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('telegramAgent/handlers', () => {
  it('exports query_database and get_pipeline_status', () => {
    expect(typeof toolHandlers.query_database).toBe('function');
    expect(typeof toolHandlers.get_pipeline_status).toBe('function');
    expect(Object.keys(toolHandlers)).toHaveLength(2);
  });

  describe('query_database', () => {
    it('rejects empty query', async () => {
      const result = await toolHandlers.query_database({});
      expect(result).toContain('SQL');
    });

    it('rejects non-SELECT queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'DELETE FROM projects' });
      expect(result).toContain('rejected');
    });

    it('rejects INSERT queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'INSERT INTO projects VALUES (1)' });
      expect(result).toContain('rejected');
    });

    it('rejects UPDATE queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'UPDATE projects SET name = \'x\'' });
      expect(result).toContain('rejected');
    });

    it('rejects DROP queries', async () => {
      const result = await toolHandlers.query_database({ sql: 'DROP TABLE projects' });
      expect(result).toContain('rejected');
    });

    it('rejects auth schema access', async () => {
      const result = await toolHandlers.query_database({ sql: 'SELECT * FROM auth.users' });
      expect(result).toContain('rejected');
    });

    it('allows keywords inside string literals', async () => {
      mockRpc.mockResolvedValue({ data: [{ id: '1' }], error: null });
      const result = await toolHandlers.query_database({
        sql: "SELECT * FROM application_logs WHERE event = 'update' AND source = 'delete_handler'",
      });
      expect(mockRpc).toHaveBeenCalled();
      expect(result).not.toContain('rejected');
    });

    it('still rejects real mutation with keyword in code position', async () => {
      const result = await toolHandlers.query_database({
        sql: "SELECT 1; DELETE FROM projects WHERE name = 'test'",
      });
      expect(result).toContain('rejected');
    });

    it('allows SELECT queries and calls RPC', async () => {
      mockRpc.mockResolvedValue({
        data: [{ id: '1', name: 'Project 1' }],
        error: null,
      });

      const result = await toolHandlers.query_database({
        sql: 'SELECT id, name FROM projects LIMIT 10',
      });

      expect(mockRpc).toHaveBeenCalledWith('agent_query_readonly', {
        query_text: 'SELECT id, name FROM projects LIMIT 10',
      });
      expect(result).toContain('Project 1');
      expect(result).toContain('1 строк');
    });

    it('allows WITH (CTE) queries', async () => {
      mockRpc.mockResolvedValue({ data: [{ cnt: 5 }], error: null });

      const result = await toolHandlers.query_database({
        sql: 'WITH active AS (SELECT * FROM projects WHERE status = \'В работе\') SELECT count(*) AS cnt FROM active',
      });

      expect(mockRpc).toHaveBeenCalled();
      expect(result).toContain('5');
    });

    it('returns error message on RPC failure', async () => {
      mockRpc.mockResolvedValue({ data: null, error: { message: 'permission denied' } });

      const result = await toolHandlers.query_database({
        sql: 'SELECT * FROM projects',
      });
      expect(result).toContain('SQL error');
    });

    it('handles empty results', async () => {
      mockRpc.mockResolvedValue({ data: [], error: null });
      const result = await toolHandlers.query_database({ sql: 'SELECT * FROM projects WHERE 1=0' });
      expect(result).toContain('0 строк');
    });
  });

  describe('get_pipeline_status', () => {
    it('returns pipeline status', async () => {
      const result = await toolHandlers.get_pipeline_status({});
      expect(result).toBe('Pipeline status');
    });
  });
});
