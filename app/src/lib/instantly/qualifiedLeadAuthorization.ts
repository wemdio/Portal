import type { SupabaseClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { supabaseAdmin as supabaseMain } from '@/lib/supabaseAdmin';
import { supabaseInstantly } from '@/lib/supabaseInstantly';
import { resolveCampaignProjectOwners } from './campaignProjectOwnerResolver';
import { isUnownedGeneratedQualificationRetry } from './qualificationRecovery';

const SUPERVISOR_ROLES = new Set(['admin', 'director', 'lead', 'manager']);
export const QUALIFICATION_ACTION_GUARD_COLUMNS =
  'status, ai_reason, ai_confidence, qualified_project_id, qualified_project_owner_proven, machine_reply_kind, queue_archived_at';

export interface CampaignAccess {
  campaignIds: string[];
  rejectedExplicitCampaign: boolean;
  ambiguousCampaignIds: string[];
  projectIdsByCampaign: Map<string, string>;
}

export interface QualifiedLeadAccessFailure {
  ok: false;
  status: number;
  error: string;
}

export interface QualifiedLeadAccessSuccess<T extends Record<string, unknown>> {
  ok: true;
  qualification: T;
  campaignId: string;
  projectId: string | null;
  isSupervisor: boolean;
}

export type QualifiedLeadAccessResult<T extends Record<string, unknown>> =
  | QualifiedLeadAccessSuccess<T>
  | QualifiedLeadAccessFailure;

interface UserProjectAccess {
  visibleProjectIds: Set<string>;
  isSupervisor: boolean;
}

export interface QualificationReadScope {
  visibleProjectIds: string[];
  campaignAccess: CampaignAccess;
}

export interface QualificationRowsAccessSuccess {
  ok: true;
  visibleProjectIds: string[];
  legacyCampaignIds: string[];
  legacyProjectIdsByCampaign: Map<string, string>;
  isSupervisor: boolean;
}

export type QualificationRowsAccessResult =
  | QualificationRowsAccessSuccess
  | QualifiedLeadAccessFailure;

function configuredDatabases(): {
  instantlyDb: SupabaseClient;
  mainDb: SupabaseClient;
} {
  if (!supabaseInstantly || !supabaseMain) {
    throw new Error('Server misconfigured');
  }
  return { instantlyDb: supabaseInstantly, mainDb: supabaseMain };
}

async function resolveUserProjectAccess(userId: string): Promise<UserProjectAccess> {
  const { mainDb } = configuredDatabases();
  const { data: profile, error: profileError } = await mainDb
    .from('profiles')
    .select('role')
    .eq('id', userId)
    .single();
  if (profileError || !profile) {
    throw new Error(
      `Unable to resolve user role: ${profileError?.message ?? 'profile not found'}`,
    );
  }

  const isSupervisor = SUPERVISOR_ROLES.has(
    (profile.role as string | null) ?? 'technician',
  );
  let projectsQuery = mainDb.from('projects').select('id');
  if (!isSupervisor) {
    projectsQuery = projectsQuery.eq('specialist_user_id', userId);
  }
  const { data: projects, error: projectsError } = await projectsQuery;
  if (projectsError) {
    throw new Error(`Unable to resolve visible projects: ${projectsError.message}`);
  }

  return {
    isSupervisor,
    visibleProjectIds: new Set(
      (projects ?? [])
        .map((project: { id?: string | null }) => project.id)
        .filter((projectId): projectId is string => Boolean(projectId)),
    ),
  };
}

async function resolveCampaignAccessForVisibleProjects(
  instantlyDb: SupabaseClient,
  visibleProjectIds: Set<string>,
  requestedCampaignIds: string[],
): Promise<CampaignAccess> {
  const explicitCampaignIds = [...new Set(requestedCampaignIds.filter(Boolean))];
  let candidateCampaignIds = explicitCampaignIds;
  if (candidateCampaignIds.length === 0 && visibleProjectIds.size > 0) {
    const projectIds = [...visibleProjectIds];
    const [legacy, period] = await Promise.all([
      instantlyDb
        .from('project_instantly_campaigns')
        .select('campaign_id')
        .in('project_id', projectIds),
      instantlyDb
        .from('project_period_instantly_campaigns')
        .select('campaign_id')
        .in('project_id', projectIds),
    ]);
    if (legacy.error) {
      throw new Error(`project_instantly_campaigns lookup failed: ${legacy.error.message}`);
    }
    if (period.error) {
      throw new Error(
        `project_period_instantly_campaigns lookup failed: ${period.error.message}`,
      );
    }
    candidateCampaignIds = [...new Set(
      [...(legacy.data ?? []), ...(period.data ?? [])]
        .map((link: { campaign_id?: string | null }) => link.campaign_id)
        .filter((campaignId): campaignId is string => Boolean(campaignId)),
    )];
  }

  const owners = await resolveCampaignProjectOwners(instantlyDb, candidateCampaignIds);
  const ambiguousCampaignIds = candidateCampaignIds.filter(
    (campaignId) => owners.get(campaignId)?.status === 'ambiguous',
  );
  const campaignIds = candidateCampaignIds.filter((campaignId) => {
    const owner = owners.get(campaignId);
    return owner?.status === 'resolved' && visibleProjectIds.has(owner.projectId);
  });
  const projectIdsByCampaign = new Map<string, string>();
  for (const campaignId of candidateCampaignIds) {
    const owner = owners.get(campaignId);
    if (owner?.status === 'resolved') {
      projectIdsByCampaign.set(campaignId, owner.projectId);
    }
  }

  return {
    campaignIds,
    rejectedExplicitCampaign:
      explicitCampaignIds.length > 0 && campaignIds.length !== explicitCampaignIds.length,
    ambiguousCampaignIds,
    projectIdsByCampaign,
  };
}

/**
 * Resolve campaigns visible to the caller through one unambiguous project
 * owner. Both ownership-table reads are mandatory for legacy qualifications.
 */
export async function resolveCampaignAccess(
  userId: string,
  requestedCampaignIds: string[],
): Promise<CampaignAccess> {
  const { instantlyDb } = configuredDatabases();
  const { visibleProjectIds } = await resolveUserProjectAccess(userId);
  return resolveCampaignAccessForVisibleProjects(
    instantlyDb,
    visibleProjectIds,
    requestedCampaignIds,
  );
}

export async function resolveQualificationReadScope(
  userId: string,
  requestedCampaignIds: string[],
): Promise<QualificationReadScope> {
  const { instantlyDb } = configuredDatabases();
  const { visibleProjectIds } = await resolveUserProjectAccess(userId);
  const campaignAccess = await resolveCampaignAccessForVisibleProjects(
    instantlyDb,
    visibleProjectIds,
    requestedCampaignIds,
  );
  return { visibleProjectIds: [...visibleProjectIds], campaignAccess };
}

export async function authorizeQualificationRowsForUser(
  userId: string,
  qualifications: Array<Record<string, unknown>>,
): Promise<QualificationRowsAccessResult> {
  const { instantlyDb } = configuredDatabases();
  const { visibleProjectIds, isSupervisor } = await resolveUserProjectAccess(userId);
  const legacyCampaignIds = new Set<string>();
  const legacyProjectIdsByCampaign = new Map<string, string>();

  for (const qualification of qualifications) {
    if (qualification.queue_archived_at != null) {
      return { ok: false, status: 409, error: 'Ответ снят с обработки и сохранён в архиве; действия недоступны' };
    }
    // A technical disposition deliberately has no owner. Its provider
    // campaign is provenance, never permission to use live campaign access.
    if (qualification.machine_reply_kind != null) {
      return { ok: false, status: 403, error: 'Владелец технического ответа не определён' };
    }
    if (isUnownedGeneratedQualificationRetry(qualification)) {
      // Deny before external work can start. This is the mutable cohort that
      // recovery may atomically turn into an ownerless machine disposition.
      return { ok: false, status: 409, error: 'Владелец ответа ещё проверяется; действия временно недоступны' };
    }
    const campaignId = typeof qualification.campaign_id === 'string'
      ? qualification.campaign_id.trim()
      : '';
    if (!campaignId) {
      return {
        ok: false,
        status: 409,
        error: 'У квалификации не указана кампания',
      };
    }
    const projectId = typeof qualification.qualified_project_id === 'string'
      ? qualification.qualified_project_id.trim()
      : '';
    const provenFieldPresent = Object.prototype.hasOwnProperty.call(
      qualification,
      'qualified_project_owner_proven',
    );
    const ownerProven = qualification.qualified_project_owner_proven === true;
    if (projectId) {
      if (provenFieldPresent && !ownerProven) {
        return {
          ok: false,
          status: 409,
          error: 'Владелец квалификации не подтверждён',
        };
      }
      if (!visibleProjectIds.has(projectId)) {
        return { ok: false, status: 403, error: 'Доступ к лиду запрещён' };
      }
    } else if (ownerProven) {
      // Proven + NULL is a valid self-serve qualification. It has no managed
      // Portal project and must never fall through to a later live owner.
      return { ok: false, status: 403, error: 'Проект квалификации не найден' };
    } else {
      legacyCampaignIds.add(campaignId);
    }
  }

  if (legacyCampaignIds.size > 0) {
    const campaignAccess = await resolveCampaignAccessForVisibleProjects(
      instantlyDb,
      visibleProjectIds,
      [...legacyCampaignIds],
    );
    if (campaignAccess.ambiguousCampaignIds.length > 0) {
      return {
        ok: false,
        status: 409,
        error: 'Не удалось однозначно определить проект кампании',
      };
    }
    if (campaignAccess.rejectedExplicitCampaign) {
      return { ok: false, status: 403, error: 'Доступ к кампании запрещён' };
    }
    for (const campaignId of legacyCampaignIds) {
      const projectId = campaignAccess.projectIdsByCampaign.get(campaignId);
      if (projectId) legacyProjectIdsByCampaign.set(campaignId, projectId);
    }
  }

  return {
    ok: true,
    visibleProjectIds: [...visibleProjectIds],
    legacyCampaignIds: [...legacyCampaignIds],
    legacyProjectIdsByCampaign,
    isSupervisor,
  };
}

function isMissingSnapshotColumnError(error: { code?: string; message?: string }): boolean {
  return (
    error.code === '42703' ||
    /qualified_project_(?:id|owner_proven).*does not exist/i.test(
      error.message ?? '',
    )
  );
}

function isSnapshotSchemaCacheError(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST204' || /schema cache/i.test(error.message ?? '');
}

export async function qualificationProjectSnapshotSupported(): Promise<boolean> {
  const { instantlyDb } = configuredDatabases();
  const { error } = await instantlyDb
    .from('instantly_lead_qualifications')
    .select('qualified_project_id, qualified_project_owner_proven, machine_reply_kind')
    .limit(1);
  if (!error) return true;
  // A stale cache is not proof that the migration is absent. Falling back to
  // live ownership here could expose an already-snapshotted historical lead
  // to the campaign's new project until PostgREST reloads its schema.
  if (isSnapshotSchemaCacheError(error)) {
    throw new Error(`Qualification owner snapshot schema cache is stale: ${error.message}`);
  }
  // Do not reinterpret a missing/stale marker as legacy data. This explicit
  // probe also protects select('*') in single-row actions and mark-as-read.
  if (/machine_reply_kind/i.test(error.message ?? '')) {
    throw new Error(`Qualification machine marker unavailable: ${error.message}`);
  }
  if (isMissingSnapshotColumnError(error)) return false;
  throw new Error(`Unable to probe qualification owner snapshot: ${error.message}`);
}

export async function authorizeCampaignForUser(
  userId: string,
  campaignId: string,
): Promise<{ ok: true } | QualifiedLeadAccessFailure> {
  const access = await resolveCampaignAccess(userId, [campaignId]);
  if (access.ambiguousCampaignIds.length > 0) {
    return {
      ok: false,
      status: 409,
      error: 'Не удалось однозначно определить проект кампании',
    };
  }
  if (access.rejectedExplicitCampaign) {
    return { ok: false, status: 403, error: 'Доступ к кампании запрещён' };
  }
  return { ok: true };
}

/**
 * Load the complete action payload with explicit authorization fields. A
 * missing/stale guard column fails closed, never becomes a legacy permission.
 * Finalized legacy/null rows still use the mandatory two-table campaign resolver.
 */
export async function loadAuthorizedQualification<
  T extends Record<string, unknown> = Record<string, unknown>,
>(userId: string, qualificationId: string): Promise<QualifiedLeadAccessResult<T>> {
  const { instantlyDb } = configuredDatabases();
  // `select('*')` can silently omit newly added fields while PostgREST has a
  // stale schema cache. Probe explicitly before interpreting an absent field
  // as a pre-migration legacy qualification.
  await qualificationProjectSnapshotSupported();
  const { data, error } = await instantlyDb
    .from('instantly_lead_qualifications')
    .select(`*, ${QUALIFICATION_ACTION_GUARD_COLUMNS}`)
    .eq('id', qualificationId)
    .single();
  if (error || !data) {
    if (!data && (!error || error.code === 'PGRST116')) {
      return { ok: false, status: 404, error: 'Квалификация не найдена' };
    }
    throw new Error(`Unable to load qualification: ${error?.message ?? 'not found'}`);
  }

  const qualification = data as T;
  const campaignId = typeof qualification.campaign_id === 'string'
    ? qualification.campaign_id.trim()
    : '';
  const snapshottedProjectId = typeof qualification.qualified_project_id === 'string'
    ? qualification.qualified_project_id.trim()
    : '';

  const access = await authorizeQualificationRowsForUser(userId, [qualification]);
  if (!access.ok) return access;
  return {
    ok: true,
    qualification,
    campaignId,
    projectId:
      snapshottedProjectId || access.legacyProjectIdsByCampaign.get(campaignId) || null,
    isSupervisor: access.isSupervisor,
  };
}

export function qualifiedLeadAccessErrorResponse(
  failure: QualifiedLeadAccessFailure,
) {
  return NextResponse.json({ error: failure.error }, { status: failure.status });
}
