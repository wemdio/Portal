import type { DialogMessage } from './types';

export interface DeleteMessageTarget {
  dialogId: string;
  timestamp: string | null;
  content: string;
}

type DeletedMessage = { content: string; timestamps: number[] };
type EditState = { revision: number; pending: number; deleted: DeletedMessage[] };
const edits = new Map<string, EditState>();
const writes = new Map<string, Promise<unknown>>();
const deletions = new Map<string, Promise<unknown>>();

export function dialogEditKey(campaignId: string, accountId: string, peerId: number): string {
  return `${campaignId}/${accountId}/${peerId}`;
}

export function dialogRevision(key: string): number {
  return edits.get(key)?.revision ?? 0;
}

export function dialogUnchanged(key: string, revision: number): boolean {
  const state = edits.get(key);
  return !state?.pending && (state?.revision ?? 0) === revision;
}

export function clearDialogEdits(campaignId: string): void {
  for (const key of edits.keys()) {
    if (key.startsWith(`${campaignId}/`)) edits.delete(key);
  }
}

/** Старый снимок истории не должен возвращать уже удалённое сообщение. */
export function withoutDeletedMessages(key: string, messages: DialogMessage[]): DialogMessage[] {
  const deleted = edits.get(key)?.deleted ?? [];
  if (!deleted.length) return messages;
  return messages.filter((m) => m.role !== 'assistant' || !deleted.some((d) => {
    if (m.content.trim() !== d.content) return false;
    const at = m.timestamp ? Date.parse(m.timestamp) : NaN;
    return Number.isFinite(at) && d.timestamps.some((t) => Math.floor(t / 1000) === Math.floor(at / 1000));
  }));
}

async function serial<T>(queue: Map<string, Promise<unknown>>, key: string, work: () => Promise<T>): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queue.set(key, next);
  try {
    return await next;
  } finally {
    if (queue.get(key) === next) queue.delete(key);
  }
}

/** Сериализуем только запись истории, не задержки и обращения к GPT. */
export function withDialogWrite<T>(key: string, messages: DialogMessage[], write: (current: DialogMessage[]) => Promise<T>): Promise<T> {
  return serial(writes, key, () => write(withoutDeletedMessages(key, messages)));
}

export async function withDialogDeletion<T>(key: string, work: (deleted: (content: string, timestamps: Array<string | null>) => void) => Promise<T>): Promise<T> {
  const state = edits.get(key) ?? { revision: 0, pending: 0, deleted: [] };
  state.revision++;
  state.pending++;
  edits.set(key, state);
  try {
    return await serial(deletions, key, () => work((content, timestamps) => {
      state.deleted.push({
        content: content.trim(),
        timestamps: timestamps.map((t) => t ? Date.parse(t) : NaN).filter(Number.isFinite),
      });
    }));
  } finally {
    state.pending--;
  }
}
