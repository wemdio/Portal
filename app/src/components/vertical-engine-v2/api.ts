'use client';

import { authFetch } from '@/lib/authFetch';
import type {
  VeProject,
} from '@/lib/verticalEngineV2/types';
import type {
  VeLegacyCandidate,
  VeLegacyProjectDetail,
  VeLegacyProjectSummary,
} from '@/lib/verticalEngineV2/types.legacy';

export const VE_API = '/api/tools/vertical-engine-v2';

export interface VeProjectsResponse {
  projects?: VeProject[];
  permissions?: { can_manage_legacy_links?: boolean };
  error?: string;
}

export interface VeProjectCreateResponse {
  project?: VeProject;
  error?: string;
}

export interface VeLegacyProjectsResponse {
  projects?: VeLegacyProjectSummary[];
  error?: string;
}

export interface VeLegacyProjectDetailResponse {
  detail?: VeLegacyProjectDetail;
  error?: string;
}

export interface VeLegacyCandidatesResponse {
  candidates?: VeLegacyCandidate[];
  error?: string;
}

export async function veCall<T>(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: T }> {
  const response = await authFetch(url, init);
  const data = (await response.json().catch(() => ({}))) as T;
  return { ok: response.ok, status: response.status, data };
}

export function vePost<T>(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number; data: T }> {
  return veCall<T>(url, { method: 'POST', body: JSON.stringify(body) });
}

export function veDelete<T>(
  url: string,
): Promise<{ ok: boolean; status: number; data: T }> {
  return veCall<T>(url, { method: 'DELETE' });
}
