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
  hasKnowledgeBase: boolean;
}

export function fetchProjects() {
  return fetchWithAuth<{ projects: ProjectListItem[] }>(`${BASE}/projects`);
}

export interface KnowledgeBaseDto {
  projectId: string;
  brief: string;
  productFacts: string;
  toneNotes: string;
  exampleCase: string;
  instantlyAccountId: string;
  updatedAt: string;
}

export function fetchKnowledgeBase(projectId: string) {
  return fetchWithAuth<{ kb: KnowledgeBaseDto | null }>(`${BASE}/projects/${projectId}/kb`);
}

export function saveKnowledgeBase(projectId: string, patch: Omit<KnowledgeBaseDto, 'projectId' | 'updatedAt'>) {
  return fetchWithAuth<{ kb: KnowledgeBaseDto }>(`${BASE}/projects/${projectId}/kb`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
}

export function fetchReplies(projectId: string) {
  return fetchWithAuth<{ replies: ReplyListItem[]; needsKnowledgeBase: boolean }>(
    `${BASE}/projects/${projectId}/replies`,
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

export function sendReply(qualificationId: string, draftId: string) {
  return fetchWithAuth<{ ok: true }>(`${BASE}/replies/${qualificationId}/send`, {
    method: 'POST',
    body: JSON.stringify({ draftId }),
  });
}

export function skipReply(qualificationId: string, projectId: string) {
  return fetchWithAuth<{ ok: true }>(`${BASE}/replies/${qualificationId}/skip`, {
    method: 'POST',
    body: JSON.stringify({ projectId }),
  });
}

export type { DraftStatus };
