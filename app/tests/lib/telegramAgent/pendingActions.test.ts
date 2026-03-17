/** @jest-environment node */

import { setPending, getPending, clearPending, isConfirmation, isCancellation } from '@/lib/telegramAgent/pendingActions';

describe('telegramAgent/pendingActions', () => {
  afterEach(() => clearPending(1));

  const action = {
    tool: 'create_task',
    args: { title: 'Test' },
    description: 'Create task',
    user: { userId: 'u1', fullName: 'Test', role: 'admin', email: 'a@b.c', telegramId: 1 },
    createdAt: Date.now(),
  };

  it('stores and retrieves a pending action', () => {
    setPending(1, action);
    const result = getPending(1);
    expect(result).toEqual(action);
  });

  it('returns null for unknown chatId', () => {
    expect(getPending(999)).toBeNull();
  });

  it('clears pending action', () => {
    setPending(1, action);
    clearPending(1);
    expect(getPending(1)).toBeNull();
  });

  it('expires actions after TTL', () => {
    setPending(1, { ...action, createdAt: Date.now() - 6 * 60 * 1000 });
    expect(getPending(1)).toBeNull();
  });

  it('does not expire fresh actions', () => {
    setPending(1, { ...action, createdAt: Date.now() - 4 * 60 * 1000 });
    expect(getPending(1)).not.toBeNull();
  });
});

describe('confirmation patterns', () => {
  it.each(['да', 'Да', 'ДА', 'yes', 'подтверждаю', 'ок', 'ага', 'конечно', 'давай', 'go'])
    ('recognizes "%s" as confirmation', (text) => {
      expect(isConfirmation(text)).toBe(true);
    });

  it.each(['нет', 'Нет', 'НЕТ', 'no', 'отмена', 'не надо', 'стоп', 'cancel'])
    ('recognizes "%s" as cancellation', (text) => {
      expect(isCancellation(text)).toBe(true);
    });

  it.each(['привет', 'какие проекты', '123', 'может быть'])
    ('does not match "%s" as confirmation or cancellation', (text) => {
      expect(isConfirmation(text)).toBe(false);
      expect(isCancellation(text)).toBe(false);
    });
});
