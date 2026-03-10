import type { ConversationMessage } from './types';

const MAX_MESSAGES = 20;
const TTL_MS = 60 * 60 * 1000; // 1 hour

type ConversationEntry = {
  messages: ConversationMessage[];
  lastAccess: number;
};

const store = new Map<number, ConversationEntry>();

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer() {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [chatId, entry] of store) {
      if (now - entry.lastAccess > TTL_MS) store.delete(chatId);
    }
    if (store.size === 0 && cleanupTimer) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, TTL_MS);
  if (typeof cleanupTimer === 'object' && 'unref' in cleanupTimer) {
    cleanupTimer.unref();
  }
}

export function getHistory(chatId: number): ConversationMessage[] {
  const entry = store.get(chatId);
  if (!entry) return [];
  entry.lastAccess = Date.now();
  return [...entry.messages];
}

export function pushMessages(chatId: number, messages: ConversationMessage[]): void {
  const entry = store.get(chatId);
  const current = entry ? entry.messages : [];
  const updated = [...current, ...messages].slice(-MAX_MESSAGES);
  store.set(chatId, { messages: updated, lastAccess: Date.now() });
  ensureCleanupTimer();
}

export function clearHistory(chatId: number): void {
  store.delete(chatId);
}

/** Visible for testing */
export function _reset(): void {
  store.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

export function _storeSize(): number {
  return store.size;
}
