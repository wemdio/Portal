import { supabase } from '@/lib/supabaseClient';
import type { DraftStatus, ReplyListItem } from '@/lib/replyPersonalization/types';

const BASE = '/api/tools/reply-personalization';

async function fetchWithAuth<T>(path: string, options?: RequestInit): Promise<T> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const res = await fetch(path, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...options?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface ProjectListItem {
  id: string;
  client: string;
  /** Почему по проекту не собрать ответ (сейчас — только нет брифа); null — всё есть. */
  missingReason: string | null;
}

export function fetchProjects() {
  return fetchWithAuth<{ projects: ProjectListItem[]; canManageGlobalKb: boolean }>(
    `${BASE}/projects`,
  );
}

export interface KnowledgeBaseDto {
  projectId: string;
  productFacts: string;
  toneNotes: string;
  exampleCase: string;
  /** Запасной бриф из самой модалки: используется, пока карточка проекта пуста. */
  localBrief: string;
  updatedAt: string;
}

export interface GlobalKnowledgeBaseDto {
  toneNotes: string;
  exampleCase: string;
  updatedAt: string;
}

/**
 * `projectBrief` — бриф из карточки проекта, только для чтения: карточку ведут
 * менеджеры проекта, и инструмент её не переписывает. Если он пуст, в дело идёт
 * `kb.localBrief`, который заполняют прямо в модалке.
 */
export function fetchKnowledgeBase(projectId: string) {
  return fetchWithAuth<{ kb: KnowledgeBaseDto | null; projectBrief: string; global: GlobalKnowledgeBaseDto }>(
    `${BASE}/projects/${projectId}/kb`,
  );
}

export function saveKnowledgeBase(projectId: string, patch: Omit<KnowledgeBaseDto, 'projectId' | 'updatedAt'>) {
  return fetchWithAuth<{ kb: KnowledgeBaseDto }>(`${BASE}/projects/${projectId}/kb`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function saveGlobalKnowledgeBase(patch: { toneNotes: string; exampleCase: string }) {
  return fetchWithAuth<{ global: GlobalKnowledgeBaseDto }>(`${BASE}/global-kb`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function fetchGlobalKnowledgeBase() {
  return fetchWithAuth<{ global: GlobalKnowledgeBaseDto }>(`${BASE}/global-kb`);
}

export function fetchReplies(projectId: string) {
  return fetchWithAuth<{ replies: ReplyListItem[]; missingReason: string | null }>(
    `${BASE}/projects/${projectId}/replies`,
  );
}

export interface ThreadResponse {
  messages: { fromUs: boolean; text: string; timestamp?: string }[];
  contextComplete: boolean;
}

export function fetchThread(qualificationId: string, projectId: string) {
  return fetchWithAuth<ThreadResponse>(
    `${BASE}/replies/${qualificationId}/thread?projectId=${encodeURIComponent(projectId)}`,
  );
}

export interface GenerateResponse {
  draftId: string;
  text: string;
  factsUsed: string;
  sources: { url: string; title?: string }[];
  contextComplete: boolean;
}

export function generateReply(qualificationId: string, projectId: string) {
  return fetchWithAuth<GenerateResponse>(`${BASE}/replies/${qualificationId}/generate`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export function sendReply(qualificationId: string, draftId: string, text: string) {
  return fetchWithAuth<{ ok: true }>(`${BASE}/replies/${qualificationId}/send`, {
    method: 'POST',
    body: JSON.stringify({ draftId, text }),
  });
}

export function skipReply(qualificationId: string, projectId: string) {
  return fetchWithAuth<{ ok: true }>(`${BASE}/replies/${qualificationId}/skip`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

/**
 * Извлечь текст из файла (PDF/DOCX/TXT/MD) для полей базы знаний.
 * Отдельно от fetchWithAuth: multipart-форма не должна получать
 * Content-Type: application/json — браузер сам ставит boundary.
 */
export async function extractTextFromFile(file: File): Promise<string> {
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Not authenticated');
  const form = new FormData();
  form.append('file', file);
  const res = await fetch(`${BASE}/extract-text`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(body?.error ?? `Request failed: ${res.status}`);
  }
  const data = (await res.json()) as { text: string };
  return data.text;
}

export type { DraftStatus };
