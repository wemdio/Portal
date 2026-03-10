/** @jest-environment node */

import { getHistory, pushMessages, clearHistory, _reset, _storeSize } from '@/lib/telegramAgent/memory';
import type { ConversationMessage } from '@/lib/telegramAgent/types';

afterEach(() => {
  _reset();
});

describe('telegramAgent/memory', () => {
  const chatId = 12345;

  it('returns empty array for unknown chatId', () => {
    expect(getHistory(999)).toEqual([]);
  });

  it('stores and retrieves messages', () => {
    const msgs: ConversationMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    pushMessages(chatId, msgs);
    expect(getHistory(chatId)).toEqual(msgs);
  });

  it('limits messages to 20', () => {
    const msgs: ConversationMessage[] = Array.from({ length: 25 }, (_, i) => ({
      role: 'user' as const,
      content: `msg ${i}`,
    }));
    pushMessages(chatId, msgs);
    const history = getHistory(chatId);
    expect(history).toHaveLength(20);
    expect(history[0]).toEqual({ role: 'user', content: 'msg 5' });
    expect(history[19]).toEqual({ role: 'user', content: 'msg 24' });
  });

  it('appends messages across multiple pushes', () => {
    pushMessages(chatId, [{ role: 'user', content: 'first' }]);
    pushMessages(chatId, [{ role: 'assistant', content: 'second' }]);
    const history = getHistory(chatId);
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('first');
    expect(history[1].content).toBe('second');
  });

  it('handles multiple chats independently', () => {
    pushMessages(100, [{ role: 'user', content: 'chat 100' }]);
    pushMessages(200, [{ role: 'user', content: 'chat 200' }]);
    expect(getHistory(100)[0].content).toBe('chat 100');
    expect(getHistory(200)[0].content).toBe('chat 200');
  });

  it('clearHistory removes chat', () => {
    pushMessages(chatId, [{ role: 'user', content: 'hello' }]);
    clearHistory(chatId);
    expect(getHistory(chatId)).toEqual([]);
  });

  it('_reset clears all chats', () => {
    pushMessages(1, [{ role: 'user', content: 'a' }]);
    pushMessages(2, [{ role: 'user', content: 'b' }]);
    _reset();
    expect(_storeSize()).toBe(0);
  });

  it('returns a copy of messages (not a reference)', () => {
    pushMessages(chatId, [{ role: 'user', content: 'original' }]);
    const h1 = getHistory(chatId);
    h1.push({ role: 'user', content: 'injected' });
    const h2 = getHistory(chatId);
    expect(h2).toHaveLength(1);
  });
});
