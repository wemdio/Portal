import type { AgentUser } from './types';

export type PendingItem = {
  tool: string;
  args: Record<string, unknown>;
  description: string;
};

export type PendingAction = {
  items: PendingItem[];
  user: AgentUser;
  createdAt: number;
};

const TTL_MS = 5 * 60 * 1000;
const store = new Map<number, PendingAction>();

export function setPending(chatId: number, action: PendingAction): void {
  store.set(chatId, action);
}

export function addPendingItem(chatId: number, item: PendingItem, user: AgentUser): void {
  const existing = getPending(chatId);
  if (existing) {
    existing.items.push(item);
  } else {
    setPending(chatId, { items: [item], user, createdAt: Date.now() });
  }
}

export function getPending(chatId: number): PendingAction | null {
  const action = store.get(chatId);
  if (!action) return null;
  if (Date.now() - action.createdAt > TTL_MS) {
    store.delete(chatId);
    return null;
  }
  return action;
}

export function clearPending(chatId: number): void {
  store.delete(chatId);
}
