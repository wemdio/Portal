'use client';

/**
 * Fetch-обёртка и DTO клиентского ENG-кабинета «Движка вертикалей».
 * Кодируется строго под контракт /api/client/eng/*; DTO-типы staff-мастера
 * (components/hypothesis-engine/api) переиспользуем — контракт деталки тот же.
 */

import { clientApiFetch } from '@/lib/clientFetcher';
import type {
  HeBaseCollectResponse,
  HeChainLetterDto,
  HeHypothesisResponse,
  HeJobResponse,
  HeJobSummary,
  HeProjectDetailResponse,
} from '@/components/hypothesis-engine/api';
import type { HeProject } from '@/lib/hypothesisEngine/types';
import type { HeLaunchPresetOption, HeTemplateLaunchInfo } from '@/lib/hypothesisEngine/launchHandoff';

export type {
  HeBaseSummary,
  HeChainDto,
  HeChainLetterDto,
  HeCollectInfo,
  HeJobSummary,
  HeProjectDetailResponse,
} from '@/components/hypothesis-engine/api';
export type { HeLaunchPresetOption, HeTemplateLaunchInfo };

import type { HeBaseSummary as HeBaseSummaryDto, HeCollectInfo as HeCollectInfoDto } from '@/components/hypothesis-engine/api';

/** Состояние фазы CONSTRUCT в collect_info (зеркало HeConstructInfo стадии base_collect). */
export interface EngConstructInfo {
  bc_job_id: string | null;
  status: 'dispatched' | 'done' | 'failed' | 'cancelled';
  dispatched_at?: string;
  /** Почт найдено конструктором. */
  emails_found?: number;
  /** Почт с вердиктом ok после валидации. */
  valid_count?: number;
  note?: string;
}

/** collect_info с полями ENG-конвейера (construct + stats) — шире staff-DTO. */
export interface EngCollectInfo extends HeCollectInfoDto {
  construct?: EngConstructInfo;
  stats?: {
    tasks_total?: number;
    tasks_done?: number;
    tasks_failed?: number;
    rows_total?: number;
    finished_at?: string;
  };
}

/** Строка базы в деталке проекта кабинета (collect_info с construct/stats). */
export type EngBaseSummary = Omit<HeBaseSummaryDto, 'collect_info'> & {
  collect_info?: EngCollectInfo | null;
};

/** Строка списка проектов кабинета (GET /eng/projects). */
export interface EngProjectListItem {
  id: string;
  name: string;
  website_url: string;
  status: string;
  error: string | null;
  created_at: string;
  vertical_count: number;
  base_count: number;
}

interface EngProjectsResponse {
  projects?: EngProjectListItem[];
  error?: string;
}

interface EngProjectCreateResponse {
  project?: HeProject;
  job?: HeJobSummary;
  error?: string;
}

interface EngPatchResponse {
  project?: HeProject;
  error?: string;
}

interface EngCancelResponse {
  ok?: boolean;
  cancelled?: number;
  error?: string;
}

interface EngPresetsResponse {
  presets?: HeLaunchPresetOption[];
  error?: string;
}

export interface EngLaunchResponse {
  ok?: boolean;
  launch?: HeTemplateLaunchInfo;
  warnings?: string[];
  error?: string;
}

interface EngChainPatchResponse {
  letters?: HeChainLetterDto[];
  error?: string;
}

export async function fetchEngProjects(): Promise<EngProjectListItem[]> {
  const data = await clientApiFetch<EngProjectsResponse>('/eng/projects');
  return data.projects ?? [];
}

export async function createEngProject(input: {
  website_url: string;
  name?: string;
}): Promise<EngProjectCreateResponse> {
  return clientApiFetch<EngProjectCreateResponse>('/eng/projects', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function fetchEngProjectDetail(projectId: string): Promise<HeProjectDetailResponse> {
  return clientApiFetch<HeProjectDetailResponse>(`/eng/projects/${projectId}`);
}

export async function patchEngProject(
  projectId: string,
  body: { offer_override?: string; style_override?: string; signature_override?: string; business_override?: string },
): Promise<EngPatchResponse> {
  return clientApiFetch<EngPatchResponse>(`/eng/projects/${projectId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

export async function startEngResearch(projectId: string): Promise<HeJobResponse> {
  return clientApiFetch<HeJobResponse>(`/eng/projects/${projectId}/research`, { method: 'POST' });
}

export async function cancelEngProject(projectId: string): Promise<EngCancelResponse> {
  return clientApiFetch<EngCancelResponse>(`/eng/projects/${projectId}/cancel`, { method: 'POST' });
}

export async function patchEngHypothesis(
  hypothesisId: string,
  verdict: 'accept' | 'reject',
): Promise<HeHypothesisResponse> {
  return clientApiFetch<HeHypothesisResponse>(`/eng/hypotheses/${hypothesisId}`, {
    method: 'PATCH',
    body: JSON.stringify({ verdict }),
  });
}

export async function generateEngChain(verticalId: string, language?: string): Promise<HeJobResponse> {
  return clientApiFetch<HeJobResponse>(`/eng/verticals/${verticalId}/chain`, {
    method: 'POST',
    body: JSON.stringify(language ? { language } : {}),
  });
}

export async function collectEngBase(
  verticalId: string,
  body: { limit: number; hypothesis_ids?: string[] },
): Promise<HeBaseCollectResponse> {
  return clientApiFetch<HeBaseCollectResponse>(`/eng/verticals/${verticalId}/collect`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function patchEngChain(
  chainId: string,
  letters: HeChainLetterDto[],
): Promise<EngChainPatchResponse> {
  return clientApiFetch<EngChainPatchResponse>(`/eng/chains/${chainId}`, {
    method: 'PATCH',
    body: JSON.stringify({ letters }),
  });
}

export async function buildEngTemplate(baseId: string): Promise<HeJobResponse> {
  return clientApiFetch<HeJobResponse>(`/eng/bases/${baseId}/template`, { method: 'POST' });
}

export async function fetchEngLaunchPresets(templateId: string): Promise<HeLaunchPresetOption[]> {
  const data = await clientApiFetch<EngPresetsResponse>(`/eng/templates/${templateId}/launch`);
  return data.presets ?? [];
}

export async function launchEngTemplate(
  templateId: string,
  body: { preset_id: string; force?: boolean },
): Promise<EngLaunchResponse> {
  return clientApiFetch<EngLaunchResponse>(`/eng/templates/${templateId}/launch`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

/* ── ENG Command Center (GET /eng/dashboard) ── */

/** Этап вертикали на дашборде (порядок конвейера research → … → launched). */
export type EngDashStage =
  | 'research'
  | 'letters'
  | 'collecting'
  | 'construct'
  | 'analyzing'
  | 'analyzed'
  | 'template'
  | 'launched';

export interface EngDashboardVertical {
  id: string;
  project_id: string;
  name: string;
  stage: EngDashStage;
  /** Короткая живой строки этапа ('constructor: 87/147 valid'). */
  stageDetail: string;
  /** Пять точек прогресса: research → letters → base → template → launched. */
  dots: boolean[];
  stats: {
    companies: number;
    emails_found: number;
    valid_count: number;
    appended_today: number;
    leads_launched: number;
  };
  launch: { campaign_url: string; campaign_name: string } | null;
}

export interface EngDashboardEvent {
  type:
    | 'letters_ready'
    | 'base_collected'
    | 'base_analyzed'
    | 'template_ready'
    | 'launched'
    | 'refill_appended'
    | 'refill_empty'
    | 'failed';
  text: string;
  at: string;
}

export interface EngDashboardActiveJob {
  id: string;
  project_id: string;
  stage: string;
  status: string;
  vertical_id: string | null;
  progress: { done?: number; total?: number; label?: string } | null;
}

export interface EngDashboardResponse {
  projects?: Array<{ id: string; name: string; status: string }>;
  verticals?: EngDashboardVertical[];
  today?: { appended: number; valid: number; collected: number };
  autoRefill?: { enabled: boolean; next_run_at: string; daily_cap: number };
  events?: EngDashboardEvent[];
  activeJobs?: EngDashboardActiveJob[];
  error?: string;
}

export async function fetchEngDashboard(): Promise<EngDashboardResponse> {
  return clientApiFetch<EngDashboardResponse>('/eng/dashboard');
}
