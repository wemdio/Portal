import type { AgentUser } from './types';

export type PendingAction = {
  tool: string;
  args: Record<string, unknown>;
  description: string;
  user: AgentUser;
  createdAt: number;
};

const TTL_MS = 5 * 60 * 1000;
const store = new Map<number, PendingAction>();

export function setPending(chatId: number, action: PendingAction): void {
  store.set(chatId, action);
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

const CONFIRM_PATTERNS = /^(да|yes|подтвер|ок$|ага|конечно|точно|давай$|go$)/i;
const CANCEL_PATTERNS = /^(нет|no|отмен|не надо|стоп|cancel)/i;

export function isConfirmation(text: string): boolean {
  return CONFIRM_PATTERNS.test(text.trim());
}

export function isCancellation(text: string): boolean {
  return CANCEL_PATTERNS.test(text.trim());
}
