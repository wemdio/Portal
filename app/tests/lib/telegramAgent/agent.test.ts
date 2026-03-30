/** @jest-environment node */

jest.mock('@/lib/supabaseAdmin', () => ({
  supabaseAdmin: { from: jest.fn() },
}));
jest.mock('@/lib/loggerServer', () => ({
  logError: jest.fn(),
  logAudit: jest.fn(),
}));

const mockCallLlm = jest.fn();
jest.mock('@/lib/telegramAgent/llm', () => ({
  callLlm: (...args: unknown[]) => mockCallLlm(...args),
}));

const mockIdentifyUser = jest.fn();
jest.mock('@/lib/telegramAgent/auth', () => ({
  identifyUser: (...args: unknown[]) => mockIdentifyUser(...args),
}));

const mockSendMessage = jest.fn().mockResolvedValue(undefined);
const mockSendChatAction = jest.fn().mockResolvedValue(undefined);
jest.mock('@/lib/telegramAgent/telegram', () => ({
  sendMessage: (...args: unknown[]) => mockSendMessage(...args),
  sendChatAction: (...args: unknown[]) => mockSendChatAction(...args),
}));

const mockGetHistory = jest.fn().mockReturnValue([]);
const mockPushMessages = jest.fn();
jest.mock('@/lib/telegramAgent/memory', () => ({
  getHistory: (...args: unknown[]) => mockGetHistory(...args),
  pushMessages: (...args: unknown[]) => mockPushMessages(...args),
}));

jest.mock('@/lib/telegramAgent/handlers', () => ({
  toolHandlers: {
    get_projects: jest.fn().mockResolvedValue('[]'),
  },
}));

import { processMessage, handleAgentMessage } from '@/lib/telegramAgent/agent';
import type { AgentUser } from '@/lib/telegramAgent/types';

const testUser: AgentUser = {
  userId: 'u-1',
  fullName: 'Тест',
  role: 'admin',
  email: 'test@test.com',
  telegramId: 12345,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGetHistory.mockReturnValue([]);
});

describe('telegramAgent/agent', () => {
  describe('processMessage', () => {
    it('sends typing action and calls LLM', async () => {
      mockCallLlm.mockResolvedValueOnce({ content: 'Ответ бота', toolCalls: [] });

      await processMessage(100, testUser, 'Привет');

      expect(mockSendChatAction).toHaveBeenCalledWith(100);
      expect(mockCallLlm).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith(100, 'Ответ бота');
    });

    it('saves messages to memory', async () => {
      mockCallLlm.mockResolvedValueOnce({ content: 'Ответ', toolCalls: [] });

      await processMessage(100, testUser, 'Вопрос');

      expect(mockPushMessages).toHaveBeenCalledTimes(1);
      const saved = mockPushMessages.mock.calls[0][1];
      expect(saved.some((m: { role: string }) => m.role === 'user')).toBe(true);
      expect(saved.some((m: { role: string }) => m.role === 'assistant')).toBe(true);
    });

    it('handles tool calls from LLM', async () => {
      mockCallLlm
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [
            { id: 'c1', type: 'function', function: { name: 'get_projects', arguments: '{}' } },
          ],
        })
        .mockResolvedValueOnce({ content: 'Вот проекты', toolCalls: [] });

      await processMessage(100, testUser, 'Покажи проекты');

      expect(mockCallLlm).toHaveBeenCalledTimes(2);
      expect(mockSendMessage).toHaveBeenCalledWith(100, 'Вот проекты');
    });

    it('falls back on empty LLM response', async () => {
      mockCallLlm.mockResolvedValueOnce({ content: null, toolCalls: [] });

      await processMessage(100, testUser, 'Привет');

      expect(mockSendMessage).toHaveBeenCalledWith(100, 'Не удалось сформировать ответ.');
    });

    it('limits tool call iterations', async () => {
      mockCallLlm.mockResolvedValue({
        content: null,
        toolCalls: [
          { id: 'c1', type: 'function', function: { name: 'get_projects', arguments: '{}' } },
        ],
      });

      await processMessage(100, testUser, 'Бесконечный цикл');

      expect(mockCallLlm).toHaveBeenCalledTimes(10);
      expect(mockSendMessage).toHaveBeenCalledWith(
        100,
        expect.stringContaining('слишком сложным'),
      );
    });
  });

  describe('handleAgentMessage', () => {
    it('sends unlinked message for unknown telegram user', async () => {
      mockIdentifyUser.mockResolvedValueOnce(null);

      await handleAgentMessage({ chat: { id: 100 }, from: { id: 999 }, text: 'Привет' });

      expect(mockSendMessage).toHaveBeenCalledWith(100, expect.stringContaining('не привязан'));
    });

    it('skips messages without text', async () => {
      await handleAgentMessage({ chat: { id: 100 }, from: { id: 999 } });

      expect(mockIdentifyUser).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('skips messages without from', async () => {
      await handleAgentMessage({ chat: { id: 100 }, text: 'Hello' });

      expect(mockIdentifyUser).not.toHaveBeenCalled();
    });

    it('processes message for linked user', async () => {
      mockIdentifyUser.mockResolvedValueOnce(testUser);
      mockCallLlm.mockResolvedValueOnce({ content: 'OK', toolCalls: [] });

      await handleAgentMessage({ chat: { id: 100 }, from: { id: 12345 }, text: 'Привет' });

      expect(mockCallLlm).toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith(100, 'OK');
    });
  });
});
