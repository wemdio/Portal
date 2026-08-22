import type { SupabaseClient } from '@supabase/supabase-js';

import type {
  VeLegacyProjectDetail,
  VeLegacyProjectLink,
  VeLegacyProjectSummary,
} from './types.legacy';

const LINK_COLUMNS =
  'legacy_he_project_id, verified_by, verified_at, review_notes, backfill_batch_id, created_at';
const PROJECT_SUMMARY_COLUMNS =
  'id, created_by, name, website_url, status, created_at, updated_at';
const PROJECT_DETAIL_COLUMNS =
  'id, created_by, name, website_url, brief, status, error, llm_model, tokens_used, cost_usd, market, autopilot, created_at, updated_at';
const BASE_COLUMNS =
  'id, project_id, vertical_id, filename, row_count, columns, sample_rows, status, analysis, error, source, collect_info, created_at, updated_at';
const JOB_COLUMNS =
  'id, project_id, stage, status, error, attempts, started_at, finished_at, progress, payload, created_at, updated_at';
const DOSSIER_COLUMNS =
  'id, vertical_id, project_id, status, data, error, llm_model, tokens_used, cost_usd, created_at, updated_at';
const CASE_COLUMNS =
  'id, project_id, source, filename, industry, client_type, task, metrics, result, created_at, updated_at';

export type LegacyArchiveListResult =
  | { ok: true; projects: VeLegacyProjectSummary[] }
  | { ok: false; message: string };

export type LegacyArchiveDetailResult =
  | { ok: true; detail: VeLegacyProjectDetail }
  | { ok: false; reason: 'not_found' | 'db'; message?: string };

function verification(link: VeLegacyProjectLink): VeLegacyProjectSummary['verification'] {
  return {
    verified_by: link.verified_by,
    verified_at: link.verified_at,
    review_notes: link.review_notes,
    backfill_batch_id: link.backfill_batch_id,
  };
}

function stripLegacyBase(base: Record<string, unknown>): Record<string, unknown> {
  // The production projection excludes data; the explicit removal also keeps
  // test doubles and future projection changes from leaking the heavy row blob.
  const { data: _data, ...withoutData } = base;
  const info = withoutData.collect_info as { tasks?: unknown } | null | undefined;
  if (!info || !Array.isArray(info.tasks)) return withoutData;

  return {
    ...withoutData,
    collect_info: {
      ...info,
      tasks: info.tasks.map((task) => {
        if (task === null || typeof task !== 'object' || !('harvest' in task)) return task;
        const clean = { ...(task as Record<string, unknown>) };
        delete clean.harvest;
        return clean;
      }),
    },
  };
}

export async function listLegacyArchiveProjects(
  supabase: SupabaseClient,
): Promise<LegacyArchiveListResult> {
  const { data: linkRows, error: linksError } = await supabase
    .from('ve_legacy_project_links')
    .select(LINK_COLUMNS)
    .order('verified_at', { ascending: false });
  if (linksError) return { ok: false, message: linksError.message };

  const links = (linkRows ?? []) as VeLegacyProjectLink[];
  if (links.length === 0) return { ok: true, projects: [] };

  const ids = links.map((link) => link.legacy_he_project_id);
  const { data: projectRows, error: projectsError } = await supabase
    .from('he_projects')
    .select(PROJECT_SUMMARY_COLUMNS)
    .in('id', ids);
  if (projectsError) return { ok: false, message: projectsError.message };

  const byId = new Map(
    ((projectRows ?? []) as Array<Record<string, unknown>>).map((project) => [
      String(project.id),
      project,
    ]),
  );

  const projects = links.flatMap((link): VeLegacyProjectSummary[] => {
    const project = byId.get(link.legacy_he_project_id);
    if (!project) return [];
    return [
      {
        id: String(project.id),
        created_by: typeof project.created_by === 'string' ? project.created_by : null,
        name: String(project.name ?? ''),
        website_url: String(project.website_url ?? ''),
        status: String(project.status ?? ''),
        created_at: typeof project.created_at === 'string' ? project.created_at : null,
        updated_at: typeof project.updated_at === 'string' ? project.updated_at : null,
        origin: 'legacy',
        read_only: true,
        verification: verification(link),
      },
    ];
  });

  return { ok: true, projects };
}

export async function loadLegacyArchiveProject(
  supabase: SupabaseClient,
  projectId: string,
): Promise<LegacyArchiveDetailResult> {
  const { data: linkRow, error: linkError } = await supabase
    .from('ve_legacy_project_links')
    .select(LINK_COLUMNS)
    .eq('legacy_he_project_id', projectId)
    .maybeSingle();
  if (linkError) return { ok: false, reason: 'db', message: linkError.message };
  if (!linkRow) return { ok: false, reason: 'not_found' };
  const link = linkRow as VeLegacyProjectLink;

  const { data: project, error: projectError } = await supabase
    .from('he_projects')
    .select(PROJECT_DETAIL_COLUMNS)
    .eq('id', projectId)
    .maybeSingle();
  if (projectError) return { ok: false, reason: 'db', message: projectError.message };
  if (!project) return { ok: false, reason: 'not_found' };

  const [hypotheses, verticals, bases, jobs, dossiers, cases] = await Promise.all([
    supabase
      .from('he_hypotheses')
      .select('*')
      .eq('project_id', projectId)
      .order('tier', { ascending: true }),
    supabase
      .from('he_verticals')
      .select('*')
      .eq('project_id', projectId)
      .order('rank', { ascending: true }),
    supabase
      .from('he_bases')
      .select(BASE_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    supabase
      .from('he_jobs')
      .select(JOB_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('he_vertical_dossiers')
      .select(DOSSIER_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
    supabase
      .from('he_cases')
      .select(CASE_COLUMNS)
      .eq('project_id', projectId)
      .order('created_at', { ascending: false }),
  ]);

  for (const response of [hypotheses, verticals, bases, jobs, dossiers, cases]) {
    if (response.error) {
      return { ok: false, reason: 'db', message: response.error.message };
    }
  }

  const verticalRows = (verticals.data ?? []) as Array<Record<string, unknown>>;
  const verticalIds = verticalRows
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string');

  let chains: Array<Record<string, unknown>> = [];
  let vocabs: Array<Record<string, unknown>> = [];
  let templates: Array<Record<string, unknown>> = [];
  if (verticalIds.length > 0) {
    const [chainResponse, vocabResponse, templateResponse] = await Promise.all([
      supabase
        .from('he_chains')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('he_vocab')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
      supabase
        .from('he_templates')
        .select('*')
        .in('vertical_id', verticalIds)
        .order('created_at', { ascending: false }),
    ]);
    for (const response of [chainResponse, vocabResponse, templateResponse]) {
      if (response.error) {
        return { ok: false, reason: 'db', message: response.error.message };
      }
    }
    chains = (chainResponse.data ?? []) as Array<Record<string, unknown>>;
    vocabs = (vocabResponse.data ?? []) as Array<Record<string, unknown>>;
    templates = (templateResponse.data ?? []) as Array<Record<string, unknown>>;
  }

  return {
    ok: true,
    detail: {
      origin: 'legacy',
      read_only: true,
      verification: verification(link),
      project: project as Record<string, unknown>,
      hypotheses: (hypotheses.data ?? []) as Array<Record<string, unknown>>,
      verticals: verticalRows,
      chains,
      vocabs,
      bases: ((bases.data ?? []) as Array<Record<string, unknown>>).map(stripLegacyBase),
      templates,
      jobs: (jobs.data ?? []) as Array<Record<string, unknown>>,
      dossiers: (dossiers.data ?? []) as Array<Record<string, unknown>>,
      cases: (cases.data ?? []) as Array<Record<string, unknown>>,
    },
  };
}
