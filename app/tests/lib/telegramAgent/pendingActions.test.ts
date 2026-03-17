/** @jest-environment node */

import { setPending, getPending, clearPending, addPendingItem } from '@/lib/telegramAgent/pendingActions';
import type { AgentUser } from '@/lib/telegramAgent/types';

const testUser: AgentUser = {
  userId: 'u1', fullName: 'Test', role: 'admin', email: 'a@b.c', telegramId: 1,
};

describe('telegramAgent/pendingActions', () => {
  afterEach(() => clearPending(1));

  const action = {
    items: [{ tool: 'create_task', args: { title: 'Test' }, description: 'Create task' }],
    user: testUser,
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

describe('addPendingItem (batch)', () => {
  afterEach(() => clearPending(2));

  it('creates new pending with single item', () => {
    addPendingItem(2, { tool: 'create_task', args: { title: 'A' }, description: 'Task A' }, testUser);
    const pending = getPending(2);
    expect(pending).not.toBeNull();
    expect(pending!.items).toHaveLength(1);
    expect(pending!.items[0].tool).toBe('create_task');
  });

  it('appends to existing pending', () => {
    addPendingItem(2, { tool: 'create_task', args: { title: 'A' }, description: 'Task A' }, testUser);
    addPendingItem(2, { tool: 'launch_hh_parser', args: { text: 'Python' }, description: 'HH parse' }, testUser);
    const pending = getPending(2);
    expect(pending).not.toBeNull();
    expect(pending!.items).toHaveLength(2);
    expect(pending!.items[0].tool).toBe('create_task');
    expect(pending!.items[1].tool).toBe('launch_hh_parser');
  });

  it('creates batch of 3 items', () => {
    addPendingItem(2, { tool: 'a', args: {}, description: 'A' }, testUser);
    addPendingItem(2, { tool: 'b', args: {}, description: 'B' }, testUser);
    addPendingItem(2, { tool: 'c', args: {}, description: 'C' }, testUser);
    expect(getPending(2)!.items).toHaveLength(3);
  });
});
