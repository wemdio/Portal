/** @jest-environment node */

jest.mock('@/lib/supabaseAdmin', () => {
  const mockChain = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn(),
    single: jest.fn(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
  };
  return {
    supabaseAdmin: { from: jest.fn(() => ({ ...mockChain })) },
  };
});

jest.mock('@/lib/telegramAgent/telegram', () => ({
  sendMessage: jest.fn(),
  sendDocument: jest.fn(),
}));

jest.mock('@/lib/loggerServer', () => ({
  logAudit: jest.fn(),
  logError: jest.fn(),
}));

jest.mock('@/lib/telegramAgent/pipelineExport', () => ({
  exportPipelineResults: jest.fn().mockResolvedValue({ buffer: Buffer.from('csv'), filename: 'test.csv', rowCount: 5 }),
}));

import { createPipeline, getPipelineStatus } from '@/lib/telegramAgent/pipeline';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import type { AgentUser } from '@/lib/telegramAgent/types';

const mockFrom = supabaseAdmin!.from as jest.Mock;

const testUser: AgentUser = {
  userId: 'u1', fullName: 'Test User', role: 'admin', email: 'test@test.com', telegramId: 123,
};

describe('createPipeline', () => {
  beforeEach(() => jest.clearAllMocks());

  it('creates pipeline and auto-appends export step', async () => {
    const pipelineData = {
      id: 'p1', user_id: 'u1', chat_id: 123, name: 'Test', status: 'pending',
      current_step_index: 0,
      steps: [
        { type: 'parse_hh', config: { text: 'Python' }, status: 'pending' },
        { type: 'export', config: {}, status: 'pending' },
      ],
      context: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    mockFrom.mockImplementation(() => ({
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: pipelineData, error: null }),
        }),
      }),
    }));

    const result = await createPipeline(
      testUser, 123, 'Test',
      [{ type: 'parse_hh', config: { text: 'Python' }, status: 'pending' }],
    );

    expect(result.id).toBe('p1');
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].type).toBe('export');
  });

  it('throws on empty steps', async () => {
    await expect(createPipeline(testUser, 123, 'Empty', []))
      .rejects.toThrow('at least one step');
  });

  it('does not double-add export if already present', async () => {
    const steps = [
      { type: 'parse_hh' as const, config: { text: 'Test' }, status: 'pending' as const },
      { type: 'export' as const, config: {}, status: 'pending' as const },
    ];

    const pipelineData = {
      id: 'p2', user_id: 'u1', chat_id: 123, name: 'T2', status: 'pending',
      current_step_index: 0, steps, context: {},
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };

    mockFrom.mockImplementation(() => ({
      insert: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          single: jest.fn().mockResolvedValue({ data: pipelineData, error: null }),
        }),
      }),
    }));

    const result = await createPipeline(testUser, 123, 'T2', [...steps]);
    expect(result.steps.filter((s) => s.type === 'export')).toHaveLength(1);
  });
});

describe('getPipelineStatus', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns "not found" for missing pipeline', async () => {
    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: jest.fn().mockResolvedValue({ data: null, error: null }),
        }),
      }),
    }));

    const result = await getPipelineStatus('nonexistent');
    expect(result).toContain('не найден');
  });

  it('formats pipeline status with step details', async () => {
    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          maybeSingle: jest.fn().mockResolvedValue({
            data: {
              id: 'p1', user_id: 'u1', chat_id: 123, name: 'HH Pipeline',
              status: 'running', current_step_index: 1,
              steps: [
                { type: 'parse_hh', status: 'completed', config: {}, result_count: 100 },
                { type: 'enrich_emails', status: 'running', config: {} },
                { type: 'export', status: 'pending', config: {} },
              ],
              context: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
            },
            error: null,
          }),
        }),
      }),
    }));

    const result = await getPipelineStatus('p1');
    expect(result).toContain('HH Pipeline');
    expect(result).toContain('running');
    expect(result).toContain('100');
    expect(result).toContain('Парсинг HH');
    expect(result).toContain('Поиск email');
  });

  it('shows user pipelines when no id given', async () => {
    mockFrom.mockImplementation(() => ({
      select: jest.fn().mockReturnValue({
        eq: jest.fn().mockReturnValue({
          order: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue({
              data: [
                {
                  id: 'p1', user_id: 'u1', chat_id: 123, name: 'Pipeline 1',
                  status: 'completed', current_step_index: 2,
                  steps: [{ type: 'parse_hh', status: 'completed', config: {}, result_count: 50 }],
                  context: {},
                },
              ],
              error: null,
            }),
          }),
        }),
      }),
    }));

    const result = await getPipelineStatus(undefined, 'u1');
    expect(result).toContain('Pipeline 1');
  });
});
